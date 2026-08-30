import { DmeLinkError } from './types';
import { BufferedByteTransport } from './bufferedByteTransport';
import type { ByteTransport } from './byteTransport';

/**
 * The FTDI vendor protocol over WebUSB — the Android backend.
 *
 * ## Why this exists at all
 *
 * §"Out of scope" in the implementation notes rejected WebUSB, and that rejection is still correct
 * *for Windows*: Chromium claims USB devices there through WinUSB, an FTDI cable is bound to
 * `ftdibus.sys`, and rebinding it with Zadig removes the COM port and breaks INPA / Tool32 / ISTA.
 * None of that exists on Android — there is no VCP driver to displace and no other BMW tool sharing
 * the cable. And it is not merely permitted there, it is the only option: Chrome for Android 138+
 * exposes `navigator.serial`, but it enumerates only Bluetooth RFCOMM serial-port emulation, so a
 * USB K+DCAN cable never appears in its picker.
 *
 * Desktop keeps Web Serial. This file is not an attempt to replace a path proven on a car.
 *
 * ## What is genuinely different here, and it is not throughput
 *
 * With Web Serial the *browser process* drains the endpoint into a 4096-byte mojo pipe on our
 * behalf. With WebUSB the only thing draining the FT232R's 256-byte RX FIFO is the read loop below,
 * running on the same thread as React. At 9600 that FIFO is ~267 ms of headroom, so a long
 * main-thread stall can overrun the chip. The saving grace is that this is *detected* rather than
 * silent: it arrives as the OE bit in a status header and latches a BufferOverrunError, which the
 * link's existing retry machinery already handles.
 *
 * This is also the whole reason the latency timer is left at the chip default of 16 ms. See
 * FTDI_LATENCY_MS.
 */

/** FTDI's USB vendor ID. The chooser filter — a CH340 cable can never reach this code. */
const FTDI_VENDOR_ID = 0x0403;

const SIO_RESET = 0x00;
const SIO_SET_MODEM_CTRL = 0x01;
const SIO_SET_FLOW_CTRL = 0x02;
const SIO_SET_BAUD_RATE = 0x03;
const SIO_SET_DATA = 0x04;
const SIO_SET_LATENCY_TIMER = 0x09;

/** `SIO_RESET` sub-commands. */
const SIO_RESET_SIO = 0;
/**
 * Flush the *receive* buffer.
 *
 * The polarity here is a known trap. libftdi ≤1.4 exposed `SIO_RESET_PURGE_RX = 1`, but libftdi 1.5
 * deprecated those functions and shipped `ftdi_tciflush()` — the *input* flush — using value 2,
 * because the old naming had RX and TX swapped. 2 is the corrected value. The bench loopback check
 * in /usb-check exercises exactly this: queue bytes, flush, confirm they are gone.
 */
const SIO_RESET_PURGE_RX = 2;

/** Port A. libftdi passes 1 here for single-channel parts; ftdi_sio passes 0. The firmware accepts
 *  both — this is stated so nobody "fixes" it in one direction and creates a difference to chase. */
const FTDI_PORT_INDEX = 1;

/**
 * 8 data bits, even parity, 1 stop bit.
 *
 * bits 0-7 data bits (8), bits 8-10 parity (0=N 1=O 2=E), bits 11-13 stop (0=1), bit 14 TX break.
 * So 8 | (2 << 8) = 0x0208.
 *
 * **8E1 is mandatory — do not "simplify" this to 8N1 while chasing line errors.** DS2/MSS54 is
 * even-parity; an 8N1 receiver samples the parity bit where the stop bit should be, so every
 * even-popcount byte raises a framing error. DS2's own address 0x12 and ACK 0xA0 both have popcount
 * 2, so effectively every frame would fault on its first byte. Same constraint, same reasoning, as
 * the Web Serial backend's `parity: 'even'`.
 */
const FTDI_DATA_8E1 = 0x0208;
/** 8E1 plus bit 14 — holds the line in a break condition. Used only by the /usb-check self-test. */
export const FTDI_DATA_8E1_TX_BREAK = FTDI_DATA_8E1 | 0x4000;

