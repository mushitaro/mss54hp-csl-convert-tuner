import { LAMBDA_RESPONSE_RAM_READ, Mss54HpRamSignals, decodeRamSignal } from './ramMap';

/** Optional raw evidence. Missing reads stay missing through SAVE, SYNC and CSV. */
export interface ResponseCaptureChannels {
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
