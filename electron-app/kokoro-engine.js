const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { KokoroTTS, env: kokoroEnv } = require('kokoro-js');

const SAMPLE_RATE = 24000;
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_KOKORO_MODEL_ID = process.env.READL_KOKORO_MODEL_ID || 'kmaliszewski/Kokoro-82M-v1.0-ONNX';
const DEFAULT_KOKORO_DEVICE = (() => {
  const raw = process.env.READL_KOKORO_DEVICE;
  return raw && raw.trim().length > 0 ? raw.trim() : 'cpu';
})();
const DEFAULT_KOKORO_DTYPE = process.env.READL_KOKORO_DTYPE || 'fp32';
const DEFAULT_KOKORO_CACHE_DIR = (() => {
  const raw = process.env.READL_KOKORO_CACHE_DIR;
  return raw && raw.trim().length > 0 ? path.resolve(raw.trim()) : path.join(repoRoot, '.kokoro-cache');
})();
function getAbortError(signal) {
  if (!signal || !signal.aborted) return null;
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error(reason ? String(reason) : 'Synthesis canceled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  const err = getAbortError(signal);
  if (err) {
    throw err;
  }
}

function ensureDir(dirPath) {
  if (!dirPath) return;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (_) {}
}

function ensureDirForFile(filePath) {
  if (!filePath) return;
  ensureDir(path.dirname(filePath));
}

function pad(num, size = 2) {
  return String(num).padStart(size, '0');
}

function slugifyForFile(text) {
  if (!text) return 'tts';
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const safe = normalized.replace(/[^a-z0-9\-\_ ]+/g, '').replace(/\s+/g, '-');
  return safe.length > 0 ? safe.slice(0, 60) : 'tts';
}

function buildSavePath(audioRoot, voice, langCode, text) {
  const root = audioRoot;
  const now = new Date();
  const dayDir = path.join(root, now.toISOString().slice(0, 10));
  ensureDir(dayDir);
  const timestamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  const safeVoice = (voice || 'af_heart').trim().replace(/\s+/g, '_') || 'af_heart';
  const safeLang = (langCode || 'a').trim().replace(/\s+/g, '_') || 'a';
  const preview = slugifyForFile((text || '').slice(0, 80));
  const base = `${timestamp}_${safeVoice}_${safeLang}`;
  const filename = preview ? `${base}_${preview}.wav` : `${base}.wav`;
  return path.join(dayDir, filename);
}

function deriveDurationSecondsFromTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return 0;
  let max = 0;
  for (const token of tokens) {
    if (token && typeof token.end_ts === 'number' && Number.isFinite(token.end_ts)) {
      const end = Number(token.end_ts);
      if (end > max) max = end;
    }
  }
  return max;
}

function serializeTokens(tokens, offsetSeconds = 0) {
  const serialized = [];
  let hasTimestamps = false;
  if (!Array.isArray(tokens)) {
    return { tokens: serialized, hasTimestamps };
  }
  tokens.forEach((token, idx) => {
    if (!token) return;
    const entry = {
      index: typeof token.index === 'number' ? token.index : idx,
      text: typeof token.text === 'string' ? token.text : '',
    };
    if (typeof token.phonemes === 'string' && token.phonemes.length > 0) {
      entry.phonemes = token.phonemes;
    }
    if (typeof token.start_ts === 'number' && Number.isFinite(token.start_ts)) {
      entry.start_ts = Number(token.start_ts) + offsetSeconds;
      hasTimestamps = true;
    }
    if (typeof token.end_ts === 'number' && Number.isFinite(token.end_ts)) {
      entry.end_ts = Number(token.end_ts) + offsetSeconds;
      hasTimestamps = true;
    }
    serialized.push(entry);
  });
  return { tokens: serialized, hasTimestamps };
}

function clampSpeedValue(value) {
  if (!Number.isFinite(value)) return 1;
  if (value < 0.5) return 0.5;
  if (value > 1.5) return 1.5;
  return value;
}

function formatIsoSeconds(date = new Date()) {
  return date.toISOString().split('.')[0];
}

function getAudioDurationSeconds(rawAudio) {
  if (!rawAudio || !(rawAudio.audio instanceof Float32Array)) return 0;
  return rawAudio.audio.length / SAMPLE_RATE;
}