/**
 * DTR and RTS both de-asserted, in one request.
 *
 * State is bit 0 (DTR) / bit 1 (RTS); the mask enabling each is bit 8 / bit 9. Setting mask bits
 * with clear state bits gives 0x0300. This is the exact equivalent of the Web Serial backend's
 * `setSignals({ dataTerminalReady: false, requestToSend: false })`, and it has to be exactly right:
 * on some K+DCAN cables these lines gate the K-line transceiver, so an inverted polarity is a cable
 * that connects on desktop and stays silent on the phone.
 */
const FTDI_MODEM_DTR_LOW_RTS_LOW = 0x0300;

/**
 * Latency timer, in milliseconds. **16 — the chip default — and deliberately not lower.**
 *
 * The implementation notes predicted 2-4 ms as a sweet spot, but that analysis was about *tail
 * latency under Web Serial*, where the browser process absorbs the wakeups. It does not transfer to
 * this backend. Two facts decide it here:
 *
 * 1. The timer was already swept on the car and ruled out by measurement: 135 → 14 wakeups per
 *    chunk changed nothing, and 16 ms was 5.7% *slower*. It is not a throughput lever.
 * 2. The chip emits a 2-byte status packet on *every* expiry whether or not it has data, and on
 *    this backend every one of those is a `transferIn` resolution on the React main thread. 16 ms
 *    is 62.5 idle wakeups/s; 1 ms would be 1000/s. That is precisely the regression the Linux
 *    kernel reverted in ftdi_sio after eight years, and FTDI's own AN_107 says 1 ms is not
 *    recommended because it equals the USB frame length.
 *
 * 8 is the only other value worth trying. Never 1.
 */
const FTDI_LATENCY_MS = 16;

/**
 * Latency timer while a datalog is running. **4 ms, and only then.**
 *
 * The sweep above was run on the BULK READ, and its conclusion is right for that path and wrong for
 * this one. A bulk read moves 122-byte chunks: the timer's tail is a small share of a long response,
 * and lowering it only buys more idle wakeups. A datalog's exchanges are 13 to 94 bytes and there
 * are two or three of them per sample, so the tail is paid several times a second on responses short
 * enough that it dominates them. The #904 per-exchange traces show the packetisation directly —
 * 16 ms steps in the ECHO delivery as well as the response tail, on frames that take 6 ms to
 * transmit.
 *
 * The cost the constant above names is real and is what bounds this: 4 ms is 250 idle wakeups a
 * second against 62.5, each a `transferIn` resolution on the main thread. That is why this is armed
 * for the duration of a run and restored afterwards rather than becoming the default — during a run
 * almost every expiry carries data, and outside one the link is idle.
 *
 * Never 1: it equals the USB frame length, which is the case FTDI's own AN_107 advises against and
 * the Linux kernel reverted.
 */
const FTDI_LOG_LATENCY_MS = 4;

/** Line-status (16550 LSR) bits in byte 1 of every packet header. */
const LSR_OVERRUN = 0x02;
const LSR_PARITY = 0x04;
const LSR_FRAMING = 0x08;
const LSR_BREAK = 0x10;
const LSR_ANY_ERROR = LSR_OVERRUN | LSR_PARITY | LSR_FRAMING | LSR_BREAK;

/** Chip families whose baud divisors follow the 3 MHz / fractional encoding below. AM=2, BM=4, R=6.
 *  The H parts (2232H/4232H/232H) and FT-X use a 12 MHz base and a different index packing, so they
 *  are refused rather than silently mis-clocked at a device that flashes an ECU. */
const SUPPORTED_CHIP_VERSIONS = new Set([2, 4, 6]);

/**
 * Baud divisors, precomputed and audited.
 *
 * The encoding: the divisor is carried as an integer plus a 3-bit fractional code, against a 3 MHz
 * base clock. Working in eighths (24 MHz = 3 MHz x 8):
 *
 *     d8       = 24_000_000 / baud
 *     fracCode = [0,3,2,4,1,5,6,7][d8 & 7]
 *     encoded  = (d8 >> 3) | (fracCode << 14)
 *     value    = encoded & 0xFFFF,  index = encoded >>> 16
 *
 * A three-entry table rather than the general converter, because `Ds2SupportedBaud` is exactly these
 * three and ds2.ts documents at length why it will not grow. Three audited constants cannot
 * be subtly wrong; a general converter can. 0x4138 and 0xC04E match FTDI's published AN232B-05
 * table, which is the independent check that the derivation above is right. All three rates are
 * exact — zero baud error, including 125000.
 */
