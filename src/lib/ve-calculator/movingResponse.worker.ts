import { calculateMovingResponseTune } from './movingResponseTune';
import type { MovingResponseRequest, MovingResponseReply } from './movingResponseWorker';

// Only the finished recording is posted here. LIVE acquisition never launches
// the multi-model solve, and the main thread remains available to the DS2 link.
self.onmessage = (event: MessageEvent<MovingResponseRequest>) => {
    const { map, raw, options } = event.data;
    let reply: MovingResponseReply;
    try {
        reply = { result: calculateMovingResponseTune(map, raw, options) };
    } catch (error) {
        reply = { error: error instanceof Error ? error.message : String(error) };
    }
    self.postMessage(reply);
};
