/**
 * Everything the idle autotune needs out of the loaded binary, decoded once, all or nothing.
 *
 * Same contract as `ve-calculator/egtTables.ts`, and for the same reason: a partial decode is worse
 * than none. Every number here is a threshold that decides whether a logged `md_llri` means
 * anything, so a caller that got some of them and defaulted the rest would produce a confident
 * answer from a calibration it had not actually read. `null` means fall back — never "use a stock
 * table".
 *
 * The refusals are as load-bearing as the values. `K_LLR_Q_MCS` and `K_LLR_QSOLL_MIN` being zero is
 * what makes `LLR_QSOLL == KF_LLR_QVS_GRUND`, and therefore what makes this a one-map problem at
 * all. A binary where either is non-zero is not one this feature has been designed against, and it
 * says so rather than writing a correction into a path it does not model.
 */

import { BinaryParser } from '@/lib/binary-engine/parser';
import { findEcuItem } from '@/lib/ecu-items/catalog';
import type { EcuItemDef } from '@/lib/ecu-items/types';

export interface IdleMap2d { x: number[]; y: number[]; values: number[][] }

export interface IdleTables {
    /** `KF_LLR_QVS_GRUND` — the feedforward. x = rpm, y = TMOT, values[y][x] in kg/h. */
    qvs: IdleMap2d;
    /** The physical size of one raw step of `qvs`, kg/h. 8-bit `x/2`, so 0.5 — and that is the
     *  floor on how finely anything can correct this map. Derived from the def, not written here,
     *  because a different calibration could store it differently. */
    qvsStepKgH: number;
    /** `KF_LLS_TV` — the actuator model. x = rpm, y = requested kg/h, values in %. Read, never
     *  written: it is how the valve behaves, not what it is asked for. */
    llsTv: IdleMap2d;
    /** One raw step of `llsTv`, in duty per cent. Stored `x/50`, so 0.02 — and since the correction
     *  now WRITES this map, that is the floor on how finely it can move the valve. Derived from the
     *  def rather than written here, for the reason `qvsStepKgH` is. */
    llsTvStepPct: number;
    /**
     * The air request below which the valve stops responding, kg/h.
     *
     * `KF_LLS_TV`'s first y breakpoint, where the whole row equals `K_LLS_TV_MIN` — so any request
     * below it produces the same duty as the request at it. This is the hard floor on a downward
     * correction, and it is COMPUTED from the two of them rather than stated, because a binary
     * whose first row is not at the rail would put the floor somewhere else.
     */
    qvsAuthorityFloorKgH: number;
    tvMin: number;
    tvMax: number;
    tvNotlaufMin: number;
    tvNotlaufMax: number;
    /**
     * Where the governor is DESIGNED to rest its I term: `-K_LFR_MDADAPT_OFFSET`, so -7.0 Nm stock.
     *
     * Not zero, and the single most consequential number in this file. Targeting zero would read a
     * correctly calibrated engine as 7 Nm short, and 7 Nm at this operating point is more air than
     * the entire request. Grade: funktionsrahmen-only.
     */
    idleTargetNm: number;
    /**
     * Every clamp `md_llri` could stop against, as one widest [min, max] plus the individual pairs.
     *
     * Three pairs reference it and their order of application is not recovered from the binary, so
     * nothing here picks one. A log that stops at 50 means something different from one that stops
     * at 60 or 80, and the panel reports which value it actually stopped at rather than asserting
     * which clamp won.
     */
    mdLlriRails: number[];
    mdLlriRange: { min: number; max: number };
    /** `K_LLR_Q_MCS` and `K_LLR_QSOLL_MIN`. Both must be 0 — see the header. */
    qMcs: number;
    qSollMin: number;
    /**
     * `K_LFR_EGAS_ABW` — how far actual throttle may sit from commanded before the idle governor
     * leaves its settled state, %. Past it `KF_LFR_DQI` stops integrating and `lfra_adapt` stops
     * adapting, so a dwell recorded past it is measuring a controller that is not running.
     */
    egasAbwPct: number;
    /** `K_FR_EDK_DIFF` — the same difference at a wider threshold, %. Past it the filling regulator
     *  freezes `FR_REG_I` at whatever multiplicative correction it had, up to +/-20 %. */
    frEdkDiffPct: number;

