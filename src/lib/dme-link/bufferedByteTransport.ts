import { DmeLinkError } from './types';
import type { TransferTiming } from './transferTiming';

/**
 * The receive buffer, the parked waiter, and `readExact` — everything a byte transport does *after*
 * bytes have arrived, independent of how they arrived.
 *
 * This was lifted verbatim out of `WebSerialTransport` when the WebUSB backend was added, rather
 * than copied into it. The waiter semantics below are the most subtle thing in the transport layer
 * and the throughput investigation in §9 of the implementation notes turned on them; two copies
 * would drift, and the drift would show up as an intermittent framing fault in a car rather than as
 * a failing check on a desk. The same reasoning the link applies to its own recovery paths — a
 * repair must not be allowed to diverge from the thing it repairs — applies here.
 *
 * Subclasses own the wire: they call `receive()` as bytes land and `latch()` when the stream faults.
 */
export abstract class BufferedByteTransport {
    protected buffer: number[] = [];
    protected pumpActive = false;
    protected pumpError: Error | null = null;
    /**
     * A single reader parked in readExact, woken by the pump the moment enough bytes have arrived.
     *
     * Replaces a `setTimeout(2)` polling loop. Browsers clamp nested timers to ~4 ms, so that loop
     * could sit on data that had already arrived for up to a full clamp period — three times per DS2
     * exchange (echo, header, body). At 9600 the wire dominates and it hides; the faster the rate,
     * the larger that fixed cost looms, which is why raising the baud stopped producing a speed-up.
     *
     * One waiter is enough: the transport is serialised by the link's command gate, so readExact is
     * never re-entered concurrently.
     */
    private waiter: { need: number; wake: () => void } | null = null;
    /** Optional per-chunk instrument. Null (and every call site optional-chained) so the uninstrumented
     *  path costs one null check — see transferTiming.ts for why that matters here. */
    protected timing: TransferTiming | null = null;

    /** Attaches the read-timing instrument. The link owns exchange boundaries; the transport owns byte
     *  arrival, so both have to write into the same object. */
    setTiming(timing: TransferTiming | null): void {
        this.timing = timing;
    }

    /** Wakes the parked reader once its byte count is satisfiable — or once it can only fail. */
    private signalWaiter(): void {
        const w = this.waiter;
        if (w && (this.buffer.length >= w.need || this.pumpError)) {
            this.waiter = null;
            w.wake();
        }
    }

    /** Releases a parked reader unconditionally. Used wherever the pump it is waiting on is about to
     *  be torn down: after that point no byte can ever arrive to wake it, so leaving it parked would
     *  cost a full timeout for nothing. */
    protected releaseWaiter(): void {
        const w = this.waiter;
        if (w) { this.waiter = null; w.wake(); }
    }

    /**
     * Hands received bytes to the buffer and wakes anyone waiting on them.
     *
     * Timestamped HERE, not in readExact: readExact only ever learns that enough bytes exist, never
     * when each arrived. Byte arrival times are the whole point — they are what separates "the DME
     * was thinking" from "the bytes were here and we were slow to notice".
     *
     * Callers must not invoke this for a zero-length arrival: `rxEvents` counts byte deliveries, and
     * an empty one would inflate it. That matters on the WebUSB backend, where the chip emits a
     * status packet on every latency-timer expiry whether or not it carries data.
     */
    protected receive(bytes: Uint8Array): void {
        this.timing?.rx(performance.now());
        for (let i = 0; i < bytes.length; i++) this.buffer.push(bytes[i]);
        this.signalWaiter();
    }

    /**
     * Latches a stream error. A latched error must wake the reader too, or it waits out its whole
     * timeout for bytes that can no longer arrive — turning a break into a multi-second stall.
     */
    protected latch(error: Error): void {
        this.pumpError = error;
        this.signalWaiter();
    }

    protected clearBuffer(): void {
        this.buffer = [];
    }

    /** Discards any buffered received bytes — used to resynchronize after a timeout before retrying. */
    purge(): void {
        // No waiter can be parked here: purge runs between exchanges, and the link's command gate
        // makes those strictly sequential. Emptying the buffer under a parked reader would strand it
        // until its deadline, so if that invariant ever changes this needs a signalWaiter().
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
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new DmeLinkError(`Timed out waiting for ${length} byte(s) (received ${this.buffer.length})`);
            }
            // Park until the pump says the bytes are here, or the deadline passes — whichever first.
            // The loop still re-checks afterwards, so a spurious wake costs one comparison.
            //
            // Parked time is measured because it is the honest accounting of "waiting for the wire"
            // versus "us being slow": if parked time is close to the total, the bytes genuinely were
            // not here yet and no host-side change helps.
            this.timing?.parkStart(performance.now());
            await new Promise<void>(resolve => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const wake = () => { if (timer !== undefined) clearTimeout(timer); resolve(); };
                timer = setTimeout(() => {
                    if (this.waiter?.wake === wake) this.waiter = null;
                    resolve();
                }, remaining);
                this.waiter = { need: length, wake };
            });
            this.timing?.parkEnd(performance.now());
        }
        return Uint8Array.from(this.buffer.splice(0, length));
    }
}
