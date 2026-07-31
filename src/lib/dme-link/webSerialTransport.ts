import { DmeLinkError } from './types';
import { BufferedByteTransport } from './bufferedByteTransport';
import type { ByteTransport } from './byteTransport';

/**
 * Thin wrapper isolating all navigator.serial calls — the desktop backend, and the one proven on a
 * real vehicle.
 *
 * The buffering half (the receive buffer, the parked waiter, readExact) lives in
 * BufferedByteTransport, shared with the WebUSB backend. What stays here is everything that touches
 * a SerialPort. The reason the buffering exists at all is unchanged: the Web Serial reader delivers
 * bytes in arbitrary chunk boundaries, so a DS2 echo and the start of its response frequently arrive
 * in the *same* chunk. A naive "read one chunk per readExact" approach drops the surplus and
 * desynchronizes the stream — which is exactly what broke bulk (269-chunk) partial-BIN reads.
 */
/**
 * Receive buffer requested from the Web Serial implementation. We were passing no bufferSize at all,
 * which meant the spec default of 255 bytes.
 *
 * **This is NOT the OS or FTDI driver receive buffer**, and an earlier version of this comment said
 * it was, by analogy with the reference app's FT_SetUSBParameters(4096, 4096). Chromium's
 * `serial_port.cc` passes `bufferSize` straight to `mojo::CreateDataPipe` as `capacity_num_bytes` —
 * it is the ring buffer between the browser process and the renderer, nothing more. On Windows,
 * `serial_io_handler_win.cc` contains no `SetupComm()` call at all, so the driver's buffers stay at
 * their Device Manager defaults no matter what we pass here. Raising it cannot add bandwidth.
 *
 * What it does buy is room to fall behind: at 255 bytes, reads have been reported to stall outright
 * on some devices (WICG/serial#164), and the smaller the ring the more often the next hazard bites.
 *
 * That hazard is worth stating because it may be one of ours: WICG/serial#123 reports that Chromium
 * uses this buffer as a circular queue and **splits a write that straddles the boundary into two**.
 * Our DS2 request frames are 9 bytes. A split write puts a gap mid-frame on a half-duplex K-line,
 * which comes back as an echo mismatch — and classifyEchoMismatch would most likely score that
 * 'unclassified'. That makes it a live candidate for the intermittent echo faults in the notes, and
 * the transfer timer's `write` median is the measurement that tests it: it should be ~0.
 *
 * Note that the WebUSB backend has no equivalent: there, nothing drains the chip's FIFO except our
 * own read loop, on the renderer thread. See webUsbFtdiTransport.ts.
 */
const RX_BUFFER_BYTES = 4096;

export class WebSerialTransport extends BufferedByteTransport implements ByteTransport {
    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

    /**
     * Whether this browser exposes Web Serial at all.
     *
     * Note what this deliberately does NOT answer: whether the ports it enumerates include USB
     * serial adapters. Chrome for Android 138+ returns true here and then offers only Bluetooth
     * RFCOMM ports, so a K+DCAN cable is unreachable despite this being true. That distinction is
     * made in byteTransport.ts, which is the only caller that needs it.
     */
    static isSupported(): boolean {
        return typeof navigator !== 'undefined' && 'serial' in navigator;
    }

    async open(): Promise<void> {
        if (!WebSerialTransport.isSupported()) {
            throw new DmeLinkError('Web Serial API is not available in this browser (Chrome/Edge desktop required).');
        }
        // Must be called from within a real user gesture (e.g. a button click handler).
        this.port = await navigator.serial!.requestPort();
        // 8E1 is mandatory — do not "simplify" this to 8N1 while chasing line errors. DS2/MSS54 is
        // even-parity; an 8N1 receiver samples the parity bit where the stop bit should be, so every
        // even-popcount byte raises a framing error. DS2's own address 0x12 and ACK 0xA0 both have
        // popcount 2, so effectively every frame would fault on its first byte. 8E1 is proven on the car.
        await this.port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even', bufferSize: RX_BUFFER_BYTES });
        await this.deassertControlLines();
        this.writer = this.port.writable!.getWriter();
        this.reader = this.port.readable!.getReader();
        this.clearBuffer();
        this.pumpError = null;
        this.pumpActive = true;
        this.startPump();
    }