    /** `K_EVAN1_SOLL_MAX` — the intake cam target's upper clamp, degKW, and the angle warm idle
     *  actually commands. This is what a healthy `EVAN1_IST` reads. */
    evanSollMaxDegKw: number;
    /** `K_EVAN1_DRUCK` — where the intake cam is commanded until the oil-pressure latch arms, and
     *  where it stays forever if the latch never does. What an unhealthy `EVAN1_IST` reads. */
    evanDruckDegKw: number;
    /**
     * The latch threshold, DERIVED as `K_EVAN1_DRUCK + K_EVAN1_DRUCK_HYS` rather than stated.
     *
     * That is what the slave does at runtime 0x0244A8-0x0244C6: it adds the two constants, compares
     * `EVAN1_IST_FILT` against the sum, and sets `EVAN1_ST` bit 3 only when the cam is at or below
     * it. Deriving it means a binary with different constants moves the threshold — the whole
     * reason these are read rather than quoted.
     */
    evanLatchThresholdDegKw: number;

    /**
     * Whether `KF_LLS_TV`'s first row really is railed at `K_LLS_TV_MIN` at every rpm.
     *
     * When it is, `qvsAuthorityFloorKgH` is a measured fact: below that breakpoint the valve gives
     * the same duty whatever it is asked for. When it is NOT, the floor is somewhere else and this
     * number is an upper bound on it rather than the thing itself.
     *
     * This used to REFUSE the whole calibration, and that was disproportionate. The idle run
     * measures `MD_LLRI`; the floor decides how far a correction may walk DOWN, and the write is
     * sealed, so refusing to measure over it blocked everything to protect a number nothing was
     * about to use. The car this was reported from is exactly that case — its first row is not
     * railed, and the tool answered by hiding START IDLE with no way forward.
     *
     * So it is carried instead, and the preflight flags its own floor test as an inference when it
     * is false. Degrading a verdict is not the same as papering over a refusal: the number still
     * says what it is.
     */
    authorityFloorIsRailed: boolean;
}

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readConst(parser: BinaryParser, symbol: string): number | null {
    const def = findEcuItem(symbol);
    if (!def || def.kind !== 'constant') return null;
    const v = parser.readItem(def);
    return v && v.kind === 'constant' ? num(v.value) : null;
}

function readMap(parser: BinaryParser, symbol: string): IdleMap2d | null {
    const def = findEcuItem(symbol);
    if (!def || def.kind !== 'map') return null;
    const v = parser.readItem(def);
    if (!v || v.kind !== 'map') return null;
    return { x: v.x, y: v.y, values: v.values };
}

/** The physical size of one raw LSB of a map's values, at the bottom of its range. */
function stepOf(def: EcuItemDef): number | null {
    if (def.kind !== 'map') return null;
    const s = def.values.scaling;
    return Math.abs(s.toPhysical(1) - s.toPhysical(0));
}

function ascending(a: number[]): boolean {
    return a.length > 1 && a.every((v, i) => i === 0 || v > a[i - 1]);
}

/**
 * Shape and range checks, in the spirit of `egtTables.isPlausible`.
 *
 * These are not defensive noise. Each one is a fingerprint of the table being what its address says
 * it is, and the cheapest moment to find out that an address moved between calibrations is before a
 * correction is derived from it rather than after it is flashed.
 */
