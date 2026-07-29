/**
 * Per-chunk timing for a DS2 bulk read, built to answer one question: where do the ~76 ms per chunk
 * that are not wire time actually go?
 *
 * A 64 KiB read at 9600 8E1 has a hard floor of ~83 s (538 chunks x 135 byte-times x 1.1458 ms) and
 * measures ~124 s. Raising the baud barely helps, which is the signature of a fixed per-exchange cost
 * dominating. Three candidates were indistinguishable from the outside:
 *
 *   - DME turnaround (P2) — the ECU thinking between our last echo byte and its first response byte.
 *     If this is the residual, no amount of host-side work recovers it and the reference tool pays it
 *     identically.
 *   - Per-byte-arrival cost — at 9600 a byte takes 1.15 ms, so an FTDI latency timer of 1 ms emits
 *     roughly one USB IN transfer per byte, and each one is a `reader.read()` resolution crossing
 *     from the browser process into the renderer. ~135 of those per chunk.
 *   - Something of ours — parking, draining, buffering.
 *
 * `rxEvents` per chunk is the single most decisive number here: ~135 means per-byte-arrival cost is
 * real and the latency timer is the lever; ~10 means that hypothesis is dead.
 *
 * ## Why this file looks the way it does
 *
 * An instrument that allocates, formats, or branches much lands inside the very interval it is
 * measuring. So: preallocated Float64Arrays sized once at read start, no push, no object literals, no
 * strings and no console during the transfer, and every method returns early on one boolean compare
 * when disabled. Everything stays numeric until `report()` runs after the last chunk.
 *
 * Deliberately dependency-free and DOM-free, matching WebSerialTransport — the transport is a
 * candidate to move into a Worker later, and an instrument that reaches for `window` would block that.
 */

/** A single chunk's decomposition, all in milliseconds unless noted. */
export interface ChunkTiming {
    /** Time inside transport.write() — should be ~0. Non-zero points at WICG/serial#123, where
     *  Chromium splits a write that straddles its ring-buffer boundary. */
    write: number;
    /** Write resolved -> first byte of our own echo came back. Cable + UART turnaround. */
    echoLatency: number;
    /** Last echo byte -> first response byte. THE number: this is the DME thinking, and it is the one
     *  part of the residual that no host-side change can recover. */
    turnaround: number;
    /** First response byte -> last response byte. Compare against theory to confirm the link is
     *  really running at the baud we believe it is. */
    responseWire: number;
    /** Total time the chunk's three readExact calls spent parked waiting to be woken. */
    parked: number;
    /** How many times the pump's reader.read() resolved during this chunk. */
    rxEvents: number;
    /** Wall time for the whole exchange, write through last response byte. */
    total: number;
}

