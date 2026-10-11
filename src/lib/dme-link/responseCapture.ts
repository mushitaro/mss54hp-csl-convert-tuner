import { LAMBDA_RESPONSE_RAM_READ, Mss54HpRamSignals, decodeRamSignal } from './ramMap';
import { decodeOperatingMeasurementsBlock, OPERATING_MEASUREMENTS_BLOCK } from './liveValueBlocks';
import { byteLength } from './blockDecoder';

/** Optional raw evidence. Missing reads stay missing through SAVE, SYNC and CSV. */
export interface ResponseCaptureChannels {
    /** TL from block 3, before slave fuel factors; shares standardReadTime/Ms. */
    baseInjectionMs?: number;
    /** TI1..TI6 commands before injector dead time; not actual injected fuel mass. */
    injection1Ms?: number;
    injection2Ms?: number;
    injection3Ms?: number;
    injection4Ms?: number;
    injection5Ms?: number;
    injection6Ms?: number;
    injectionBlankActual?: number;
    injectionBlankTarget?: number;
    /** Separate from the earlier RAM trim: these share the TI diagnostic response. */
    injectionStft1?: number;
    injectionStft2?: number;
    injectionReadTime?: number;
    injectionReadMs?: number;
    injectionReadSource?: 'block19-0401-unverified';
    o2Precat1Mv?: number;
    o2Precat2Mv?: number;
    /** Raw LA_ST_EIN bytes. Bit 0 is controller enabled; LA_FREEZE_FLAG is different. */
    lambdaState1?: number;
    lambdaState2?: number;
    /** P steps executed by the DME. Saturates at 255; not an O2 edge count. */
    lambdaPSteps1?: number;
    lambdaPSteps2?: number;
    baFTi?: number;
    /** Host request midpoint in seconds since run start and complete request duration in ms.
     * Includes transport/retry time, not an exact ECU sampling time. */
    lambdaReadTime?: number;
    lambdaReadMs?: number;
    standardReadTime?: number;
    standardReadMs?: number;
    lambdaReadSource?: 'ram-trim' | 'ram-response-0401-unverified' | 'block19';
}

/** All-or-nothing frame validation; callers must never carry this over a missed read.
 * A host exchange brackets delivery, not an atomic ECU snapshot of all cylinders. */
export function decodeInjectionResponse(
    bytes: Uint8Array, start: number, end: number, origin: number,
): ResponseCaptureChannels {
    const window = readWindow(start, end, origin);
    // Require the fields this capture uses, not unrelated bytes at the end of block 19.
    const last = OPERATING_MEASUREMENTS_BLOCK.fields.stft2;
    if (!window || bytes.length < last.offset + byteLength(last.format)) return {};
    const op = decodeOperatingMeasurementsBlock(bytes);
    return {
        injection1Ms: op.injection1Ms ?? undefined,
        injection2Ms: op.injection2Ms ?? undefined,
        injection3Ms: op.injection3Ms ?? undefined,
        injection4Ms: op.injection4Ms ?? undefined,
        injection5Ms: op.injection5Ms ?? undefined,
        injection6Ms: op.injection6Ms ?? undefined,
        injectionBlankActual: op.injectionBlankActual ?? undefined,
        injectionBlankTarget: op.injectionBlankTarget ?? undefined,
        injectionStft1: op.stft1 ?? undefined,
        injectionStft2: op.stft2 ?? undefined,
        injectionReadTime: window.time, injectionReadMs: window.ms,
        injectionReadSource: 'block19-0401-unverified',
    };
}

export function readWindow(start: number, end: number, origin: number) {
    if (![start, end, origin].every(Number.isFinite) || start < origin || end < start) return null;
    return { time: ((start + end) / 2 - origin) / 1000, ms: end - start };
}

export function decodeLambdaResponse(
    bytes: Uint8Array, segment: number, address: number,
    start: number, end: number, origin: number,
): ResponseCaptureChannels {
    const read = LAMBDA_RESPONSE_RAM_READ;
    const window = readWindow(start, end, origin);
    if (!window || segment !== read.segment || address !== read.address || bytes.length < read.count) return {};
    const value = (name: keyof typeof Mss54HpRamSignals) => decodeRamSignal(Mss54HpRamSignals[name], bytes, address) ?? undefined;
    return {
        o2Precat1Mv: value('USV1'), o2Precat2Mv: value('USV2'),
        lambdaState1: value('LA_ST_EIN1'), lambdaState2: value('LA_ST_EIN2'),
        lambdaPSteps1: value('LA_P_SPR_COUNT1'), lambdaPSteps2: value('LA_P_SPR_COUNT2'),
        baFTi: value('BA_F_TI'), lambdaReadTime: window.time, lambdaReadMs: window.ms,
        lambdaReadSource: 'ram-response-0401-unverified',
    };
}
