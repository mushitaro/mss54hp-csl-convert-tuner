import Papa from 'papaparse';
import { APP_CONFIG } from '@/config/constants';
import type { LogDataPoint } from '@/lib/types';
import { PRESSURE_DECODE_TOLERANCE_MBAR } from '@/lib/dme-link/slowLane';

/**
 * Writes a log back out as the Testo-style CSV parseLogFile reads, so an exported log re-imports to
 * the same data it was exported from.
 *
 * Optional columns are emitted only if the source actually had them. That matters because the parser
 * treats a *missing* column as information: with no Lambdaintegrator 2 it copies bank 1 into stft2
 * for the calculation. It does not any more: a bank the source did not carry stays undefined all the
 * way through, so `stft1`/`stft2` are themselves what say whether a column was physically there and
 * a re-import gets back the number of banks the original had.
 *
 * Only source columns are written. correctedLoad is derived from rawLoad by the app and the parser
 * ignores it, so exporting it would just be a column that reads back as nothing.
 */
export const serializeLogFile = (points: LogDataPoint[]): string => {
    const M = APP_CONFIG.CSV_MAPPING;

    const hasBank1 = points.some(p => p.stft1 !== undefined);
    const hasBank2 = points.some(p => p.stft2 !== undefined);
    const hasTemp = points.some(p => p.coolantTemp !== undefined);
    // The two EGT-correction channels. Without these the session-log download would silently drop
    // the only two columns the rf_korr work depends on, and a re-import could never re-derive it.
    // They come from the live DS2 link rather than from a file, so this is the ONLY way they reach
    // a CSV at all.
    const hasRf = points.some(p => p.rf !== undefined);
    const hasEgt = points.some(p => p.exhaustTemp !== undefined);
    // Tank ventilation. Each column stands alone rather than sharing one flag: a DME can report the
    // valve duty and not the TEFC state bytes, and a column of blanks says something different from
    // an absent column.
    const hasTankVent = points.some(p => p.tankVent !== undefined);
    const hasTankVentCheck = points.some(p => p.tankVentCheckState !== undefined);
    const hasTankVentDiag = points.some(p => p.tankVentDiag !== undefined);
    const hasWdk1 = points.some(p => p.wdk1 !== undefined);
    const hasLambdaFreeze = points.some(p => p.lambdaFreeze !== undefined);
    const hasIntakeTemp = points.some(p => p.intakeTemp !== undefined);
    const hasChargeTemp = points.some(p => p.chargeTemp !== undefined);
    const hasAmbientPressure = points.some(p => p.ambientPressure !== undefined);
    const hasAltitude = points.some(p => p.altitude !== undefined);
    // The exception speaks, and only the exception. A healthy run never substitutes, so emitting a
    // column of zeroes on every log would push the channels that do carry something out of view for
    // a fact that is almost always the same. When it IS present, it invalidates the run.
    const hasSubstituted = points.some(p => p.ambientPressureSubstituted);
    const hasAmbientTemp = points.some(p => p.ambientTemp !== undefined);
    const hasSpeed = points.some(p => p.vehicleSpeed !== undefined);
    const hasLlsSt = points.some(p => p.llsSt !== undefined);
    // The slew limiter's five. One flag each, like every optional channel here: a drive that never
    // read them has no columns rather than five columns of blanks.
    const hasMdDynSt = points.some(p => p.mdDynSt !== undefined);
    const hasMdFw = points.some(p => p.mdFw !== undefined);
    const hasMdFwFilter = points.some(p => p.mdFwFilter !== undefined);
    const hasMdLsDelta = points.some(p => p.mdLsDelta !== undefined);
    const hasMdDpDelta = points.some(p => p.mdDpDelta !== undefined);
    const hasLtft = points.some(p => p.ltft1 !== undefined || p.ltft2 !== undefined);
    // Both exceptions. A run whose outside temperature came off CAN throughout, and whose two
    // pressure decodes agreed, says so by not having the column at all.
    const hasTempSubstituted = points.some(p => p.ambientTempFromCan === false);
    const hasDecodeGap = points.some(p =>
        (p.pressureDecodeDisagreesMbar ?? 0) > PRESSURE_DECODE_TOLERANCE_MBAR);
    // The link gaps, by the same rule: an exception column. Blank on every row but the one each gap
    // ended on, and absent from a run that never lost its link.
    const hasLinkGap = points.some(p => p.linkGapS !== undefined);
    // The ignition side, one flag per column like every channel above: a run that never read the
    // knock counters has no such columns, while one that did keeps its blank rows blank.
    const ignition = ([
        ['ignitionAngle1', M.IGNITION_ANGLE_1], ['ignitionAngle2', M.IGNITION_ANGLE_2],
        ['ignitionAngle3', M.IGNITION_ANGLE_3], ['ignitionAngle4', M.IGNITION_ANGLE_4],
        ['ignitionAngle5', M.IGNITION_ANGLE_5], ['ignitionAngle6', M.IGNITION_ANGLE_6],
        ['knockAge1', M.KNOCK_AGE_1], ['knockAge2', M.KNOCK_AGE_2], ['knockAge3', M.KNOCK_AGE_3],
        ['knockAge4', M.KNOCK_AGE_4], ['knockAge5', M.KNOCK_AGE_5], ['knockAge6', M.KNOCK_AGE_6],
        // The knock sums with the gear, and the manifold air, by the same rule. NOISE_ST goes out
        // as a plain number; only LLS_ST and MD_DYN_ST are hex, and the reader takes those back
        // by name (HEX_CSV_KEYS in parser.ts).
        ['gear', M.GEAR], ['noiseSt', M.NOISE_ST],
        ['krDtzSum', M.KR_DTZ_SUM], ['krDtzSum1', M.KR_DTZ_SUM1],
        ['kaDtzSum', M.KA_DTZ_SUM], ['kaDtzSum1', M.KA_DTZ_SUM1],
        ['rfPSaug', M.RF_P_SAUG], ['rfDiagF', M.RF_DIAG_F], ['rfKorrDme', M.RF_KORR_DME],
        ['pSaug', M.P_SAUG], ['pSaugM', M.P_SAUG_M],
        // The cams; the four status bytes as plain numbers for NOISE_ST's reason.
        ['evan1Ist', M.INTAKE_CAM], ['evanSoll', M.INTAKE_CAM_TARGET],
        ['avan1Ist', M.EXHAUST_CAM], ['avanSoll', M.EXHAUST_CAM_TARGET],
        ['evan1St', M.INTAKE_VANOS_STATUS], ['avan1St', M.EXHAUST_VANOS_STATUS],
        ['vanEdSt', M.VANOS_FAULT_STATUS], ['vanAdapSt', M.VANOS_ADAPTATION_STATUS],
    ] as const).filter(([key]) => points.some(p => p[key] !== undefined));

    const rows = points.map(p => {
        const row: Record<string, number | string> = {
            [M.TIME]: p.time,
            [M.RPM]: p.rpm,
            [M.RAW_LOAD]: p.rawLoad,
        };
        if (hasBank1) row[M.STFT_1] = p.stft1 ?? '';
        if (hasBank2) row[M.STFT_2] = p.stft2 ?? '';
        if (hasLtft) { row[M.LTFT_1] = p.ltft1 ?? ''; row[M.LTFT_2] = p.ltft2 ?? ''; }
        if (hasTemp) row[M.COOLANT_TEMP] = p.coolantTemp ?? '';
        if (hasRf) row[M.RF] = p.rf ?? '';
        if (hasEgt) row[M.EXHAUST_TEMP] = p.exhaustTemp ?? '';
        if (hasTankVent) row[M.TANK_VENT] = p.tankVent ?? '';
        if (hasTankVentCheck) row[M.TANK_VENT_CHECK] = p.tankVentCheckState ?? '';
        if (hasTankVentDiag) row[M.TANK_VENT_DIAG] = p.tankVentDiag ?? '';
        if (hasWdk1) row[M.WDK1] = p.wdk1 ?? '';
        if (hasLambdaFreeze) row[M.LAMBDA_FREEZE] = p.lambdaFreeze ?? '';
        if (hasIntakeTemp) row[M.INTAKE_TEMP] = p.intakeTemp ?? '';
        if (hasChargeTemp) row[M.CHARGE_TEMP] = p.chargeTemp ?? '';
        if (hasAmbientPressure) row[M.AMBIENT_PRESSURE] = p.ambientPressure ?? '';
        if (hasAltitude) row[M.ALTITUDE] = p.altitude ?? '';
        if (hasSubstituted) row[M.AMBIENT_PRESSURE_SUBSTITUTED] = p.ambientPressureSubstituted ? 1 : 0;
        if (hasAmbientTemp) row[M.AMBIENT_TEMP] = p.ambientTemp ?? '';
        if (hasTempSubstituted) row[M.AMBIENT_TEMP_SUBSTITUTED] = p.ambientTempFromCan === false ? 1 : 0;
        if (hasSpeed) row[M.VEHICLE_SPEED] = p.vehicleSpeed ?? '';
        // Hex, because it is a bitfield and bit 7 is the only part anyone reads. The reader parses
        // it back (HEX_CSV_KEYS in parser.ts); a hex column it does not list comes back as nothing.
        if (hasLlsSt) row[M.LLS_ST] = p.llsSt === undefined ? '' : '0x' + (p.llsSt & 0xFF).toString(16).toUpperCase().padStart(2, '0');
        // Hex for the same reason as LLS_ST — bit 6 is the whole reading.
        if (hasMdDynSt) row[M.MD_DYN_ST] = p.mdDynSt === undefined ? '' : '0x' + (p.mdDynSt & 0xFF).toString(16).toUpperCase().padStart(2, '0');
        if (hasMdFw) row[M.MD_FW] = p.mdFw ?? '';
        if (hasMdFwFilter) row[M.MD_FW_FILTER] = p.mdFwFilter ?? '';
        if (hasMdLsDelta) row[M.MD_LS_DELTA] = p.mdLsDelta ?? '';
        if (hasMdDpDelta) row[M.MD_DP_DELTA] = p.mdDpDelta ?? '';
        if (hasDecodeGap) row[M.PRESSURE_DECODE_GAP] = p.pressureDecodeDisagreesMbar ?? '';
        if (hasLinkGap) row[M.LINK_GAP] = p.linkGapS ?? '';
        for (const [key, header] of ignition) row[header] = p[key] ?? '';
        return row;
    });

    return Papa.unparse(rows, { delimiter: APP_CONFIG.CSV_DELIMITER });
};
