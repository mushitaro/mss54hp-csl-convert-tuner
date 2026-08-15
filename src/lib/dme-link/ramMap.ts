/**
 * DS2 read access to the master's **live RAM**, via the same control 0x06 the tune read uses.
 *
 * ## Why this exists
 *
 * The eight predefined live-value blocks are the whole of what `READ_IO_STATUS` (0x0B) can give,
 * and every indicated-torque channel in that catalogue lives in selection 83 — which is not
 * telemetry at all. Selection 83 returns a 52-byte EGAS fault freeze-frame: master `0x024A66`
 * copies the signals in once and latches on byte 0 (`tst.b (a1) / bne.w $24b82`), and every later
 * event only increments that counter (`0x024B82: cmpi.b #$ff,(a1) / addq.b #$1,(a1)`). On a healthy
 * car it is 52 zero bytes forever. An inertia measurement that needs torque cannot be built on it,
 * and one was, and it produced nothing.
 *
 * Control 0x06 is a different mechanism and it does reach live RAM. The DME resolves a read through
 * a **region table** at master `0x3AD6` — 65 entries of `{ id, variant, lo, hi }`, 10 bytes each —
 * in `flash_req_parse` (master `0x00289C`). Four of those entries are RAM windows, and the torque
 * cluster is inside one of them.
 *
 * ## Why it is safe to send while the engine is running
 *
 * Three independent reasons, all recovered from the binary rather than assumed:
 *
 * 1. **The handler is a byte copy.** Segments 0x01/0x04 dispatch to `0x001FD8`, which after the
 *    region bounds check copies `count` bytes into the response buffer. No unlock, no programming
 *    mode, no state change. (Its one quirk: bytes in `0x4000`-`0x4018` come back as `0xFF`.)
 * 2. **The command gate is strictly weaker than the one live values already pass.** The application
 *    command table at master `0x3A1F0` admits a command when `mask & $ffd003 == 0`; selection reads
 *    (0x0B) carry mask `0xA0` and memory reads (0x06) carry `0x20`. `0xA0` clearing implies `0x20`
 *    clears, so anywhere `pollLiveMeasurement` works, this works.
 * 3. **The tune read already does it.** `readRange` sends 0x06 with no login at all.
 *
 * ## Reading the table
 *
 * A `variant` of `0xFF` means "no variant nibble" and the 24-bit address is used literally; other
 * entries take the top nibble of the address as a variant selector and mask it out. The RAM windows
 * are all `0xFF` entries, so the addresses below are the CPU's own addresses.
 *
 *   segment 0x01  ->  0x00FF8000 - 0x00FF8FFF   (4 KB)
 *   segment 0x04  ->  0x00FFD000 - 0x00FFEFFF   (8 KB)
 *
 * The interpretation is corroborated against three reads this app already performs: segment 0 with
 * address `0x200000`/`0xA00000` matches the table's 32 KB entries exactly, and the reference tool's
 * full read (segment 5, address 0, 512 KB) matches the 16 MB entry.
 *
 * **Slave RAM is not available on this calibration.** `0x001FD8` compares master `0x3FFC` against
 * `'M'`, and this image holds `4D 4D` ("MM"), which routes segments 0x08/0x0A/0x0B/0x0C to error
 * 0x07. Every signal here is master-side, so nothing needs it — but a probe must not read a failure
 * there as a broken link.
 */

/** One contiguous region the DME will serve a control-0x06 read from. `hi` is exclusive. */
export interface RamWindow {
    segment: number;
    lo: number;
    hi: number;
}

export const Mss54HpRamWindows = {
    /** `0x00FF8000`-`0x00FF8FFF`. Torque interventions, gear, overrun state, vehicle speed. */
    low: { segment: 0x01, lo: 0x00FF8000, hi: 0x00FF9000 },
    /** `0x00FFD000`-`0x00FFEFFF`. Momentenmanager torque chain, engine speed, temperatures. */
    high: { segment: 0x04, lo: 0x00FFD000, hi: 0x00FFF000 },
} as const satisfies Record<string, RamWindow>;

export const RAM_WINDOW_LIST: readonly RamWindow[] = Object.values(Mss54HpRamWindows);

/**
 * The DME's own clamp on a read count, from `flash_req_parse`: `cmpi.l #$80,(a3)` at `0x002A16`
 * truncates anything larger to 128. Asking for more does not error, it silently returns fewer bytes
 * — so this is enforced here rather than discovered as a short response.
 */
export const RAM_READ_MAX_COUNT = 0x80;