function describeImplausible(t: IdleTables): string | null {
    if (!ascending(t.qvs.x) || !ascending(t.qvs.y)) return 'KF_LLR_QVS_GRUND has a non-ascending axis';
    if (!ascending(t.llsTv.x) || !ascending(t.llsTv.y)) return 'KF_LLS_TV has a non-ascending axis';
    if (t.qvs.values.length !== t.qvs.y.length
        || t.qvs.values.some(r => r.length !== t.qvs.x.length)) return 'KF_LLR_QVS_GRUND is not the shape its axes describe';
    if (t.llsTv.values.length !== t.llsTv.y.length
        || t.llsTv.values.some(r => r.length !== t.llsTv.x.length)) return 'KF_LLS_TV is not the shape its axes describe';
    // An 8-bit x/2 map cannot exceed 127.5, and an idle air request that reads 0 anywhere is not an
    // air request.
    if (t.qvs.values.some(r => r.some(v => !(v > 0 && v <= 127.5)))) return 'KF_LLR_QVS_GRUND holds a value outside 0-127.5 kg/h';
    if (t.llsTv.values.some(r => r.some(v => !(v >= 0 && v <= 100)))) return 'KF_LLS_TV holds a duty outside 0-100 %';
    if (!(t.tvMin > 0 && t.tvMin < t.tvMax && t.tvMax <= 100)) return `K_LLS_TV_MIN/MAX (${t.tvMin}/${t.tvMax}) are not a usable duty range`;
    if (!(t.qvsStepKgH > 0 && t.qvsStepKgH <= 5)) return `KF_LLR_QVS_GRUND's step is ${t.qvsStepKgH} kg/h`;
    if (!(t.llsTvStepPct > 0 && t.llsTvStepPct <= 1)) return `KF_LLS_TV's step is ${t.llsTvStepPct} %`;
    // The resting point is a torque, and one this governor can actually hold.
    if (!(t.idleTargetNm > t.mdLlriRange.min && t.idleTargetNm < t.mdLlriRange.max)) {
        return `the resting torque ${t.idleTargetNm} Nm is outside the governor's own rails `
            + `(${t.mdLlriRange.min}..${t.mdLlriRange.max})`;
    }
    if (!(t.mdLlriRange.min < 0 && t.mdLlriRange.max > 0)) return 'the governor rails do not straddle zero';
    // The VANOS latch only means what the preflight says it means if the threshold sits strictly
    // BETWEEN the pressure-check angle and the idle command. That ordering IS the mechanism: the cam
    // must be able to reach the threshold from below while parked at K_EVAN1_DRUCK, and must NOT
    // reach it while parked at K_EVAN1_SOLL_MAX. A binary where it does not hold describes a
    // different latch, and refusing beats reporting a verdict about this one.
    if (!(t.evanDruckDegKw < t.evanLatchThresholdDegKw
        && t.evanLatchThresholdDegKw < t.evanSollMaxDegKw)) {
        return `the VANOS latch threshold ${t.evanLatchThresholdDegKw} degKW does not sit between `
            + `K_EVAN1_DRUCK (${t.evanDruckDegKw}) and K_EVAN1_SOLL_MAX (${t.evanSollMaxDegKw})`;
    }
    return null;
}


/**
 * Decode, or `null`.
 *
 * `null` here is the whole reason the idle tab can be disabled with a reason instead of showing a
 * plausible correction derived from thresholds nobody read.
 */
/**
 * Why a binary was refused, or null when it was accepted.
 *
 * This exists because the refusal used to be invisible. `readIdleTables` returning null makes the
 * hub fall back to READ, and the hub is the only thing that reports it — so a driver with an image
 * this cannot read saw a button that said READ after they had just read, forever, with no screen
 * anywhere saying which byte was the problem. That is the same defect as a bare `claimInterface`
 * DOMException: technically a refusal, operationally a dead end.
 *
 * The refusals themselves are unchanged and stay all-or-nothing. Reading nine of ten thresholds and
 * carrying on would put a number the binary did not supply into a verdict about somebody's engine.
 * What changes is that each one now says what it was.
 */
export type IdleTablesRefusal = string | null;

export function readIdleTables(buffer: ArrayBuffer): IdleTables | null {
    const r = readIdleTablesResult(buffer);
    return r.ok ? r.tables : null;
}