const FTDI_DIVISORS: Readonly<Record<number, { value: number; index: number }>> = {
    9600: { value: 0x4138, index: 0 },   // d8=2500 -> int 312, frac 4/8 -> code 1
    38400: { value: 0xC04E, index: 0 },  // d8=625  -> int 78,  frac 1/8 -> code 3
    125000: { value: 0x0018, index: 0 }, // d8=192  -> int 24,  frac 0
};

/**
 * Recomputes the table at module load.
 *
 * There is no test runner in this project, so a module-load assertion is the only mechanism that
 * can fail a wrong constant in every environment including production. ds2.ts already establishes
 * the convention. A wrong divisor is not a subtle bug here — it is a garbled write to an ECU.
 */
(function assertDivisorTable(): void {
    const FRAC_CODE = [0, 3, 2, 4, 1, 5, 6, 7];
    for (const [baudText, expected] of Object.entries(FTDI_DIVISORS)) {
        const baud = Number(baudText);
        const d8 = 24_000_000 / baud;
        if (!Number.isInteger(d8)) throw new Error(`FTDI divisor table: ${baud} is not an exact 1/8 divisor`);
        const encoded = (d8 >> 3) | (FRAC_CODE[d8 & 7] << 14);
        const value = encoded & 0xFFFF;
        const index = encoded >>> 16;
        if (value !== expected.value || index !== expected.index) {
            throw new Error(
                `FTDI divisor table wrong for ${baud}: table says ` +
                `0x${expected.value.toString(16)}/${expected.index}, computed ` +
                `0x${value.toString(16)}/${index}`);
        }
    }
    if (FTDI_DATA_8E1 !== 0x0208) throw new Error('FTDI 8E1 constant is wrong');
    if (FTDI_MODEM_DTR_LOW_RTS_LOW !== 0x0300) throw new Error('FTDI modem-control constant is wrong');
})();

/** A line fault reported through a status header. The NAME is what matters: readExact prints it and
 *  §9's triage table is written against the Web Serial spelling of these, so they must match. */
class FtdiLineError extends Error {
    constructor(name: string, message: string) {
        super(message);
        this.name = name;
    }
}

export class WebUsbFtdiTransport extends BufferedByteTransport implements ByteTransport {
    private device: USBDevice | null = null;
    private interfaceNumber = 0;
    private inEndpoint = 0;
    private outEndpoint = 0;
    private packetSize = 64;
    /** Set by the navigator.usb 'disconnect' listener. The WebUSB analogue of Chromium leaving
     *  port.readable null, and more reliable than probing device.opened. */
    private deviceGone = false;
    /** What the chip's latency timer is currently set to, so a repeated request is not a USB round
     *  trip and a failed one does not leave this lying. */
    private latencyMs = FTDI_LATENCY_MS;
    /** Resolves when the read loop has actually exited, so recoverRead does not race it. */
    private pumpExited: Promise<void> = Promise.resolve();
    /**
     * LSR bits are latched-since-last-read, so the first packet after a (re)start can report a
     * condition that predates us — most visibly the break we just recovered from. Ignoring line
     * status on exactly one packet stops recovery from immediately re-latching the fault it repaired.
     */
    private skipLineStatusOnce = false;

    static isSupported(): boolean {
        return typeof navigator !== 'undefined' && 'usb' in navigator && navigator.usb !== undefined;
    }

    private onDisconnect = (event: USBConnectionEvent): void => {
        if (this.device && event.device === this.device) {
            this.deviceGone = true;
            this.latch(new FtdiLineError('NetworkError', 'The device was disconnected'));
        }
    };