/**
 * Live RAM signals, with the sizes and scalings the block-83 catalogue already carried.
 *
 * **The addresses and the scalings come from the same place, which is what makes them trustworthy.**
 * `0x024A66` builds the EGAS freeze-frame by copying these exact RAM locations into exactly the
 * offsets the reference `DmeLiveValueCatalog` documents for selection 83:
 *
 *   0x024AD2:  move.b $ffedd0.l, $12(a1)     N40             -> block 83 offset 18
 *   0x024ADA:  move.b $ff805e.l, $13(a1)     D_N40           -> offset 19
 *   0x024B18:  move.w $ffd8be.l, $22(a1)     MD_IND_WUNSCH   -> offset 34
 *   0x024B28:  move.w $ff81a6.l, $26(a1)     MD_IND_NE       -> offset 38
 *   0x024B30:  move.w $ffd8e6.l, $28(a1)     MD_IND_OPT_KORR -> offset 40
 *   0x024B60:  move.b $ff8180.l, $30(a1)     MD_DYN_ST       -> offset 48
 *   0x024B68:  move.b $ff8250.l, $31(a1)     GANG            -> offset 49
 *   0x024B70:  move.b $ff80bb.l, $32(a1)     S_KRAFTSCHLUSS  -> offset 50
 *   0x024B78:  move.b $ff8247.l, $33(a1)     SA_WE_ST        -> offset 51
 *
 * Twenty fields, all verbatim `move.b`/`move.w`, no scaling applied on the way in. So a channel the
 * catalogue calls `uint16 x 0.1 Nm` at offset 40 is a `uint16 x 0.1 Nm` at `0xFFD8E6` — the one
 * thing the freeze-frame was ever good for is proving where its own contents live.
 */
export interface RamSignal {
    /** Which `Mss54HpRamWindows` segment serves this address. */
    segment: number;
    address: number;
    /** Bytes. The decode format follows from this and `signed`. */
    size: 1 | 2;
    signed: boolean;
    scale: number;
    unit: string;
}

