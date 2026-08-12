/**
 * A bounded record of what the link actually did, in order.
 *
 * ## Why this exists
 *
 * Everything this app does to a DME happens in a car, and — since the Android build — increasingly
 * on a phone in a car. When a flash or a datalog goes wrong there, the entire diagnosis available
 * afterwards is one sentence in a dialog. `TransferTiming` answers "where did the milliseconds go",
 * which is a different question from "what did we do, in what order, and what did the ECU say" —
 * and the second is the one that is asked first.
 *
 * So: phase-level events, uploaded with the timing report. Between them a failed write can be read
 * at a desk without the car, the cable, or the person who was holding it.
 *
 * ## What it deliberately is not
 *
 * **Not a telegram trace.** Nothing here is called per exchange. A 538-chunk write would produce
 * 538 strings on the critical path of an operation that erases before it writes, and the whole
 * discipline of the timing instrument next door is that measurement must not land inside the
 * interval it measures. Events are phase transitions and answers from the DME: tens per operation,
 * not thousands.
 *
 * **Not a logger.** No console, no levels, no formatting hooks. It is a ring buffer of strings with
 * timestamps, because that is all that survives being uploaded and read three days later.
 */

/** Entries retained. A whole flash produces a few dozen; a long datalog with a flaky cable is the
 *  case that could produce many, and this is the cap that keeps it from growing without bound. */
const MAX_EVENTS = 600;

export interface LinkEvent {
    /** Milliseconds since the log was created, monotonic (`performance.now()`). */
    t: number;
    message: string;
}

export class LinkEventLog {
    private readonly events: LinkEvent[] = [];
    private readonly t0 = performance.now();
    /** Wall clock at t0, so an uploaded log can be placed on a calendar. Monotonic time alone
     *  cannot be compared against anything outside this session. */
    readonly startedAt = Date.now();
    /** Set once the ring has wrapped, so a reader is told the head is missing rather than
     *  assuming an operation began where the first retained line says it did. */
    private dropped = 0;

    push(message: string): void {
        if (this.events.length >= MAX_EVENTS) {
            this.events.shift();
            this.dropped++;
        }
        this.events.push({ t: Math.round((performance.now() - this.t0) * 10) / 10, message });
    }

    /** Convenience for the common "did a thing, here is how long it took" line. */
    pushTimed(message: string, startedAtMs: number): void {
        this.push(`${message} — ${Math.round(performance.now() - startedAtMs)} ms`);
    }

    snapshot(): { startedAt: number; dropped: number; events: LinkEvent[] } {
        return { startedAt: this.startedAt, dropped: this.dropped, events: [...this.events] };
    }
}

export type LinkEventLogSnapshot = ReturnType<LinkEventLog['snapshot']>;

/**
 * One line describing an encoding-checksum answer, for the event log and for a dialog.
 *
 * Names the faulted areas rather than printing the raw byte alone, because "0x00" and "0x44" are
 * not something anyone should have to decode from a phone screen — but the raw byte is kept too,
 * since it is the only part that is certainly correct if the bit table ever turns out to be wrong.
 */
export function describeEncodingChecksum(
    result: { lowByte: number; areas: readonly { name: string; faulted: boolean }[] },
): string {
    const faulted = result.areas.filter(a => a.faulted).map(a => a.name);
    const raw = `0x${result.lowByte.toString(16).padStart(2, '0')}`;
    return faulted.length === 0 ? `all areas clean (${raw})` : `FAULTED: ${faulted.join(', ')} (${raw})`;
}