export interface ReadTimingReport {
    /**
     * Whether the read ran to completion. **A failed read's timing is the most valuable kind**, so
     * this is recorded rather than the report being discarded: `chunks` then says how far it got and
     * `error` says what stopped it, which together are the whole diagnosis for a baud rate that dies
     * part-way. The first version of this instrument only surfaced the report on success, and a
     * latency sweep came back with three files that were byte-identical copies of the previous run.
     */
    completed: boolean;
    /** The failure that ended the read, verbatim — including the latched pump error name, which is
     *  what separates a receive overrun from a physical-layer fault from a silent DME. */
    error: string | null;
    /** Completed exchanges. On a failed read this is where it stopped. */
    chunks: number;
    /**
     * Real wall clock across the chunk loop, gaps and retries included.
     *
     * Necessary because `chunks x median.total` does NOT reproduce it: `total` measures one exchange,
     * and a retry's settle happens between exchanges rather than inside one, so an estimate built from
     * the medians silently omits it. When the headline number IS the duration, it has to be measured.
     *
     * Excludes login and the baud switch, which happen before the loop is armed.
     */
    elapsedMs: number;
    /** Bytes requested per read telegram at the time of the read. */
    chunkSize: number;
    /**
     * The rate the UI ASKED for. Separate from `baud`, which is what the read actually ran at.
     *
     * They differ whenever the DME turns a switch down, and that used to leave no trace in the file —
     * only a colour on the notice line. Four candidate rates were then tested on a car and every
     * report came back saying 9600, with no way to tell from the data whether the ECU had refused them
     * or the app had never asked. `switchOutcome` is the other half of that answer.
     */
    requestedBaud: number | null;
    /** 'accepted' / 'rejected (DS2 status 0x..)' / 'failed (...)', or null when no switch was
     *  attempted. A 0xA2 rejection is the DME saying it does not implement that rate — which is a
     *  fact about the ECU, not about this app, and worth having in writing. */
    switchOutcome: string | null;
    /** The rate the read actually ran at. */
    baud: number | null;
    /** The DME's published maximum telegram length, if it was readable. */
    maxTelegramLength: number | null;
    /** Retried chunks. A retry carries 300-1600 ms of deliberate settle, which is why every stat
     *  below is a MEDIAN — one glitchy chunk would otherwise swamp a mean and make a clean read and a
     *  read with three faults report the same number. */
    retries: number;
    median: ChunkTiming;
    /** Expected response wire time for one chunk at `baud`, from the frame size. Lets a reader see at
     *  a glance whether the line is running at the rate the UI claims. */
    theoreticalResponseWire: number | null;
    /** High-resolution inter-arrival gaps (ms) for a few sampled chunks. Bounded on purpose: a full
     *  trace would be ~72,600 events. Shows the shape a median cannot — e.g. whether bytes arrive one
     *  per ~1.15 ms (per-byte USB packets) or in bursts. */
    samples: { chunk: number; gaps: number[] }[];
}

/** Chunks whose full rx-arrival trace is kept: the first few, and a few from the middle. */
const SAMPLE_HEAD = 5;
const SAMPLE_MID = 5;
/** Cap on retained gaps per sampled chunk. A 251-byte response cannot exceed this. */
const MAX_GAPS_PER_SAMPLE = 300;

function median(values: Float64Array, count: number): number {
    if (count === 0) return 0;
    const copy = Array.prototype.slice.call(values, 0, count) as number[];
    copy.sort((a, b) => a - b);
    const mid = count >> 1;
    return count % 2 ? copy[mid] : (copy[mid - 1] + copy[mid]) / 2;
}

export class TransferTiming {
    /** User-facing DIAG switch. Only decides whether begin() arms collection. */
    private enabled = false;
    /**
     * True only between begin() and finish(), i.e. only during a bulk read.
     *
     * Separate from `enabled` on purpose. `exchange()` is shared with the FLASH WRITE path, so a
     * single `enabled` flag would leave the instrument live during programming. Nothing it does can
     * alter control flow — every method returns void and never throws — but an instrument that is
     * inert outside the window it was built for is easier to reason about than one that is merely
     * harmless everywhere.
     */
    private collecting = false;

    // Per-chunk lanes, preallocated in begin().
    private write!: Float64Array;
    private echoLatency!: Float64Array;
    private turnaround!: Float64Array;
    private responseWire!: Float64Array;
    private parked!: Float64Array;
    private rxEvents!: Float64Array;
    private total!: Float64Array;

    private capacity = 0;
    private index = 0;
    private tBegin = 0;
    private retries = 0;
    private chunkSize = 0;
    private requestedBaud: number | null = null;
    private switchOutcome: string | null = null;
    private baud: number | null = null;
    private maxTelegramLength: number | null = null;

    // Live state for the chunk in flight.
    private active = false;
    private tExchangeStart = 0;
    private tWriteStart = 0;
    private tWriteEnd = 0;
    private tFirstRx = 0;
    private tLastRx = 0;
    private tEchoDone = 0;
    private tFirstResponseRx = 0;
    private chunkRx = 0;
    private chunkParked = 0;
    private tParkStart = 0;
    /** True between echoComplete() and the end of the chunk, so the pump can tag the first rx event
     *  after the echo as the start of the response. */
    private awaitingResponse = false;

