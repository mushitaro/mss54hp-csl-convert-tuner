import { LogDataPoint } from '@/lib/types';
import { EgtTables, gateOpen } from './egtTables';

/**
 * How far apart the two routes to rf_korr land, over one log.
 *
 * ## Why this number matters more than it looks
 *
 * `RF ÷ rf_soll` and `KF_RF_KORR_DRREL(rpm, Δ)` are two ways to the same table. When they agree,
 * four separate things are confirmed at once: DS2 offset 8 (RF), DS2 offset 14 (TABG), the catalog
 * addresses for both tables, and this app's reproduction of the `aq_rel → aq_rel_rf` conversion
 * that `rf_soll` is looked up with.
 *
 * When they disagree, one of those is wrong — and the failure that matters is silent. **DS2 offset
 * 8 has never been confirmed against a real DME.** It comes from the ds2_handler disassembly
 * (`puVar5[0xb..0xc] = RF`) plus two cross-checks: TMOT's index→offset mapping, which IS proven on
 * a car, and the reference Mss54Ds2Tool catalog agreeing. Good grounds — not a measurement. If it
 * turned out to point at pre-correction `rf_soll`, then `RF ÷ rf_soll` would read 1.000 for every
 * sample, the correction would vanish from the derivation, and nothing anywhere would complain.
 * The table route does not share that failure, so the comparison catches it.
 *
 * ## Only where the gate was open
 *
 * Below the filling floor BOTH routes return 1.000 by construction — `rfKorrFromEgt` because
 * annotateRfKorr reproduces the gate, and `rfKorr` because RF really is just rf_soll there. Two
 * numbers that are pinned to the same constant agree perfectly and confirm nothing.
 *
 * That is not a hypothetical. On the first real drive, over the whole log this reported a mean gap
 * of 0.0115 — a comfortable pass against the 0.02 tolerance — while over the 100 samples where the
 * DME's correction was actually running it was 0.0587, three times the tolerance. Averaging the
 * informative samples into a much larger pile of trivially-agreeing ones turned a signal into a
 * pass. So the caller passes only the samples that could disagree, and `n` says how many there
 * were: a small `n` is itself the finding, and reads as "this drive did not test the question".
 *
 * ## What a gap does NOT prove
 *
 * The two are still allowed to differ where the DME's correction was gated off by ROAD SPEED: below
 * 20 km/h the DME applies 1.000 while the table still reads high. No logged channel carries road
 * speed, so those samples cannot be excluded — which is why this reports a distribution rather than
 * a verdict, and why the caller shows the number instead of a pass/fail lamp.
 */
export interface RfKorrRouteAgreement {
    /** Samples where both routes produced a value AND the load gate was open — the only ones that
     *  could have disagreed. Small means the drive never asked the question. */
    n: number;
    meanAbsGap: number;
    maxAbsGap: number;
    /** Samples where `RF ÷ rf_soll` sat at exactly 1.000 while the table route did not. High on a
     *  drive with a lot of low-speed running — and also the signature of a wrong RF offset. */
    ratioFlatWhileTableHigh: number;
}

/** Below this the two routes are the same measurement. 0.02 is an order of magnitude above the
 *  1/1024 quantisation of the correction table and well below the ±4 % a MAP-integrator
 *  contamination would produce, so it separates "same thing" from every failure worth catching. */
export const ROUTE_AGREEMENT_TOLERANCE = 0.02;

export function rfKorrRouteAgreement(
    log: LogDataPoint[], egt?: EgtTables | null,
): RfKorrRouteAgreement | undefined {
    let n = 0, sum = 0, max = 0, flat = 0;
    for (const p of log) {
        if (p.rfKorr === undefined || p.rfKorrFromEgt === undefined) continue;
        // `egt` optional so a caller without the binary's tables still gets the old whole-log
        // number rather than nothing. It is the worse measurement, not a broken one.
        if (egt && (p.rfSoll === undefined || !gateOpen(egt, p.rpm, p.rfSoll))) continue;
        const gap = Math.abs(p.rfKorr - p.rfKorrFromEgt);
        n++;
        sum += gap;
        if (gap > max) max = gap;
        // 1e-4, not === 1: rfKorr is a ratio of two interpolated numbers and lands on 0.99998.
        if (Math.abs(p.rfKorr - 1) < 1e-4 && p.rfKorrFromEgt > 1 + ROUTE_AGREEMENT_TOLERANCE) flat++;
    }
    // Undefined rather than a zero-sample record: "they agree perfectly" and "there was nothing to
    // compare" must not render the same, and a mean over an empty set would say the first.
    if (n === 0) return undefined;
    return { n, meanAbsGap: sum / n, maxAbsGap: max, ratioFlatWhileTableHigh: flat };
}
