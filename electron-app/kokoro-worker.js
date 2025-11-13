const { parentPort } = require('worker_threads');
const { createKokoroEngine } = require('./kokoro-engine');

const engine = createKokoroEngine();

let currentRequestId = null;
let currentAbortController = null;

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'synthesize') {
    if (currentRequestId) {
      parentPort.postMessage({
        type: 'result',
        requestId: msg.requestId,
        ok: false,
        error: 'Worker busy',
      });
      return;
    }
    const payload = msg.payload || {};
    const audioRoot = msg.audioRoot;
    currentRequestId = msg.requestId;
    currentAbortController = new AbortController();
    try {
      const result = await engine.synthesize(payload, {
        abortSignal: currentAbortController.signal,
        audioRoot,
      });
      parentPort.postMessage({
        type: 'result',
        requestId: msg.requestId,
        ok: true,
        result,
      });
    } catch (err) {
      const aborted = !!(currentAbortController && currentAbortController.signal.aborted);
      parentPort.postMessage({
        type: 'result',
        requestId: msg.requestId,
        ok: false,
        canceled: aborted,
        error: err && err.message ? err.message : String(err),
      });
    } finally {
      currentRequestId = null;
      currentAbortController = null;
    }
  } else if (msg.type === 'cancel') {
    if (!currentRequestId || currentRequestId !== msg.requestId) {
      return;
    }
    if (currentAbortController && !currentAbortController.signal.aborted) {
      const reason = new Error('Synthesis canceled by user');
      reason.name = 'AbortError';
      currentAbortController.abort(reason);
    }
  }
});
