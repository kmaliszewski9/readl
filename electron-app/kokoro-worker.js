const { parentPort } = require('worker_threads');
const { createKokoroEngine } = require('./kokoro-engine');

const engine = createKokoroEngine();

let currentAbortController = null;
let synthInFlight = false;

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'synthesize') {
    if (synthInFlight) {
      parentPort.postMessage({
        ok: false,
        error: 'Worker busy',
      });
      return;
    }
    synthInFlight = true;
    const payload = msg.payload || {};
    const audioRoot = msg.audioRoot;
    currentAbortController = new AbortController();
    try {
      const result = await engine.synthesize(payload, {
        abortSignal: currentAbortController.signal,
        audioRoot,
      });
      parentPort.postMessage({
        ok: true,
        result,
      });
    } catch (err) {
      const aborted = !!(currentAbortController && currentAbortController.signal.aborted);
      parentPort.postMessage({
        ok: false,
        canceled: aborted,
        error: err && err.message ? err.message : String(err),
      });
    } finally {
      synthInFlight = false;
      currentAbortController = null;
    }
  } else if (msg.type === 'cancel') {
    if (currentAbortController && !currentAbortController.signal.aborted) {
      const reason = new Error('Synthesis canceled by user');
      reason.name = 'AbortError';
      currentAbortController.abort(reason);
    }
  }
});
