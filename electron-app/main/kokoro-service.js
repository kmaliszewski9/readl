const path = require('path');
const { Worker } = require('worker_threads');
const { getAudiosRoot } = require('./audio-store');

function createKokoroService({ logger }) {
  const log = logger ? logger.child('kokoro') : null;
  let kokoroWorker = null;
  let activeSynthesisJob = null;

  function failActiveSynthesisJob(error) {
    if (!activeSynthesisJob) return;
    const { worker, messageHandler, reject } = activeSynthesisJob;
    worker.off('message', messageHandler);
    activeSynthesisJob = null;
    reject(error);
  }

  function attachWorkerEvents(worker) {
    worker.on('error', (err) => {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      if (log) log.error('Kokoro worker error', normalizedError);
      failActiveSynthesisJob(normalizedError);
      worker.terminate().catch(() => {});
      kokoroWorker = null;
    });

    worker.on('exit', (code) => {
      if (code !== 0 && log) {
        log.warn(`Kokoro worker exited with code ${code}`);
      }
      failActiveSynthesisJob(new Error('Kokoro worker exited'));
      kokoroWorker = null;
    });
  }

  function ensureKokoroWorker() {
    if (kokoroWorker) return kokoroWorker;
    const workerScript = path.join(__dirname, '..', 'kokoro-worker.js');
    kokoroWorker = new Worker(workerScript);
    attachWorkerEvents(kokoroWorker);
    if (log) log.info('Kokoro worker started');
    return kokoroWorker;
  }

  function run(payload = {}, webContents = null) {
    const worker = ensureKokoroWorker();
    if (activeSynthesisJob) {
      throw new Error('Synthesis already running');
    }

    const audioRoot = getAudiosRoot();

    return new Promise((resolve, reject) => {
      const messageHandler = (msg) => {
        if (!msg || typeof msg !== 'object') {
          worker.off('message', messageHandler);
          activeSynthesisJob = null;
          reject(new Error('Invalid worker response'));
          return;
        }

        // Handle progress messages without resolving/rejecting
        if (msg.type === 'progress') {
          if (webContents && !webContents.isDestroyed()) {
            const done = typeof msg.done === 'number' ? msg.done : 0;
            const total = typeof msg.total === 'number' ? msg.total : 0;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            webContents.send('kokoro-progress', { done, total, pct });
          }
          return;
        }

        // Final result or error - clean up and resolve/reject
        worker.off('message', messageHandler);
        activeSynthesisJob = null;

        if (msg.ok) {
          resolve(msg.result);
          return;
        }
        if (msg.canceled) {
          const abortError = new Error(msg.error || 'Synthesis canceled');
          abortError.name = 'AbortError';
          reject(abortError);
          return;
        }
        reject(new Error(msg.error || 'Synthesis failed'));
      };

      activeSynthesisJob = { worker, messageHandler, reject, webContents };
      worker.on('message', messageHandler);

      try {
        worker.postMessage({
          type: 'synthesize',
          payload,
          audioRoot,
        });
      } catch (err) {
        worker.off('message', messageHandler);
        activeSynthesisJob = null;
        reject(err);
      }
    });
  }

  function cancelActiveJob() {
    if (kokoroWorker && activeSynthesisJob) {
      kokoroWorker.postMessage({ type: 'cancel' });
      if (log) log.info('Requested Kokoro cancellation');
    }
  }

  async function dispose() {
    if (activeSynthesisJob) {
      failActiveSynthesisJob(new Error('Kokoro service disposed'));
    }

    const worker = kokoroWorker;
    kokoroWorker = null;
    activeSynthesisJob = null;
    if (worker) {
      try {
        await worker.terminate();
        if (log) log.info('Kokoro worker terminated');
      } catch (err) {
        if (log) log.warn('Failed to terminate Kokoro worker', err);
      }
    }
  }

  return {
    run,
    cancelActiveJob,
    dispose,
  };
}

module.exports = {
  createKokoroService,
};

