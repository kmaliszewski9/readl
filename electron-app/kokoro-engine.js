const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const { KokoroTTS, env: kokoroEnv, phonemizeDetailed: kokoroPhonemizeDetailed } = require('kokoro-js');

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
const MAX_TEXT_CHUNK_LENGTH = Number(500);
const MAX_PHONEME_TOKENS = Number(500);

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

function buildSplitRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) return null;
  try {
    return new RegExp(pattern, 'g');
  } catch (_) {
    return null;
  }
}

function fallbackSentenceSplit(text, maxLen = MAX_TEXT_CHUNK_LENGTH) {
  const sentences = String(text || '')
    .match(/[^.!?\n]+[.!?]*\s*/g);
  if (!sentences || !sentences.length) {
    return [text.trim()];
  }
  const chunks = [];
  let buffer = '';
  for (const sentence of sentences) {
    const next = buffer + sentence;
    if (next.length > maxLen && buffer.trim().length > 0) {
      chunks.push(buffer.trim());
      buffer = sentence;
      continue;
    }
    buffer = next;
  }
  if (buffer.trim().length > 0) {
    chunks.push(buffer.trim());
  }
  return chunks.length > 0 ? chunks : [text.trim()];
}

function chunkByLength(text, maxLen) {
  const result = [];
  let cursor = 0;
  const input = String(text || '');
  while (cursor < input.length) {
    const slice = input.slice(cursor, cursor + maxLen).trim();
    if (slice.length > 0) {
      result.push(slice);
    }
    cursor += maxLen;
  }
  return result.length > 0 ? result : [input.trim()];
}

function splitTextIntoChunks(text, pattern) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return [];
  const regex = buildSplitRegex(pattern);
  let parts = regex
    ? trimmed.split(regex).map(part => part.trim()).filter(part => part.length > 0)
    : [trimmed];
  if (!parts.length) {
    parts = [trimmed];
  }
  const normalized = [];
  for (const part of parts) {
    if (part.length > MAX_TEXT_CHUNK_LENGTH) {
      const fallbackParts = fallbackSentenceSplit(part);
      for (const fallbackPart of fallbackParts) {
        if (fallbackPart.length > MAX_TEXT_CHUNK_LENGTH) {
          normalized.push(...chunkByLength(fallbackPart, MAX_TEXT_CHUNK_LENGTH));
        } else {
          normalized.push(fallbackPart);
        }
      }
    } else {
      normalized.push(part);
    }
  }
  return normalized;
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

function splitSentencesPreservingWhitespace(text) {
  const segments = [];
  if (!text) return segments;
  const sentenceRegex = /[^.!?…\n]+[.!?…]+[\s]*/g;
  let match;
  let lastIndex = 0;
  while ((match = sentenceRegex.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      const gap = text.slice(lastIndex, start);
      if (gap.length > 0) segments.push(gap);
    }
    segments.push(match[0]);
    lastIndex = sentenceRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push(text.slice(lastIndex));
  }
  return segments.filter(segment => segment.length > 0);
}

function splitTextNearMiddle(text) {
  if (!text || text.length < 2) return [text, ''];
  const len = text.length;
  const mid = Math.floor(len / 2);
  const isWhitespace = /\s/;
  let splitIdx = -1;
  for (let delta = 0; delta < Math.min(40, len); delta += 1) {
    const leftIdx = mid - delta;
    if (leftIdx > 0 && isWhitespace.test(text[leftIdx])) {
      splitIdx = leftIdx;
      break;
    }
    const rightIdx = mid + delta;
    if (rightIdx < len && isWhitespace.test(text[rightIdx])) {
      splitIdx = rightIdx;
      break;
    }
  }
  if (splitIdx === -1) splitIdx = mid;
  const left = text.slice(0, splitIdx);
  const right = text.slice(splitIdx);
  return [left, right];
}

