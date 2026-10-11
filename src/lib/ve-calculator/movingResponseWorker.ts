import type { VEMap, LogDataPoint } from '@/lib/types';
import type { VeCalcOptions } from './calculator';
import type { calculateMovingResponseTune } from './movingResponseTune';

type MovingResponseResult = ReturnType<typeof calculateMovingResponseTune>;
export interface MovingResponseRequest { map: VEMap; raw: LogDataPoint[]; options: VeCalcOptions }
export type MovingResponseReply = { result: MovingResponseResult } | { error: string };
export interface MovingResponseJob { result: Promise<MovingResponseResult | null>; cancel: () => void }

/** A replaced calculation resolves null so a STOP awaiting it cannot hang. A
 * worker failure is visible; it never falls back to a blocking or legacy solve. */
export function startMovingResponseWorker(request: MovingResponseRequest): MovingResponseJob {
    const worker = new Worker(new URL('./movingResponse.worker.ts', import.meta.url), { type: 'module' });
    let cancel = () => {};
    const result = new Promise<MovingResponseResult | null>((resolve, reject) => {
        let settled = false;
        const finish = (reply: MovingResponseReply | null) => {
            if (settled) return;
            settled = true;
            worker.terminate();
            if (reply === null) resolve(null);
            else if ('error' in reply) reject(new Error(reply.error));
            else resolve(reply.result);
        };
        cancel = () => finish(null);
        worker.onmessage = (event: MessageEvent<MovingResponseReply>) => finish(event.data);
        worker.onerror = (event) => finish({ error: event.message || '履歴解析Workerを起動できませんでした。' });
        worker.onmessageerror = () => finish({ error: '履歴解析の結果を読み込めませんでした。' });
        try { worker.postMessage(request); }
        catch (error) { finish({ error: error instanceof Error ? error.message : String(error) }); }
    });
    return { result, cancel: () => cancel() };
}
