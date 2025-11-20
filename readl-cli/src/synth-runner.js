const path = require('path');
const { performance } = require('node:perf_hooks');

const kokoroEnginePath = path.resolve(__dirname, '..', '..', 'electron-app', 'kokoro-engine.js');
// eslint-disable-next-line import/no-dynamic-require, global-require
const { createKokoroEngine } = require(kokoroEnginePath);
const audioStorePath = path.resolve(__dirname, '..', '..', 'electron-app', 'main', 'audio-store.js');
// eslint-disable-next-line import/no-dynamic-require, global-require
const { getAudiosRoot } = require(audioStorePath);

let engineInstance = null;

function ensureEngine() {
  if (!engineInstance) {
    engineInstance = createKokoroEngine();
  }
  return engineInstance;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

async function runSynthesis(payload, { json, quiet } = {}) {
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('Payload.text is required');
  }
  const engine = ensureEngine();
  const audioRoot = getAudiosRoot();
  const abortController = new AbortController();
  const start = performance.now();

  const handleSigint = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error('Synthesis canceled via SIGINT'));
      if (!quiet && !json) {
        console.warn('Cancellation requested (Ctrl+C).');
      }
    }
  };

  process.once('SIGINT', handleSigint);

  try {
    if (!quiet && !json) {
      console.log(`Synthesizing voice=${payload.voice || 'af_heart'} lang=${payload.lang_code || 'a'} speed=${payload.speed || 1}`);
    }
    const result = await engine.synthesize(payload, {
      abortSignal: abortController.signal,
      audioRoot,
    });
    const elapsedMs = Number.isFinite(result.elapsed_ms)
      ? result.elapsed_ms
      : Math.round(performance.now() - start);

    if (json) {
      console.log(JSON.stringify({ ok: true, ...result, elapsed_ms: elapsedMs }));
    } else if (!quiet) {
      const wavPath = path.isAbsolute(result.wav_rel_path)
        ? result.wav_rel_path
        : path.join(audioRoot, result.wav_rel_path);
      const alignPath = result.align_rel_path
        ? (path.isAbsolute(result.align_rel_path)
          ? result.align_rel_path
          : path.join(audioRoot, result.align_rel_path))
        : null;
      console.log(`Saved WAV: ${wavPath}`);
      if (alignPath) console.log(`Saved alignment: ${alignPath}`);
      console.log(`Duration: ${(result.duration_seconds || 0).toFixed(2)}s (elapsed ${formatDuration(elapsedMs)})`);
    }
    return result;
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
    } else if (err && err.name === 'AbortError') {
      console.error('Synthesis canceled.');
    } else {
      console.error('Synthesis failed:', err && err.message ? err.message : err);
    }
    Object.defineProperty(err, '__readlAlreadyReported', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    throw err;
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }
}

module.exports = {
  runSynthesis,
};
