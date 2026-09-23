import Papa from 'papaparse';
import { APP_CONFIG } from '@/config/constants';
import type { LogDataPoint } from '@/lib/types';

type AliasKey = keyof typeof APP_CONFIG.CSV_ALIASES;

/**
 * First aliased header that carries a number on this row.
 *
 * Returns `undefined` rather than a default, because a missing column is information: the STFT
 * pair below and the whole EGT-correction path both branch on "was this channel physically
 * there", not on its value.
 */
const pick = (row: Record<string, unknown>, key: AliasKey): number | undefined => {
    for (const header of APP_CONFIG.CSV_ALIASES[key]) {
        const v = row[header];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
};

/** Median of a sample, used only to decide a unit convention. See CSV_RF_FRACTION_THRESHOLD. */
const median = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

export const parseLogFile = (csvText: string): LogDataPoint[] => {
    const { data } = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        delimiter: '', // Auto-detect delimiter (semicolon or comma)
        transformHeader: (h) => h.trim()
    });

    // Debug info
    if (data.length > 0) {
    }

    // Normalize headers to lowercase to avoid case issues (Motor Temp vs temp).
    // CSV_ALIASES is lowercase for the same reason.
    const normalizedData = (data as Record<string, unknown>[]).map(row => {
        const newRow: Record<string, unknown> = {};
        Object.keys(row).forEach(k => {
            newRow[k.toLowerCase()] = row[k];
        });
        return newRow;
    });

    /**
     * RF is REQUIRED, and this is where that is enforced.
     *
     * It used to be optional, with every consumer degrading quietly when it was absent — which put
     * a silent second methodology in the app: without RF there is no rf_korr, so `VE' = VE x STFT`
     * with the correction left baked in, which is the derivation this app deliberately does not do
     * (it goes LEAN once the exhaust temperature moves away from the log's).
     *
     * There is no good reason to design around its absence. Over DS2 it arrives in the SAME 35-byte
     * response as rpm, load and coolant — offset 8, no extra round trip — so a live run always has
     * it. A Testo CSV is the only way in that could lack it, and the answer there is to add the
     * column, not to derive a map a different way and not say so.
     *
     * Thrown rather than warned: a log that reaches the VE calculator without RF produces a
     * plausible-looking map by the wrong arithmetic, and that is the failure this app must never
     * ship. The message names the header the exporter should write.
     */
    /**
     * At least one lambda controller factor, on the same terms as RF above.
     *
     * The VE correction has exactly one input, and this is it — `NewVE = OldVE x avg(la_f_regler)`.
     * Yet a log with NEITHER bank used to parse: the bank-filling below saw both undefined and
     * substituted 1.0, which means "no correction", so the derivation ran to completion and
     * produced a map that said every cell was already perfect. Silent, plausible, and wrong in the
     * one direction nobody checks, because a map of no-change looks like a converged tune.
     *
     * ONE bank is enough and is not an error: the filling below copies it to the other, which is
     * correct — the two banks measure different cylinders of the same engine and a single-bank log
     * is a real Testo export, not a broken one. What is refused is having none.
     *
     * Testo names these `Lambdaintegrator 1` / `2`, and its own definition file puts them on DS2
     * telegram `12050B13` — selection 19, the same bytes this app decodes as `la_f_regler1/2`.
     */
    const TRIM_ALIASES = [...APP_CONFIG.CSV_ALIASES.stft1, ...APP_CONFIG.CSV_ALIASES.stft2];
    const hasTrim = normalizedData.some(row =>
        pick(row, 'stft1') !== undefined || pick(row, 'stft2') !== undefined);
    if (normalizedData.length > 0 && !hasTrim) {
        throw new Error(
            'This log has no lambda controller factor column (Testo calls it Lambdaintegrator), '
            + 'which is the only input the VE correction has. Without it every cell would come out '
            + 'as "no change", which is not a result. '
            + `Accepted header names: ${TRIM_ALIASES.join(', ')}. `
            + 'One bank is enough; a run recorded over DS2 always carries both.'
        );
    }

    const RF_ALIASES = APP_CONFIG.CSV_ALIASES.rf;
    const hasRf = normalizedData.some(row => pick(row, 'rf') !== undefined);
    if (normalizedData.length > 0 && !hasRf) {
        throw new Error(
            'This log has no RF column (the DME\'s relative filling), which the VE derivation '
            + 'needs in order to divide out rf_korr. '
            + `Accepted header names: ${RF_ALIASES.join(', ') || '(none configured)'}. `
            + 'A run recorded over DS2 always carries it; add the column to the CSV export.'
        );
    }

    const results: LogDataPoint[] = [];

    for (const row of normalizedData) {
        const time = pick(row, 'time');
        const rpm = pick(row, 'rpm');
        if (time === undefined || rpm === undefined) continue;

        // [UPDATED] If missing, leave undefined. Do not default to 95.
        // The user intentionally wants to hide/skip temp if missing.
        const coolantTemp = pick(row, 'coolantTemp');

        // Handle Lambda Legacy: logic for 1 or 2 banks (STFT)
        const raw1 = pick(row, 'stft1');
        const raw2 = pick(row, 'stft2');

        // NOT bank-filled any more. A single-bank Testo export used to have bank 1 copied into
        // bank 2 "for calculation safety", which made the calculation average one measurement with
        // itself and lost the fact that the second bank was never there. The average now takes
        // whichever banks are present, so one bank weighs once and the log still says it had one.

        const point: LogDataPoint = {
            time,
            rpm,
            rawLoad: pick(row, 'rawLoad') ?? 0,
            stft1: raw1,
            stft2: raw2,
            coolantTemp,
        };

        // RF is guaranteed present by the check above — a file that reaches here has it under one
        // of the accepted headers. It is still read per row rather than assumed, because a column
        // can be present and blank on individual rows.
        //
        // TABG is genuinely optional: without it the DME-table route for rf_korr cannot index a Δ,
        // and the app says so and offers the RF ÷ rf_soll route instead. That is a stated choice
        // with a visible consequence, not a silent change of arithmetic.
        const rf = pick(row, 'rf');
        if (rf !== undefined) point.rf = rf;
        const exhaustTemp = pick(row, 'exhaustTemp');
        if (exhaustTemp !== undefined) point.exhaustTemp = exhaustTemp;

        // Tank ventilation, read the same optional way. Assigned only when present so that a log
        // recorded before these channels existed keeps `tankVent: undefined` — "we never measured
        // it" — rather than acquiring a 0 that would read as "the valve was shut", which is a claim
        // no such log can support.
        const tankVent = pick(row, 'tankVent');
        if (tankVent !== undefined) point.tankVent = tankVent;
        const tankVentCheckState = pick(row, 'tankVentCheckState');
        if (tankVentCheckState !== undefined) point.tankVentCheckState = tankVentCheckState;
        const tankVentDiag = pick(row, 'tankVentDiag');
        if (tankVentDiag !== undefined) point.tankVentDiag = tankVentDiag;
        const wdk1 = pick(row, 'wdk1');
        if (wdk1 !== undefined) point.wdk1 = wdk1;
        const lambdaFreeze = pick(row, 'lambdaFreeze');
        if (lambdaFreeze !== undefined) point.lambdaFreeze = lambdaFreeze;

        const intakeTemp = pick(row, 'intakeTemp');
        if (intakeTemp !== undefined) point.intakeTemp = intakeTemp;
        const chargeTemp = pick(row, 'chargeTemp');
        if (chargeTemp !== undefined) point.chargeTemp = chargeTemp;
        const ambientPressure = pick(row, 'ambientPressure');
        if (ambientPressure !== undefined) point.ambientPressure = ambientPressure;
        const altitude = pick(row, 'altitude');
        if (altitude !== undefined) point.altitude = altitude;
        // Written as 1/0 by the serializer and only when some sample carried it, so an absent
        // column reads as "never happened" rather than "unknown" — which is what it means: the
        // channel is only ever SET to true. See decodeAmbientCharge.
        const substituted = pick(row, 'ambientPressureSubstituted');
        if (substituted) point.ambientPressureSubstituted = true;
        const ambientTemp = pick(row, 'ambientTemp');
        if (ambientTemp !== undefined) point.ambientTemp = ambientTemp;
        const vehicleSpeed = pick(row, 'vehicleSpeed');
        if (vehicleSpeed !== undefined) point.vehicleSpeed = vehicleSpeed;
        const llsSt = pick(row, 'llsSt');
        if (llsSt !== undefined) point.llsSt = llsSt;
        const mdDynSt = pick(row, 'mdDynSt');
        if (mdDynSt !== undefined) point.mdDynSt = mdDynSt;
        const mdFw = pick(row, 'mdFw');
        if (mdFw !== undefined) point.mdFw = mdFw;
        const mdFwFilter = pick(row, 'mdFwFilter');
        if (mdFwFilter !== undefined) point.mdFwFilter = mdFwFilter;
        const mdLsDelta = pick(row, 'mdLsDelta');
        if (mdLsDelta !== undefined) point.mdLsDelta = mdLsDelta;
        const mdDpDelta = pick(row, 'mdDpDelta');
        if (mdDpDelta !== undefined) point.mdDpDelta = mdDpDelta;
        const ltft1 = pick(row, 'ltft1');
        if (ltft1 !== undefined) point.ltft1 = ltft1;
        const ltft2 = pick(row, 'ltft2');
        if (ltft2 !== undefined) point.ltft2 = ltft2;
        const gap = pick(row, 'pressureDecodeGap');
        if (gap !== undefined) point.pressureDecodeDisagreesMbar = gap;
        // Written by the serializer only on a run where the substitution happened, so an ABSENT
        // column means "from CAN" and a present one carries the per-sample truth. Undefined stays
        // undefined: an old log knows nothing about where its outside temperature came from.
        const tUmgSub = pick(row, 'ambientTempSubstituted');
        if (tUmgSub !== undefined) point.ambientTempFromCan = !tUmgSub;
        else if (ambientTemp !== undefined) point.ambientTempFromCan = true;

        results.push(point);
    }

    normalizeRfUnits(results);

    return results;
};

/**
 * Rescales a fraction-valued RF column to the percentage the rest of the app assumes.
 *
 * Decided once for the whole file rather than per row: RF genuinely does approach 0 at closed
 * throttle, so a per-row test would multiply the idle rows of a percentage log by 100 and leave
 * the rest alone, which is worse than either convention consistently applied. Rows at or below 0
 * are excluded from the vote for the same reason — they are common in both conventions and
 * distinguish nothing.
 */
const normalizeRfUnits = (points: LogDataPoint[]): void => {
    const observed = points.map(p => p.rf).filter((v): v is number => v !== undefined && v > 0);
    const mid = median(observed);
    if (mid === null || mid >= APP_CONFIG.CSV_RF_FRACTION_THRESHOLD) return;

    for (const p of points) {
        if (p.rf !== undefined) p.rf *= 100;
    }
};