    /** One vendor OUT request. bmRequestType 0x40 is what `requestType: 'vendor'` + device recipient
     *  encodes, which is what the FTDI firmware expects for all of these. */
    /**
     * Arms the low latency timer for a datalog, or puts the idle one back.
     *
     * Best-effort by contract: a chip that refuses the request logs slower, which is what it was
     * doing before. It must never be able to fail a run — this is a throughput adjustment, and the
     * run is the thing that matters.
     */
    async setLatencyTimer(mode: 'log' | 'idle'): Promise<void> {
        const want = mode === 'log' ? FTDI_LOG_LATENCY_MS : FTDI_LATENCY_MS;
        if (this.latencyMs === want || !this.device) return;
        try {
            await this.sio(SIO_SET_LATENCY_TIMER, want);
            this.latencyMs = want;
        } catch { /* the run carries on at whatever the chip is already doing */ }
    }

    private async sio(request: number, value: number, index = FTDI_PORT_INDEX): Promise<void> {
        const device = this.device;
        if (!device) throw new DmeLinkError('USB device is not open');
        const result = await device.controlTransferOut({
            requestType: 'vendor', recipient: 'device', request, value, index,
        });
        if (result.status !== 'ok') {
            throw new DmeLinkError(`FTDI control request 0x${request.toString(16)} failed (${result.status})`);
        }
    }

    private async setBaudRate(baudRate: number): Promise<void> {
        const divisor = FTDI_DIVISORS[baudRate];
        if (!divisor) {
            throw new DmeLinkError(
                `Unsupported baud rate ${baudRate} for the FTDI transport (supported: ` +
                `${Object.keys(FTDI_DIVISORS).join(', ')})`);
        }
        await this.sio(SIO_SET_BAUD_RATE, divisor.value, divisor.index);
    }

    private async flushReceive(): Promise<void> {
        await this.sio(SIO_RESET, SIO_RESET_PURGE_RX);
    }

    async open(): Promise<void> {
        if (!WebUsbFtdiTransport.isSupported()) {
            throw new DmeLinkError('WebUSB is not available in this browser (Chrome for Android required).');
        }
        const usb = navigator.usb!;

        // A device already granted to this origin first: WebUSB permissions persist, so a returning
        // user should not have to pick the same cable again. It also has to come before
        // requestDevice(), while the transient user activation from the tap is still alive.
        const granted = (await usb.getDevices()).filter(d => d.vendorId === FTDI_VENDOR_ID);
        // requestDevice's rejection is deliberately NOT wrapped: dismissing the chooser rejects with
        // NotFoundError, and useDmeLink treats that name as a user cancel rather than a failure.
        // Wrapping it would turn "changed their mind" into a red error line.
        const device = granted[0] ?? await usb.requestDevice({ filters: [{ vendorId: FTDI_VENDOR_ID }] });
        this.device = device;
        this.deviceGone = false;

        await device.open();
        if (!device.configuration) await device.selectConfiguration(1);

        this.selectEndpoints();
        this.assertSupportedChipFamily();

        await device.claimInterface(this.interfaceNumber);
        usb.addEventListener('disconnect', this.onDisconnect);

        // Order matters: SIO_RESET clears modem-control state, so the DTR/RTS request must follow it.
        await this.sio(SIO_RESET, SIO_RESET_SIO);
        // Back to the idle value on every open, so a run that ended by the cable being pulled cannot
        // leave the chip waking 250 times a second for the next session.
        this.latencyMs = FTDI_LATENCY_MS;
        await this.sio(SIO_SET_LATENCY_TIMER, FTDI_LATENCY_MS);
        await this.sio(SIO_SET_FLOW_CTRL, 0, 0x0000 | FTDI_PORT_INDEX); // mode 0 = none, in the high byte
        await this.setBaudRate(9600);
        await this.sio(SIO_SET_DATA, FTDI_DATA_8E1);
        await this.sio(SIO_SET_MODEM_CTRL, FTDI_MODEM_DTR_LOW_RTS_LOW);
        await this.flushReceive();

        this.clearBuffer();
        this.pumpError = null;
        this.skipLineStatusOnce = true;
        this.pumpActive = true;
        this.startPump();
    }