function createKokoroEngine() {
  let kokoroLoadPromise = null;
  let kokoroTtsInstance = null;

  async function loadKokoroTts() {
    if (kokoroTtsInstance) return kokoroTtsInstance;
    if (!kokoroLoadPromise) {
      kokoroLoadPromise = (async () => {
        ensureDir(DEFAULT_KOKORO_CACHE_DIR);
        if (kokoroEnv && typeof kokoroEnv === 'object' && 'cacheDir' in kokoroEnv) {
          kokoroEnv.cacheDir = DEFAULT_KOKORO_CACHE_DIR;
        }
        const device = DEFAULT_KOKORO_DEVICE && DEFAULT_KOKORO_DEVICE.trim().length > 0
          ? DEFAULT_KOKORO_DEVICE.trim()
          : null;
        return KokoroTTS.from_pretrained(DEFAULT_KOKORO_MODEL_ID, {
          dtype: DEFAULT_KOKORO_DTYPE,
          device,
          session_options: {
            enableCpuMemArena: false,
          },
        });
      })()
        .then((tts) => {
          kokoroTtsInstance = tts;
          return tts;
        })
        .catch((err) => {
          kokoroLoadPromise = null;
          throw err;
        });
    }
    return kokoroLoadPromise;
  }

  async function synthesizeWithKokoro(requestPayload, { abortSignal, audioRoot }) {
    const synthStart = performance.now();
    throwIfAborted(abortSignal);
    const originalText = typeof requestPayload?.text === 'string' ? requestPayload.text : '';
    const text = originalText.trim();
    if (!text) {
      throw new Error('Text is required');
    }
    const voice = typeof requestPayload?.voice === 'string' && requestPayload.voice
      ? requestPayload.voice
      : 'af_heart';
    const langCode = typeof requestPayload?.lang_code === 'string' && requestPayload.lang_code
      ? requestPayload.lang_code
      : 'a';
    const speed = clampSpeedValue(Number(requestPayload?.speed));

    throwIfAborted(abortSignal);
    const tts = await loadKokoroTts();
    throwIfAborted(abortSignal);
    console.info(`[kokoro] Synth request length=${text.length}`);
    const textPreview = JSON.stringify(text);
    console.info(`[kokoro] full text length=${text.length} text=${textPreview}`);

    let synthResult;
    try {
      synthResult = await tts.generate(text, { voice, speed });
      throwIfAborted(abortSignal);
    } catch (err) {
      console.error('[kokoro] Synthesis failed', err);
      throw err;
    }
    if (!synthResult || !synthResult.audio) {
      throw new Error('Kokoro returned no audio data');
    }

    const segmentsMetadata = [];
    const durationFromTokens = deriveDurationSecondsFromTokens(synthResult.tokens);
    const durationFromAudio = getAudioDurationSeconds(synthResult.audio);
    let chunkDuration = Number.isFinite(durationFromAudio) && durationFromAudio > 0
      ? durationFromAudio
      : durationFromTokens;
    if (!Number.isFinite(chunkDuration) || chunkDuration <= 0) {
      chunkDuration = 0;
    }

    if (
      Array.isArray(synthResult.tokens)
      && synthResult.tokens.length
      && Number.isFinite(durationFromTokens)
      && durationFromTokens > 0
      && Number.isFinite(chunkDuration)
      && chunkDuration > 0
    ) {
      const timingScale = chunkDuration / durationFromTokens;
      if (Math.abs(timingScale - 1) > 1e-4) {
        synthResult.tokens.forEach((token) => {
          if (!token) return;
          if (typeof token.start_ts === 'number' && Number.isFinite(token.start_ts)) {
            token.start_ts = Number(token.start_ts) * timingScale;
          }
          if (typeof token.end_ts === 'number' && Number.isFinite(token.end_ts)) {
            token.end_ts = Number(token.end_ts) * timingScale;
          }
        });
      }
    }

    const safeChunkDuration = Number.isFinite(chunkDuration) && chunkDuration > 0 ? chunkDuration : 0;
    const { tokens: serializedTokens, hasTimestamps } = serializeTokens(synthResult.tokens, 0);

    const segmentMetadata = {
      text_index: 0,
      offset_seconds: 0,
      duration_seconds: safeChunkDuration,
    };
    if (serializedTokens.length > 0) {
      segmentMetadata.tokens = serializedTokens;
      if (hasTimestamps) {
        segmentMetadata.has_token_timestamps = true;
      }
    }
    segmentsMetadata.push(segmentMetadata);

    throwIfAborted(abortSignal);

    const savePath = buildSavePath(audioRoot, voice, langCode, text);
    ensureDirForFile(savePath);
    throwIfAborted(abortSignal);
    await synthResult.audio.save(savePath);

    const durationSeconds = getAudioDurationSeconds(synthResult.audio);
    const generationMs = Math.max(0, Math.round(performance.now() - synthStart));
    const generationSeconds = generationMs / 1000;
    console.info(`[kokoro] Synthesis completed in ${generationSeconds.toFixed(2)}s`);

    const alignPath = savePath.replace(/\.wav$/i, '') + '.align.ndjson';
    const header = {
      type: 'header',
      version: 1,
      created_at: formatIsoSeconds(),
      sample_rate: SAMPLE_RATE,
      duration_seconds: durationSeconds,
      wav_rel_path: null,
      voice,
      speed,
      lang_code: langCode,
      text: originalText,
      preview_html: requestPayload?.preview_html,
      source_kind: requestPayload?.source_kind,
      source_url: requestPayload?.source_url,
      raw_content: requestPayload?.raw_content,
      raw_content_type: requestPayload?.raw_content_type,
      title: requestPayload?.title,
      has_token_timestamps: segmentsMetadata.some(seg => seg.has_token_timestamps),
      generation_ms: generationMs,
    };

    let wavRelPath = path.relative(audioRoot, savePath);
    if (!wavRelPath || wavRelPath.startsWith('..')) {
      wavRelPath = savePath;
    }
    header.wav_rel_path = wavRelPath;

    const lines = [
      JSON.stringify(header),
      ...segmentsMetadata.map(segment => JSON.stringify({ type: 'segment', ...segment })),
    ];
    throwIfAborted(abortSignal);
    fs.writeFileSync(alignPath, lines.join('\n') + '\n', 'utf8');

    let alignRelPath = path.relative(audioRoot, alignPath);
    if (!alignRelPath || alignRelPath.startsWith('..')) {
      alignRelPath = alignPath;
    }

    return {
      wav_rel_path: wavRelPath,
      align_rel_path: alignRelPath,
      duration_seconds: durationSeconds,
      sample_rate: SAMPLE_RATE,
      elapsed_ms: generationMs,
    };
  }

  return {
    synthesize: synthesizeWithKokoro,
  };
}

module.exports = {
  SAMPLE_RATE,
  createKokoroEngine,
};
