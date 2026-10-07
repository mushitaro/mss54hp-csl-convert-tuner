import { Mss54HpRamSignals, decodeRamSignal } from './ramMap';
import type { LiveMeasurement } from './types';

export type RfDirectChannels = Pick<LiveMeasurement,
    'rfKorrDirect' | 'rfSollDirect' | 'rfMapIntegratorDirect'
    | 'rfKorrDirectTime' | 'rfSollDirectTime' | 'rfMapIntegratorDirectTime'
    | 'rfKorrDirectReadMs' | 'rfSollDirectReadMs' | 'rfMapIntegratorDirectReadMs'
    | 'rfDirectSource'>;

const CHANNELS = [
    { signal: Mss54HpRamSignals.RF_KORR_DIRECT, value: 'rfKorrDirect', time: 'rfKorrDirectTime', span: 'rfKorrDirectReadMs' },
    { signal: Mss54HpRamSignals.RF_SOLL_DIRECT, value: 'rfSollDirect', time: 'rfSollDirectTime', span: 'rfSollDirectReadMs' },
    { signal: Mss54HpRamSignals.RF_MAP_INTEGRATOR_DIRECT, value: 'rfMapIntegratorDirect', time: 'rfMapIntegratorDirectTime', span: 'rfMapIntegratorDirectReadMs' },
] as const;

export function isRfDirectRead(segment: number, address: number): boolean {
    return CHANNELS.some(c => c.signal.segment === segment && c.signal.address === address);
}

/** Stateless on purpose: missing/short reads cannot inherit a previous value. The
 *  acquisition window bounds transport skew; a midpoint is not atomic with block 3,
 *  the lambda read, or either of the other RAM reads. */
export function decodeRfDirect(
    bytes: Uint8Array, segment: number, address: number,
    startedMs: number, finishedMs: number, runStartedMs: number,
): RfDirectChannels {
    const channel = CHANNELS.find(c => c.signal.segment === segment && c.signal.address === address);
    if (!channel || ![startedMs, finishedMs, runStartedMs].every(Number.isFinite)
        || startedMs < runStartedMs || finishedMs < startedMs) return {};
    const value = decodeRamSignal(channel.signal, bytes, address);
    if (value === null) return {};
    return {
        [channel.value]: value,
        [channel.time]: ((startedMs + finishedMs) / 2 - runStartedMs) / 1000,
        [channel.span]: finishedMs - startedMs,
        rfDirectSource: 'ram-0401-unverified',
    };
}