export const Mss54HpRamSignals = {
    /**
     * Indicated torque **after intervention** (`nach Eingriff`) — the torque actually produced.
     *
     * This, and not `MD_IND_OPT_KORR`, is the channel an inertia regression wants. `md_eta_calc`
     * (slave `0x0155AA`) builds it through the ignition-efficiency term `ETA_NE`, so it follows a
     * retard; `MD_IND_OPT_KORR` is the optimal-timing value and therefore **overstates torque
     * exactly during the transients a pedal sweep is made of** — `KL_DYN_TZ_DBGR` pulls 3-12 degrees
     * out on a fast tip-in.
     *
     * Unsigned, so it cannot go below zero: under overrun cut it reads 0 rather than negative. That
     * is not a defect for this use, it is the anchor — zero indicated torque with a large negative
     * acceleration is the cleanest point on the line, and it is the point a pedal sweep alone never
     * reaches.
     */
    MD_IND_NE: { segment: 0x01, address: 0x00FF81A6, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Slew-limiter state. Bits 4-6 mean the tip-in or dashpot limiter actually clipped this cycle. */
    MD_DYN_ST: { segment: 0x01, address: 0x00FF8180, size: 1, signed: false, scale: 1, unit: '' },
    /** Overrun fuel cut. Bit 3 = cut ACTIVE; bit 0 is only "armed" and bit 5 is sticky. */
    SA_WE_ST: { segment: 0x01, address: 0x00FF8247, size: 1, signed: false, scale: 1, unit: '' },
    /** Calculated gear; 0 is neutral. */
    GANG: { segment: 0x01, address: 0x00FF8250, size: 1, signed: false, scale: 1, unit: '' },
    /** Net crank torque as the DME models it: `MD_IND_NE - MD_IND_SCHLEPP - MD_IND_VERBRAUCHER`. */
    MD_MOTOR: { segment: 0x01, address: 0x00FF817E, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Torque request before the tip-in/dashpot filter. */
    MD_FW: { segment: 0x04, address: 0x00FFD8B0, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** After it. `MD_FW_FILTER - MD_FW` is what `KF_MD_LS_KOMF` actually did, measured not inferred. */
    MD_FW_FILTER: { segment: 0x04, address: 0x00FFD8B2, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Tip-in limiter delta. Previously recorded as unreadable over DS2; it is not. */
    MD_LS_DELTA: { segment: 0x04, address: 0x00FFD8B8, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Dashpot limiter delta. */
    MD_DP_DELTA: { segment: 0x04, address: 0x00FFD8BA, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /** Indicated torque at optimal ignition. Kept for the filter work; NOT for the inertia fit. */
    MD_IND_OPT_KORR: { segment: 0x04, address: 0x00FFD8E6, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
    /**
     * Drag torque as the DME models it — and **not** a usable `M_loss(n)`.
     *
     * `MD_Minimum_Moment` (master `0x017542`) computes it as
     * `(MD_MIN_F_LLRA * (MD_LLRA_KO + MD_LLRA)) >> 10`, then floors it at zero. `MD_LLRA` is the
     * learned **idle** adaptation, so this tracks what the engine needs at idle rather than
     * resolving friction against engine speed. Dividing a coast-down gradient by it would import
     * that model's whole error into J multiplicatively. Exposed because it is worth *seeing* next to
     * the regression's own intercept, not because it can replace it.
     */
    MD_IND_SCHLEPP: { segment: 0x04, address: 0x00FFD886, size: 2, signed: false, scale: 0.1, unit: 'Nm' },
} as const satisfies Record<string, RamSignal>;

export type Mss54HpRamSignalName = keyof typeof Mss54HpRamSignals;

/**
 * The single read the inertia run adds to its block-3 poll.
 *
 * 40 bytes spanning `MD_DYN_ST` (`0xFF8180`) through the end of `MD_IND_NE` (`0xFF81A7`) — one
 * telegram for both, where two separate two-byte reads would cost a whole extra round trip for a
 * channel that only ever acts as a guard.
 */
export const INERTIA_RAM_READ = {
    segment: Mss54HpRamSignals.MD_IND_NE.segment,
    address: Mss54HpRamSignals.MD_DYN_ST.address,
    count: (Mss54HpRamSignals.MD_IND_NE.address + Mss54HpRamSignals.MD_IND_NE.size)
        - Mss54HpRamSignals.MD_DYN_ST.address,
} as const;

/**
 * The two-byte read the probe sends. Deliberately the smallest legal request against the window the
 * inertia run depends on: a probe that asks for more than the thing it is proving can fail for a
 * reason the real read would not have hit.
 */
export const RAM_PROBE_READS: readonly { name: string; segment: number; address: number; count: number }[] = [
    { name: 'MD_IND_NE', segment: Mss54HpRamSignals.MD_IND_NE.segment, address: Mss54HpRamSignals.MD_IND_NE.address, count: 2 },
    { name: 'MD_IND_OPT_KORR', segment: Mss54HpRamSignals.MD_IND_OPT_KORR.segment, address: Mss54HpRamSignals.MD_IND_OPT_KORR.address, count: 2 },
];

/**
 * Load-time invariants, at module scope so `npm run build` catches a bad constant.
 *
 * These matter more than a usual range check because one of the failures they prevent is silent: an
 * address outside its window makes the DME answer `0xB0`, which at least shows up, but a `count`
 * over 128 is truncated **without an error** — the decoder would then read a signal out of a short
 * buffer and get whatever the previous telegram left behind.
 */
(function assertRamMapIsConsistent() {
    for (const [name, sig] of Object.entries(Mss54HpRamSignals) as [string, RamSignal][]) {
        const w = RAM_WINDOW_LIST.find(x => x.segment === sig.segment);
        if (!w) {
            throw new Error(`Mss54HpRamSignals.${name} names segment 0x${sig.segment.toString(16)}, `
                + `which is not a declared RAM window`);
        }
        if (sig.address < w.lo || sig.address + sig.size > w.hi) {
            throw new Error(`Mss54HpRamSignals.${name} at 0x${sig.address.toString(16)} (+${sig.size}) falls outside `
                + `segment 0x${sig.segment.toString(16)} [0x${w.lo.toString(16)}, 0x${w.hi.toString(16)})`);
        }
    }
    const reads = [
        { name: 'INERTIA_RAM_READ', ...INERTIA_RAM_READ },
        ...RAM_PROBE_READS.map(r => ({ name: `RAM_PROBE_READS.${r.name}`, segment: r.segment, address: r.address, count: r.count })),
    ];
    for (const r of reads) {
        if (r.count <= 0 || r.count > RAM_READ_MAX_COUNT) {
            throw new Error(`${r.name}.count ${r.count} must be 1..${RAM_READ_MAX_COUNT} `
                + `(the DME truncates above that without erroring)`);
        }
        const w = RAM_WINDOW_LIST.find(x => x.segment === r.segment);
        if (!w || r.address < w.lo || r.address + r.count > w.hi) {
            throw new Error(`${r.name} spans outside segment 0x${r.segment.toString(16)}`);
        }
    }
    for (const sig of [Mss54HpRamSignals.MD_DYN_ST, Mss54HpRamSignals.MD_IND_NE] as RamSignal[]) {
        const covered = sig.segment === INERTIA_RAM_READ.segment
            && sig.address >= INERTIA_RAM_READ.address
            && sig.address + sig.size <= INERTIA_RAM_READ.address + INERTIA_RAM_READ.count;
        if (!covered) throw new Error('INERTIA_RAM_READ does not cover a signal the inertia poll decodes from it');
    }
})();

/**
 * Decodes one signal out of a buffer whose first byte is `bufferAddress`.
 *
 * Returns null rather than throwing when the signal is not covered, because the caller that hits
 * this is a poll loop: a short buffer should cost one sample, not the run.
 */
export function decodeRamSignal(
    signal: RamSignal,
    buffer: Uint8Array,
    bufferAddress: number,
): number | null {
    const at = signal.address - bufferAddress;
    if (at < 0 || at + signal.size > buffer.length) return null;
    let raw: number;
    if (signal.size === 1) {
        raw = buffer[at];
        if (signal.signed && raw > 0x7F) raw -= 0x100;
    } else {
        raw = (buffer[at] << 8) | buffer[at + 1];
        if (signal.signed && raw > 0x7FFF) raw -= 0x10000;
    }
    return raw * signal.scale;
}

/** True when `[address, address + count)` is entirely inside a declared window for that segment. */
export function isRamReadInRange(segment: number, address: number, count: number): boolean {
    if (count <= 0 || count > RAM_READ_MAX_COUNT) return false;
    const w = RAM_WINDOW_LIST.find(x => x.segment === segment);
    return !!w && address >= w.lo && address + count <= w.hi;
}