    /**
     * Puts DTR and RTS in a known, de-asserted state — matching the reference tool, which does exactly
     * this on its COM-port transport (`DtrEnable = false; RtsEnable = false`). We had never touched
     * them, so they sat at whatever Chromium's open() leaves behind.
     *
     * It matters here more than it does there, because of something only this app has to do: Web
     * Serial cannot change baud on an open port, so a DS2 baud switch means close() + open(). The
     * reference just assigns `SerialPort.BaudRate` / calls `FT_SetBaudRate` on the still-open handle
     * and never disturbs the line. Our close/open cycle moves whatever these two lines were doing —
     * and on some K+DCAN cables they gate the K-line transceiver. Making the state explicit and
     * identical on both sides of the reopen removes that variable.
     *
     * (The WebUSB backend does not inherit this problem: it changes baud in place, so the lines are
     * set once at open and never disturbed again.)
     *
     * Best-effort: a cable that does not implement the request must not fail the connection.
     */
    private async deassertControlLines(): Promise<void> {
        try {
            await this.port?.setSignals({ dataTerminalReady: false, requestToSend: false });
        } catch { /* not all platforms/cables support it; the link works without it today */ }
    }

    private startPump(): void {
        const reader = this.reader!;
        (async () => {
            try {
                while (this.pumpActive) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value && value.length > 0) this.receive(value);
                }
            } catch (e: unknown) {
                this.latch(e instanceof Error ? e : new Error(String(e)));
            }
        })();
    }

    async close(): Promise<void> {
        this.pumpActive = false;
        this.releaseWaiter();
        try { await this.reader?.cancel(); } catch { }
        try { this.reader?.releaseLock(); } catch { }
        try { this.writer?.releaseLock(); } catch { }
        try { await this.port?.close(); } catch { }
        this.reader = null;
        this.writer = null;
        this.port = null;
        this.clearBuffer();
    }

    /**
     * Reconfigures the serial port to a new baud rate. The Web Serial API has no way to change baud
     * on an open port, so this closes and reopens the SAME port object at the new rate and restarts
     * the read pump. Used for DS2 baud-rate boosting (9600 ⇄ a faster rate) mid-session.
     */
    async reopen(baudRate: number): Promise<void> {
        if (!this.port) throw new DmeLinkError('Serial port is not open');
        const port = this.port;
        this.pumpActive = false;
        this.releaseWaiter();
        try { await this.reader?.cancel(); } catch { }
        try { this.reader?.releaseLock(); } catch { }
        try { this.writer?.releaseLock(); } catch { }
        await port.close();
        await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'even', bufferSize: RX_BUFFER_BYTES });
        // Same state as open() left, so crossing this reopen does not move the control lines.
        await this.deassertControlLines();
        this.writer = port.writable!.getWriter();
        this.reader = port.readable!.getReader();
        this.clearBuffer();
        this.pumpError = null;
        this.pumpActive = true;
        this.startPump();
    }

    async write(bytes: Uint8Array): Promise<void> {
        if (!this.writer) throw new DmeLinkError('Serial port is not open');
        // Timed because it should be ~0 and a non-zero median would be a finding: WICG/serial#123
        // reports that Chromium treats the pipe as a ring and SPLITS a write straddling the boundary.
        // A split 9-byte request frame puts a gap mid-frame on the K-line, which surfaces as an echo
        // mismatch — a live candidate for the intermittent echo faults in the notes.
        this.timing?.writeStart(performance.now());
        await this.writer.write(bytes);
        this.timing?.writeEnd(performance.now());
    }

    /**
     * Restarts the read side after an error latched the pump, without closing the port.
     *
     * A serial break — the K-line held low by a DME reset or a transient fault — rejects the pump's
     * read() and sets pumpError, after which every readExact throws "Serial read failed" until the
     * port is reopened. That is why one break used to kill all further communication until a full
     * reconnect. Cancelling the dead reader, re-acquiring one, and restarting the pump clears the
     * latch in place, so a retry (or the user pressing 再試行) can proceed.
     */
    async recoverRead(): Promise<void> {
        if (!this.port) throw new DmeLinkError('Serial port is not open');
        this.pumpActive = false;
        this.releaseWaiter();
        try { await this.reader?.cancel(); } catch { }
        try { this.reader?.releaseLock(); } catch { }
        await new Promise(r => setTimeout(r, 100)); // let the break / idle condition settle
        // A break is recoverable; the device physically vanishing is not. Chromium leaves readable
        // null after a fatal NetworkError, and a bare `!` here would surface that as an opaque
        // TypeError — retried up to nine times by drainUntilQuiet — instead of naming the real cause.
        if (!this.port.readable) {
            throw new DmeLinkError('The serial device disconnected — unplug and replug the cable, then reconnect.');
        }
        this.reader = this.port.readable.getReader();
        this.clearBuffer();
        this.pumpError = null;
        this.pumpActive = true;
        this.startPump();
    }
}