function mergeAudioSegments(rawAudios) {
  const valid = rawAudios.filter(audio => audio && audio.audio instanceof Float32Array && audio.audio.length > 0);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];
  const totalSamples = valid.reduce((sum, item) => sum + item.audio.length, 0);
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const item of valid) {
    merged.set(item.audio, offset);
    offset += item.audio.length;
  }
  const RawAudioCtor = valid[0].constructor;
  return new RawAudioCtor(merged, SAMPLE_RATE);
}

function getAudioDurationSeconds(rawAudio) {
  if (!rawAudio || !(rawAudio.audio instanceof Float32Array)) return 0;
  return rawAudio.audio.length / SAMPLE_RATE;
}

function createKokoroEngine() {
  const phonemeCountCache = new Map();
  let kokoroLoadPromise = null;
  let kokoroTtsInstance = null;

  async function getPhonemeTokenStats(text, langCode) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return { count: 0 };
    const key = `${langCode || 'a'}::${trimmed}`;
    if (phonemeCountCache.has(key)) {
      return phonemeCountCache.get(key);
    }
    const res = await kokoroPhonemizeDetailed(trimmed, langCode || 'a');
    const count = Array.isArray(res?.tokens) ? res.tokens.length : 0;
    const stats = { count };
    phonemeCountCache.set(key, stats);
    return stats;
  }

  async function forceSplitByPhonemes(text, langCode) {
    const queue = [text];
    const results = [];
    while (queue.length) {
      const current = queue.shift();
      if (!current || !current.trim()) {
        if (results.length) {
          results[results.length - 1] += current || '';
        }
        continue;
      }
      const { count } = await getPhonemeTokenStats(current, langCode);
      if (count <= MAX_PHONEME_TOKENS || current.length <= 80) {
        results.push(current);
        continue;
      }
      const [left, right] = splitTextNearMiddle(current);
      if (!left || !right || left === current || right === current) {
        results.push(current);
        continue;
      }
      queue.unshift(right, left);
    }
    return results;
  }

  async function splitChunkByPhonemeLimit(text, langCode) {
    const sentences = splitSentencesPreservingWhitespace(text);
    if (!sentences.length) return [];
    const refined = [];
    let buffer = '';
    let bufferTokens = 0;

    const flush = () => {
      if (buffer && buffer.trim().length > 0) {
        refined.push(buffer);
      }
      buffer = '';
      bufferTokens = 0;
    };

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (!trimmed) {
        buffer += sentence;
        continue;
      }
      const { count } = await getPhonemeTokenStats(trimmed, langCode);
      if (count > MAX_PHONEME_TOKENS) {
        flush();
        console.warn(`[kokoro] Sentence ${sentence.length} tokens exceeds limit, forcing split`);
        const forced = await forceSplitByPhonemes(sentence, langCode);
        forced.forEach((part) => {
          if (part && part.trim().length > 0) {
            refined.push(part);
          }
        });
        continue;
      }
      if (bufferTokens + count <= MAX_PHONEME_TOKENS) {
        buffer += sentence;
        bufferTokens += count;
      } else {
        flush();
        buffer = sentence;
        bufferTokens = count;
      }
    }
    flush();
    return refined;
  }

  async function buildPhonemeAwareChunks(text, langCode, splitPattern) {
    const coarse = splitTextIntoChunks(text, splitPattern);
    const supportsPhonemes = langCode === 'a' || langCode === 'b';
    if (!supportsPhonemes) {
      return coarse;
    }
    const refined = [];
    try {
      for (const chunk of coarse) {
        if (!chunk || !chunk.trim()) continue;
        const parts = await splitChunkByPhonemeLimit(chunk, langCode);
        if (!parts || !parts.length) continue;
        parts.forEach((part) => {
          if (part && part.trim().length > 0) {
            refined.push(part);
          }
        });
      }
    } catch (err) {
      console.warn('[kokoro] Phoneme-aware chunking failed, falling back to coarse chunks:', err && err.message ? err.message : err);
      return coarse;
    }
    return refined.length > 0 ? refined : coarse;
  }

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
    const splitPattern = typeof requestPayload?.split_pattern === 'string' && requestPayload.split_pattern.length > 0
      ? requestPayload.split_pattern
      : '\n+';
    const textChunks = await buildPhonemeAwareChunks(text, langCode, splitPattern);
    throwIfAborted(abortSignal);
    if (!textChunks.length) {
      throw new Error('No text chunks produced for synthesis');
    }
    const maxChunkLen = textChunks.reduce((max, chunk) => Math.max(max, chunk.length), 0);
    console.info(`[kokoro] Synth request length=${text.length}, chunks=${textChunks.length}, maxChunkLen=${maxChunkLen}`);
    const audioChunks = [];
    const segmentsMetadata = [];
    let cumulativeOffset = 0;
    let textIndex = 0;
    let chunkOrdinal = 0;

    for (const chunk of textChunks) {
      throwIfAborted(abortSignal);
      const segmentText = chunk.trim();
      if (!segmentText) continue;
      chunkOrdinal += 1;
      console.info(`chunk ${chunkOrdinal}/${textChunks.length} length=${segmentText.length}`);
      let chunkResult;
      try {
        chunkResult = await tts.generate(segmentText, { voice, speed });
        throwIfAborted(abortSignal);
      } catch (err) {
        console.error(`[kokoro] Chunk ${chunkOrdinal}/${textChunks.length} failed (length=${segmentText.length})`, err);
        throw err;
      }
      if (!chunkResult || !chunkResult.audio) {
        throw new Error('Kokoro returned no audio data');
      }
      audioChunks.push(chunkResult.audio);

      const durationFromTokens = deriveDurationSecondsFromTokens(chunkResult.tokens);
      const durationFromAudio = getAudioDurationSeconds(chunkResult.audio);
      let chunkDuration = Number.isFinite(durationFromAudio) && durationFromAudio > 0
        ? durationFromAudio
        : durationFromTokens;
      if (!Number.isFinite(chunkDuration) || chunkDuration <= 0) {
        chunkDuration = 0;
      }

      if (
        Array.isArray(chunkResult.tokens)
        && chunkResult.tokens.length
        && Number.isFinite(durationFromTokens)
        && durationFromTokens > 0
        && Number.isFinite(chunkDuration)
        && chunkDuration > 0
      ) {
        const timingScale = chunkDuration / durationFromTokens;
        if (Math.abs(timingScale - 1) > 1e-4) {
          chunkResult.tokens.forEach((token) => {
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
      const { tokens: serializedTokens, hasTimestamps } = serializeTokens(chunkResult.tokens, cumulativeOffset);

      const segmentMetadata = {
        text_index: textIndex,
        offset_seconds: cumulativeOffset,
        duration_seconds: safeChunkDuration,
      };
      if (serializedTokens.length > 0) {
        segmentMetadata.tokens = serializedTokens;
        if (hasTimestamps) {
          segmentMetadata.has_token_timestamps = true;
        }
      }
      segmentsMetadata.push(segmentMetadata);

      cumulativeOffset += safeChunkDuration;
      textIndex += 1;
    }

    throwIfAborted(abortSignal);
    if (!audioChunks.length) {
      throw new Error('No audio segments produced by Kokoro');
    }

    const mergedAudio = mergeAudioSegments(audioChunks);
    if (!mergedAudio) {
      throw new Error('Failed to merge Kokoro audio segments');
    }

    const savePath = buildSavePath(audioRoot, voice, langCode, text);
    ensureDirForFile(savePath);
    throwIfAborted(abortSignal);
    await mergedAudio.save(savePath);

    const durationSeconds = getAudioDurationSeconds(mergedAudio);
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
      split_pattern: splitPattern,
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