/** The same read, with the reason kept. `readIdleTables` is the thin wrapper over it. */
export function readIdleTablesResult(buffer: ArrayBuffer):
    { ok: true; tables: IdleTables } | { ok: false; reason: string } {
    const no = (reason: string) => ({ ok: false as const, reason });
    let parser: BinaryParser;
    try { parser = new BinaryParser(buffer); } catch { return no('the image could not be parsed at all'); }

    const qvs = readMap(parser, 'KF_LLR_QVS_GRUND');
    const llsTv = readMap(parser, 'KF_LLS_TV');
    const qvsDef = findEcuItem('KF_LLR_QVS_GRUND');
    if (!qvs) return no('KF_LLR_QVS_GRUND could not be decoded');
    if (!llsTv) return no('KF_LLS_TV could not be decoded');
    if (!qvsDef) return no('KF_LLR_QVS_GRUND is missing from the item catalog');
    const qvsStepKgH = stepOf(qvsDef);
    if (qvsStepKgH === null) return no('KF_LLR_QVS_GRUND has no usable quantisation step');
    const llsTvDef = findEcuItem('KF_LLS_TV');
    if (!llsTvDef) return no('KF_LLS_TV is missing from the item catalog');
    const llsTvStepPct = stepOf(llsTvDef);
    if (llsTvStepPct === null) return no('KF_LLS_TV has no usable quantisation step');

    const tvMin = readConst(parser, 'K_LLS_TV_MIN');
    const tvMax = readConst(parser, 'K_LLS_TV_MAX');
    const tvNotlaufMin = readConst(parser, 'K_LLS_TV_NOTLAUF_MIN');
    const tvNotlaufMax = readConst(parser, 'K_LLS_TV_NOTLAUF_MAX');
    const adaptOffset = readConst(parser, 'K_LFR_MDADAPT_OFFSET');
    const qMcs = readConst(parser, 'K_LLR_Q_MCS');
    const qSollMin = readConst(parser, 'K_LLR_QSOLL_MIN');
    const egasAbwPct = readConst(parser, 'K_LFR_EGAS_ABW');
    const frEdkDiffPct = readConst(parser, 'K_FR_EDK_DIFF');
    const evanSollMax = readConst(parser, 'K_EVAN1_SOLL_MAX');
    const evanDruck = readConst(parser, 'K_EVAN1_DRUCK');
    const evanDruckHys = readConst(parser, 'K_EVAN1_DRUCK_HYS');
    const rails = ['K_LFR_MD_REG_MIN', 'K_LFR_MD_REG_MAX', 'K_LFR_MDREG_MIN', 'K_LFR_MDREG_MAX',
        'K_LFR_ED_MDREG_MIN', 'K_LFR_ED_MDREG_MAX'].map(s => readConst(parser, s));

    // Named one by one rather than tested as a set: "one of these twenty was missing" is what the
    // old all-or-nothing check reported, and it is not enough to act on.
    const named: [string, number | null][] = [
        ['K_LLS_TV_MIN', tvMin], ['K_LLS_TV_MAX', tvMax],
        ['K_LLS_TV_NOTLAUF_MIN', tvNotlaufMin], ['K_LLS_TV_NOTLAUF_MAX', tvNotlaufMax],
        ['K_LFR_MDADAPT_OFFSET', adaptOffset], ['K_LLR_Q_MCS', qMcs], ['K_LLR_QSOLL_MIN', qSollMin],
        ['K_LFR_EGAS_ABW', egasAbwPct], ['K_FR_EDK_DIFF', frEdkDiffPct],
        ['K_EVAN1_SOLL_MAX', evanSollMax], ['K_EVAN1_DRUCK', evanDruck],
        ['K_EVAN1_DRUCK_HYS', evanDruckHys],
        ...rails.map((v, i) => [['K_LFR_MD_REG_MIN', 'K_LFR_MD_REG_MAX', 'K_LFR_MDREG_MIN',
            'K_LFR_MDREG_MAX', 'K_LFR_ED_MDREG_MIN', 'K_LFR_ED_MDREG_MAX'][i], v] as [string, number | null]),
    ];
    const missing = named.filter(([, v]) => v === null).map(([n]) => n);
    if (missing.length) return no(`could not read ${missing.join(', ')}`);

    // The premise, checked rather than assumed. Anything else means LLR_QSOLL is not LLR_QVS and
    // this feature does not describe the binary in front of it.
    if (qMcs !== 0 || qSollMin !== 0) {
        return no(`K_LLR_Q_MCS is ${qMcs} and K_LLR_QSOLL_MIN is ${qSollMin}; this feature assumes both are 0`);
    }

    const railValues = rails as number[];
    const tables: IdleTables = {
        qvs, qvsStepKgH, llsTv, llsTvStepPct,
        qvsAuthorityFloorKgH: llsTv.y[0],
        tvMin: tvMin as number,
        tvMax: tvMax as number,
        tvNotlaufMin: tvNotlaufMin as number,
        tvNotlaufMax: tvNotlaufMax as number,
        idleTargetNm: -(adaptOffset as number),
        mdLlriRails: railValues,
        mdLlriRange: { min: Math.min(...railValues), max: Math.max(...railValues) },
        qMcs: qMcs as number,
        qSollMin: qSollMin as number,
        egasAbwPct: egasAbwPct as number,
        frEdkDiffPct: frEdkDiffPct as number,
        evanSollMaxDegKw: evanSollMax as number,
        evanDruckDegKw: evanDruck as number,
        evanLatchThresholdDegKw: (evanDruck as number) + (evanDruckHys as number),
        authorityFloorIsRailed: false,
    };

    // The authority floor is only a floor if the row at it really is railed. If it is not, this
    // binary's valve responds below that breakpoint and the floor belongs somewhere else — which is
    // a fact worth refusing over rather than papering over with the wrong number.
    // Recorded, not refused. See `authorityFloorIsRailed`.
    const firstRow = llsTv.values[0] ?? [];
    tables.authorityFloorIsRailed =
        firstRow.length > 0 && firstRow.every(v => Math.abs(v - tables.tvMin) <= 0.05);

    const implausible = describeImplausible(tables);
    if (implausible) return no(implausible);
    return { ok: true, tables };
}

