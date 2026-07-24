import { DmeLinkError } from './types';

/**
 * Thin wrapper isolating all navigator.serial calls, mirroring the reference app's IByteTransport
 * contract (open/write/read/close over a single serial port).
 *
 * Received bytes are drained by a single background pump into an internal buffer, and readExact()
 * consumes from that buffer. This is deliberate: the Web Serial reader delivers bytes in arbitrary
 * chunk boundaries, so a DS2 echo and the start of its response frequently arrive in the *same*
 * chunk. A naive "read one chunk per readExact" approach drops the surplus and desynchronizes the
 * stream — which is exactly what broke bulk (269-chunk) partial-BIN reads. Buffering never drops a
 * byte, keeping echo/response framing aligned across thousands of exchanges.
 */
export class WebSerialTransport {
    private port: SerialPort | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private buffer: number[] = [];
    private pumpActive = false;
    private pumpError: Error | null = null;

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
        await this.port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even' });
        this.writer = this.port.writable!.getWriter();
        this.reader = this.port.readable!.getReader();
        this.buffer = [];
        this.pumpError = null;
        this.pumpActive = true;
        this.startPump();
    }

    private startPump(): void {
        const reader = this.reader!;
        (async () => {
            try {
                while (this.pumpActive) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) {
                        for (let i = 0; i < value.length; i++) this.buffer.push(value[i]);
                    }
                }
            } catch (e: unknown) {
                this.pumpError = e instanceof Error ? e : new Error(String(e));
            }
        })();
    }

    async close(): Promise<void> {
        this.pumpActive = false;
        try { await this.reader?.cancel(); } catch { }
        try { this.reader?.releaseLock(); } catch { }
        try { this.writer?.releaseLock(); } catch { }
        try { await this.port?.close(); } catch { }
        this.reader = null;
        this.writer = null;
        this.port = null;
        this.buffer = [];
    }

    /**
     * Reconfigures the serial port to a new baud rate. The Web Serial API has no way to change baud
     * on an open port, so this closes and reopens the SAME port object at the new rate and restarts
     * the read pump. Used for DS2 baud-rate boosting (9600 ⇄ 125000) mid-session.
     */
    async reopen(baudRate: number): Promise<void> {
        if (!this.port) throw new DmeLinkError('Serial port is not open');
        const port = this.port;
        this.pumpActive = false;
        try { await this.reader?.cancel(); } catch { }
        try { this.reader?.releaseLock(); } catch { }
        try { this.writer?.releaseLock(); } catch { }
        await port.close();
        await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'even' });
        this.writer = port.writable!.getWriter();
        this.reader = port.readable!.getReader();
        this.buffer = [];
        this.pumpError = null;
        this.pumpActive = true;
        this.startPump();
    }

    async write(bytes: Uint8Array): Promise<void> {
        if (!this.writer) throw new DmeLinkError('Serial port is not open');
        await this.writer.write(bytes);
    }

    /** Discards any buffered received bytes — used to resynchronize after a timeout before retrying. */
    purge(): void {
        this.buffer = [];
    }

    /** How many received bytes are waiting to be consumed. Lets a caller tell whether the line has
     *  gone quiet (buffer stays empty across a pause) before starting a fresh exchange, rather than
     *  purging into a stream that is still arriving. */
    bufferedLength(): number {
        return this.buffer.length;
    }

    /** True if the background read pump has latched an error — most often a serial break. Lets a
     *  caller recover deliberately instead of discovering it as a failed readExact mid-exchange. */
    hasReadError(): boolean {
        return this.pumpError !== null;
    }

    /**
     * The latched pump error, WITHOUT clearing it, so a caller can name the cause in its own message.
     *
     * Deliberately non-consuming: clearing the latch here would make hasReadError() report false, and
     * resyncTransport() would then purge() instead of recoverRead() — leaving the dead pump unrestarted,
     * which is strictly worse than not looking at all. Only recoverRead()/open()/reopen() clear it.
     */
    peekReadError(): Error | null {
        return this.pumpError;
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
        this.buffer = [];
        this.pumpError = null;
        this.pumpActive = true;
        this.startPump();
    }

    /**
     * Reads exactly `length` bytes, waiting up to `timeoutMs`. Surplus bytes received alongside are
     * retained in the buffer for the next call — never dropped.
     */
    async readExact(length: number, timeoutMs: number): Promise<Uint8Array> {
        const deadline = Date.now() + timeoutMs;
        while (this.buffer.length < length) {
            // Name the error class too: a BreakError/FramingError (recoverable, and the signature of a
            // disturbed K-line) and a NetworkError (device gone) otherwise read identically.
            if (this.pumpError) {
                throw new DmeLinkError(`Serial read failed: ${this.pumpError.name} (${this.pumpError.message})`);
            }
            if (Date.now() >= deadline) {
                throw new DmeLinkError(`Timed out waiting for ${length} byte(s) (received ${this.buffer.length})`);
            }
            await new Promise(r => setTimeout(r, 2));
        }
        return Uint8Array.from(this.buffer.splice(0, length));
    }
}