    private sampleGaps: Float64Array | null = null;
    private sampleGapCount = 0;
    private samples: { chunk: number; gaps: number[] }[] = [];
    private midSampleFrom = Number.MAX_SAFE_INTEGER;

    private lastReport: ReadTimingReport | null = null;

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    getReport(): ReadTimingReport | null {
        return this.lastReport;
    }

    /**
     * Drops any previous report. Called at the very START of a read attempt, before the login and the
     * baud switch, so that a read failing *before* begin() cannot leave the previous run's numbers
     * sitting there looking like this one's.
     *
     * begin() clears the report too, but only once it is reached. The gap between those two points is
     * exactly where a refused baud switch or a failed login lives — the failures most likely to be
     * under investigation. "No report" is an honest answer; last time's report is not.
     */
    clearReport(): void {
        this.lastReport = null;
    }

    /**
     * Sizes every lane for a read of `expectedChunks`. Called once, before the first exchange.
     *
     * Named fields rather than positional: this grew to five settings, two of which are baud rates
     * that differ only in meaning (asked-for vs actually-ran-at). Getting those the wrong way round
     * would produce a report that looks entirely plausible and is wrong about the one thing it exists
     * to record.
     */
    begin(expectedChunks: number, info: {
        chunkSize: number;
        requestedBaud: number | null;
        switchOutcome: string | null;
        baud: number | null;
        maxTelegramLength: number | null;
    }): void {
        if (!this.enabled) return;
        const { chunkSize, requestedBaud, switchOutcome, baud, maxTelegramLength } = info;
        // +8 of slack: a retried chunk records twice, and running off the end must never throw inside
        // a read. Overflow beyond that is dropped by the bounds check in end().
        const capacity = expectedChunks + 8;
        this.write = new Float64Array(capacity);
        this.echoLatency = new Float64Array(capacity);
        this.turnaround = new Float64Array(capacity);
        this.responseWire = new Float64Array(capacity);
        this.parked = new Float64Array(capacity);
        this.rxEvents = new Float64Array(capacity);
        this.total = new Float64Array(capacity);
        this.sampleGaps = new Float64Array(MAX_GAPS_PER_SAMPLE);
        this.capacity = capacity;
        this.index = 0;
        this.retries = 0;
        this.chunkSize = chunkSize;
        this.requestedBaud = requestedBaud;
        this.switchOutcome = switchOutcome;
        this.baud = baud;
        this.maxTelegramLength = maxTelegramLength;
        this.samples = [];
        this.midSampleFrom = Math.max(SAMPLE_HEAD, Math.floor(expectedChunks / 2));
        this.lastReport = null;
        this.tBegin = performance.now();
        this.collecting = true;
    }

    /** Start of one DS2 exchange, before the request is written. */
    exchangeStart(now: number): void {
        if (!this.collecting) return;
        this.active = true;
        this.tExchangeStart = now;
        this.tFirstRx = 0;
        this.tLastRx = 0;
        this.tEchoDone = 0;
        this.tFirstResponseRx = 0;
        this.chunkRx = 0;
        this.chunkParked = 0;
        this.awaitingResponse = false;
        this.sampleGapCount = 0;
    }

    writeStart(now: number): void {
        if (!this.collecting || !this.active) return;
        this.tWriteStart = now;
    }

    writeEnd(now: number): void {
        if (!this.collecting || !this.active) return;
        this.tWriteEnd = now;
    }

    /**
     * One resolution of the pump's reader.read(). Called from the pump, which is why the transport
     * needs the timer at all: `readExact` cannot see arrival times, only whether enough bytes exist.
     */
    rx(now: number): void {
        if (!this.collecting || !this.active) return;
        if (this.chunkRx === 0) this.tFirstRx = now;
        else if (this.sampleGaps !== null && this.sampleGapCount < MAX_GAPS_PER_SAMPLE && this.isSampledChunk()) {
            this.sampleGaps[this.sampleGapCount++] = now - this.tLastRx;
        }
        if (this.awaitingResponse && this.tFirstResponseRx === 0) this.tFirstResponseRx = now;
        this.tLastRx = now;
        this.chunkRx++;
    }