    /** Finds the bulk IN/OUT pair from the descriptors. Endpoint numbers are never hardcoded: they
     *  are 0x81/0x02 on every FT232R seen so far, but a wrong guess here is a silent dead link. */
    private selectEndpoints(): void {
        const device = this.device!;
        for (const iface of device.configuration?.interfaces ?? []) {
            const inEp = iface.alternate.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
            const outEp = iface.alternate.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
            if (inEp && outEp) {
                this.interfaceNumber = iface.interfaceNumber;
                this.inEndpoint = inEp.endpointNumber;
                this.outEndpoint = outEp.endpointNumber;
                this.packetSize = inEp.packetSize || 64;
                return;
            }
        }
        throw new DmeLinkError('No bulk endpoint pair found on this USB device — is it really an FTDI cable?');
    }

    private assertSupportedChipFamily(): void {
        const version = this.device!.deviceVersionMajor;
        if (!SUPPORTED_CHIP_VERSIONS.has(version)) {
            throw new DmeLinkError(
                `Unsupported FTDI chip (bcdDevice major ${version}). This transport implements the ` +
                `3 MHz divisor encoding used by FT232AM/BM/R; H-series and FT-X parts clock differently.`);
        }
    }

    /**
     * The read loop.
     *
     * Every bulk IN **packet** — not every transfer — is prefixed with two status bytes, so with a
     * multi-packet transfer the headers are *interior*, not merely at offset 0. Stripping them at
     * offset 0 only would produce a plausible-looking BIN with two bytes of garbage every 64, which
     * is the worst failure this design can have: it does not announce itself.
     *
     * There is no busy spin to avoid. `transferIn` has no timeout and stays pending until the chip
     * sends something, and the chip sends a status packet on every latency-timer expiry regardless
     * of traffic — which is also what makes `pumpActive = false` sufficient to stop this loop within
     * one latency period, with no transfer to cancel.
     *
     * Exactly one transfer is in flight at a time. Queueing several is the usual WebUSB throughput
     * trick and they almost certainly complete in order — but "almost certainly" reorders a flash
     * payload, and the OE bit will say empirically whether a second is ever needed.
     */
    private startPump(): void {
        const device = this.device!;
        this.pumpExited = (async () => {
            const scratch = new Uint8Array(8 * this.packetSize);
            while (this.pumpActive) {
                let result: USBInTransferResult;
                try {
                    result = await device.transferIn(this.inEndpoint, 8 * this.packetSize);
                } catch (e: unknown) {
                    if (!this.pumpActive) return;
                    this.latch(this.classifyTransferError(e));
                    return;
                }
                if (!this.pumpActive) return;
                if (result.status === 'stall') {
                    try { await device.clearHalt('in', this.inEndpoint); continue; }
                    catch (e: unknown) { this.latch(this.classifyTransferError(e)); return; }
                }
                if (result.status === 'babble') {
                    this.latch(new FtdiLineError('BabbleError', 'The USB device returned more data than requested'));
                    return;
                }

                const view = result.data;
                if (!view) continue;
                let payload = 0;
                let fault: number | null = null;
                for (let offset = 0; offset + 2 <= view.byteLength; offset += this.packetSize) {
                    const lineStatus = view.getUint8(offset + 1);
                    if ((lineStatus & LSR_ANY_ERROR) !== 0 && !this.skipLineStatusOnce) {
                        fault = lineStatus;
                        break;
                    }
                    const available = Math.min(this.packetSize, view.byteLength - offset) - 2;
                    for (let i = 0; i < available; i++) scratch[payload++] = view.getUint8(offset + 2 + i);
                }
                this.skipLineStatusOnce = false;
                // Deliver before latching: bytes that arrived cleanly ahead of the fault in the same
                // transfer are real, and dropping them would desync the frame the link is mid-way
                // through reading.
                if (payload > 0) this.receive(scratch.subarray(0, payload));
                if (fault !== null) { this.latch(this.classifyLineStatus(fault)); return; }
            }
        })();
    }

    /** Maps line-status bits onto the error NAMES the Web Serial backend produces, because
     *  readExact's message and §9's triage table are both written against those spellings.
     *  Priority order: a break implies the framing garbage that accompanies it. */
    private classifyLineStatus(lineStatus: number): Error {
        if (lineStatus & LSR_BREAK) return new FtdiLineError('BreakError', 'Break received');
        if (lineStatus & LSR_FRAMING) return new FtdiLineError('FramingError', 'Framing error');
        if (lineStatus & LSR_PARITY) return new FtdiLineError('ParityError', 'Parity error');
        return new FtdiLineError('BufferOverrunError', 'Receive buffer overrun');
    }