/** Bilinear lookup with edge clamping, on the axes as read from the binary. */
/**
 * Bilinear between breakpoints, clamped outside them — `kfu_wint`'s behaviour.
 *
 * Exported because `valveModel.ts` needs the same lookup to compare the map against the duty the
 * DME ran, and a second implementation of a table lookup is the drift this file already avoids
 * once by having `qvsAt` and `llsTvAt` share it.
 */
export function interp2d(m: IdleMap2d, x: number, y: number): number {
    const bracket = (axis: number[], v: number) => {
        if (v <= axis[0]) return { i0: 0, i1: 0, w: 0 };
        const last = axis.length - 1;
        if (v >= axis[last]) return { i0: last, i1: last, w: 0 };
        let i = 0;
        while (i < last && axis[i + 1] < v) i++;
        const span = axis[i + 1] - axis[i];
        return { i0: i, i1: i + 1, w: span === 0 ? 0 : (v - axis[i]) / span };
    };
    const bx = bracket(m.x, x);
    const by = bracket(m.y, y);
    const top = m.values[by.i0][bx.i0] * (1 - bx.w) + m.values[by.i0][bx.i1] * bx.w;
    const bot = m.values[by.i1][bx.i0] * (1 - bx.w) + m.values[by.i1][bx.i1] * bx.w;
    return top * (1 - by.w) + bot * by.w;
}

/** The air the feedforward asks for at this operating point, kg/h. */
export function qvsAt(t: IdleTables, rpm: number, tmot: number): number {
    return interp2d(t.qvs, rpm, tmot);
}

/** The duty the valve is commanded for a given request, %. Before the PT1 and before the rails. */
export function llsTvAt(t: IdleTables, rpm: number, qsoll: number): number {
    return interp2d(t.llsTv, rpm, qsoll);
}

/** Is the logged duty sitting on the limp-home branch rather than a normal rail? */
export function isLimpDuty(t: IdleTables, duty: number, tolerance = 0.2): boolean {
    return Math.abs(duty - t.tvNotlaufMin) <= tolerance || Math.abs(duty - t.tvNotlaufMax) <= tolerance;
}

/** Is `md_llri` parked on any clamp the binary defines? Reported, never silently clipped. */
export function railedRailFor(t: IdleTables, mdLlri: number, tolerance = 0.5): number | null {
    for (const r of t.mdLlriRails) if (Math.abs(mdLlri - r) <= tolerance) return r;
    return null;
}