    /** The echo has been fully read; everything arriving from here is the DME's response. */
    echoComplete(now: number): void {
        if (!this.collecting || !this.active) return;
        // The echo's LAST byte is what the turnaround is measured from — not this call, which happens
        // after readExact has drained the buffer and could be an event-loop turn later.
        this.tEchoDone = this.tLastRx || now;
        this.awaitingResponse = true;
    }

    parkStart(now: number): void {
        if (!this.collecting || !this.active) return;
        this.tParkStart = now;
    }

    parkEnd(now: number): void {
        if (!this.enabled || !this.active || this.tParkStart === 0) return;
        this.chunkParked += now - this.tParkStart;
        this.tParkStart = 0;
    }

    retry(): void {
        if (!this.collecting) return;
        this.retries++;
    }

    /** End of one exchange. Folds the live state into the lanes. */
    exchangeEnd(now: number): void {
        if (!this.collecting || !this.active) return;
        this.active = false;
        const i = this.index;
        if (i >= this.capacity) return;
        this.write[i] = this.tWriteEnd - this.tWriteStart;
        this.echoLatency[i] = this.tFirstRx ? this.tFirstRx - this.tWriteEnd : 0;
        this.turnaround[i] = this.tFirstResponseRx && this.tEchoDone ? this.tFirstResponseRx - this.tEchoDone : 0;
        this.responseWire[i] = this.tFirstResponseRx ? this.tLastRx - this.tFirstResponseRx : 0;
        this.parked[i] = this.chunkParked;
        this.rxEvents[i] = this.chunkRx;
        this.total[i] = now - this.tExchangeStart;
        if (this.sampleGaps !== null && this.sampleGapCount > 0 && this.isSampledChunk()) {
            this.samples.push({
                chunk: i,
                gaps: Array.prototype.slice.call(this.sampleGaps, 0, this.sampleGapCount) as number[],
            });
        }
        this.index = i + 1;
    }

    /** Folds the lanes into medians. Called once, after the last chunk — the only place that allocates
     *  or formats. */
    finish(error?: unknown): ReadTimingReport | null {
        if (!this.collecting) return null;
        this.collecting = false;
        const n = this.index;
        const report: ReadTimingReport = {
            completed: error === undefined,
            error: error === undefined ? null : (error instanceof Error ? error.message : String(error)),
            chunks: n,
            elapsedMs: performance.now() - this.tBegin,
            chunkSize: this.chunkSize,
            requestedBaud: this.requestedBaud,
            switchOutcome: this.switchOutcome,
            baud: this.baud,
            maxTelegramLength: this.maxTelegramLength,
            retries: this.retries,
            median: {
                write: median(this.write, n),
                echoLatency: median(this.echoLatency, n),
                turnaround: median(this.turnaround, n),
                responseWire: median(this.responseWire, n),
                parked: median(this.parked, n),
                rxEvents: median(this.rxEvents, n),
                total: median(this.total, n),
            },
            // A read response is [addr][len][status][N data][cksum] = N+4 bytes, and 8E1 puts 11 bit
            // times on the wire per byte.
            theoreticalResponseWire: this.baud ? ((this.chunkSize + 4) * 11 * 1000) / this.baud : null,
            samples: this.samples,
        };
        this.lastReport = report;
        return report;
    }

    private isSampledChunk(): boolean {
        return this.index < SAMPLE_HEAD || (this.index >= this.midSampleFrom && this.index < this.midSampleFrom + SAMPLE_MID);
    }
}

/*
 * There was a formatTimingTail() here that compressed the medians into the DME notice line
 * (`rx135 w0.1 ta53 wire141/144 …`). It earned its keep while numbers were being read from the
 * driver's seat between runs of a sweep. That sweep is over, the notice line's job is the headline
 * (`9600 baud · 64 KB / 123.2 s · 530 B/s`), and a refused switch is already stated there in full by
 * the REFUSED branch — so the tail was repeating one thing and burying the rest. TIMING saves the
 * file; the file has everything.
 */