    private classifyTransferError(e: unknown): Error {
        if (this.deviceGone) return new FtdiLineError('NetworkError', 'The device was disconnected');
        return e instanceof Error ? e : new Error(String(e));
    }

    async close(): Promise<void> {
        this.pumpActive = false;
        this.releaseWaiter();
        navigator.usb?.removeEventListener('disconnect', this.onDisconnect);
        try { await this.pumpExited; } catch { }
        try { await this.device?.releaseInterface(this.interfaceNumber); } catch { }
        try { await this.device?.close(); } catch { }
        this.device = null;
        this.clearBuffer();
    }

    /**
     * Changes baud **in place** — one control transfer, no close, no reopen, no restarted pump.
     *
     * This is the structural difference the implementation notes call out as forced and
     * unavoidable: "Web Serial has no in-place baud change, so reopen() must do close() + open().
     * Every boosted read therefore begins with a port transition that no other DS2 tool produces …
     * It cannot be removed, only made less disruptive." On this backend it *is* removed, and the app
     * does exactly what the reference tool does (FT_SetBaudRate on the still-open handle).
     *
     * Note what follows from that: there is no control-line symmetry to maintain here. The Web
     * Serial backend re-de-asserts DTR/RTS after every reopen because its close/open cycle moves
     * them; nothing moves them here, so they are set once at open() and never touched again.
     */
    /** SET_BAUD_RATE on the open handle. No close, no reopen, no control-line movement — the read
     *  loop never even stops. This is what the reference does over D2XX. */
    reopenIsInPlace(): boolean {
        return true;
    }

    async reopen(baudRate: number): Promise<void> {
        if (!this.device) throw new DmeLinkError('USB device is not open');
        await this.setBaudRate(baudRate);
        await this.flushReceive();
        this.clearBuffer();
        this.pumpError = null;
        this.skipLineStatusOnce = true;
    }

    async write(bytes: Uint8Array): Promise<void> {
        const device = this.device;
        if (!device) throw new DmeLinkError('USB device is not open');
        this.timing?.writeStart(performance.now());
        const result = await device.transferOut(this.outEndpoint, bytes);
        this.timing?.writeEnd(performance.now());
        if (result.status !== 'ok') {
            throw new DmeLinkError(`USB write failed (${result.status})`);
        }
    }

    /**
     * Empties the JS buffer and, unlike the Web Serial backend, also flushes the chip's own FIFO.
     *
     * Stays synchronous by contract — `resyncTransport` calls it without awaiting and
     * `drainUntilQuiet` reads `bufferedLength()` immediately afterwards. The driver flush is
     * therefore fire-and-forget. That is safe for the reason already documented on the Web Serial
     * version: purge runs *between* exchanges, under the link's command gate, so there is no
     * in-flight frame for a late-landing flush to eat. If that invariant ever changes, this becomes
     * a real hazard rather than a tidy-up.
     */
    purge(): void {
        super.purge();
        void this.flushReceive().catch(() => { });
    }

    /**
     * Clears a latched fault without closing the device.
     *
     * Simpler and stronger than the Web Serial equivalent: there is no reader to re-acquire, and the
     * flush is a real one that reaches the chip's FIFO rather than only the bytes already handed to
     * us. The 100 ms settle is kept identical, because it is sized to the break/idle condition on
     * the wire, not to anything about the host API.
     */
    async recoverRead(): Promise<void> {
        if (!this.device) throw new DmeLinkError('USB device is not open');
        this.pumpActive = false;
        this.releaseWaiter();
        try { await this.pumpExited; } catch { }
        await new Promise(r => setTimeout(r, 100)); // let the break / idle condition settle
        if (this.deviceGone) {
            throw new DmeLinkError('The USB device disconnected — unplug and replug the cable, then reconnect.');
        }
        await this.flushReceive();
        this.clearBuffer();
        this.pumpError = null;
        this.skipLineStatusOnce = true;
        this.pumpActive = true;
        this.startPump();
    }
}
