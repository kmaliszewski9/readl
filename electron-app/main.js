const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { performance } = require('node:perf_hooks');
const { KokoroTTS, env: kokoroEnv, phonemizeDetailed: kokoroPhonemizeDetailed } = require('kokoro-js');

// Register IPC handler early to avoid race conditions
try { ipcMain.removeHandler('open-file-dialog'); } catch (e) {}
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['html', 'htm', 'txt', 'pdf'] }
    ]
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    if (/\.pdf$/i.test(filePath)) {
      const buf = fs.readFileSync(filePath);
      return { canceled: false, filePath, contentBase64: buf.toString('base64'), contentType: 'application/pdf' };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { canceled: false, filePath, content };
  } catch (err) {
    return { canceled: true, error: err.message };
  }
});

// Fetch remote URL contents (bypasses renderer CORS)
try { ipcMain.removeHandler('fetch-url'); } catch (e) {}
ipcMain.handle('fetch-url', async (_event, urlInput) => {
  try {
    if (!urlInput || typeof urlInput !== 'string') {
      return { ok: false, error: 'Invalid URL' };
    }

    const trimmed = urlInput.trim();
    const normalized = /^(https?:\/\/)/i.test(trimmed) ? trimmed : `https://${trimmed}`;

    const res = await fetch(normalized, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const contentType = res.headers.get('content-type') || '';
    if (/application\/pdf/i.test(contentType)) {
      const ab = await res.arrayBuffer();
      return { ok: true, url: res.url || normalized, contentType, bodyBase64: Buffer.from(ab).toString('base64') };
    }
    const body = await res.text();
    return { ok: true, url: res.url || normalized, contentType, body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Resolve shared audios root directory
function getAudiosRoot() {
  // Prefer env var so Python and Electron can coordinate
  const envDir = process.env.READL_AUDIO_DIR;
  const base = envDir && envDir.trim().length > 0
    ? envDir
    : path.resolve(__dirname, '..', 'audios');
  try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
  return base;
}

function statSafe(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}

function listDirRecursive(root, rel = '') {
  const full = path.join(root, rel);
  const entries = [];
  const names = (() => { try { return fs.readdirSync(full); } catch (_) { return []; } })();
  for (const name of names) {
    const childRel = path.join(rel, name);
    const childFull = path.join(root, childRel);
    const st = statSafe(childFull);
    if (!st) continue;
    if (st.isDirectory()) {
      entries.push({ type: 'dir', name, relPath: childRel });
      entries.push(...listDirRecursive(root, childRel));
    } else {
      entries.push({ type: 'file', name, relPath: childRel, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return entries;
}

const SAMPLE_RATE = 24000;
const DEFAULT_KOKORO_MODEL_ID = process.env.READL_KOKORO_MODEL_ID || 'kmaliszewski/Kokoro-82M-v1.0-ONNX';
const DEFAULT_KOKORO_DEVICE = (() => {
  const raw = process.env.READL_KOKORO_DEVICE;
  return raw && raw.trim().length > 0 ? raw.trim() : 'cpu';
})();
const DEFAULT_KOKORO_DTYPE = process.env.READL_KOKORO_DTYPE || 'fp32';
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_KOKORO_CACHE_DIR = (() => {
  const raw = process.env.READL_KOKORO_CACHE_DIR;
  return raw && raw.trim().length > 0 ? path.resolve(raw.trim()) : path.join(repoRoot, '.kokoro-cache');
})();
let kokoroLoadPromise = null;
let kokoroTtsInstance = null;
const phonemeCountCache = new Map();
const MAX_TEXT_CHUNK_LENGTH = Number(process.env.READL_TTS_MAX_CHARS || 400);
const MAX_PHONEME_TOKENS = Number(process.env.READL_TTS_MAX_TOKENS || 460);
const TTS_DEBUG = process.env.READL_TTS_DEBUG === '1';

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

function buildSavePath(voice, langCode, text) {
  const root = getAudiosRoot();
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

async function synthesizeWithKokoro(requestPayload) {
  const synthStart = performance.now();
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

  const tts = await loadKokoroTts();
  const splitPattern = typeof requestPayload?.split_pattern === 'string' && requestPayload.split_pattern.length > 0
    ? requestPayload.split_pattern
    : '\n+';
  const textChunks = await buildPhonemeAwareChunks(text, langCode, splitPattern);
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
    const segmentText = chunk.trim();
    if (!segmentText) continue;
    chunkOrdinal += 1;
    console.info(`chunk ${chunkOrdinal}/${textChunks.length} length=${segmentText.length}`);
    let chunkResult;
    try {
      chunkResult = await tts.generate(segmentText, { voice, speed });
      console.info(chunkResult.tokens);
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

  if (!audioChunks.length) {
    throw new Error('No audio segments produced by Kokoro');
  }

  const mergedAudio = mergeAudioSegments(audioChunks);
  if (!mergedAudio) {
    throw new Error('Failed to merge Kokoro audio segments');
  }

  const savePath = buildSavePath(voice, langCode, text);
  ensureDirForFile(savePath);
  await mergedAudio.save(savePath);

  const audioRoot = getAudiosRoot();
  let wavRelPath = path.relative(audioRoot, savePath);
  if (!wavRelPath || wavRelPath.startsWith('..')) {
    wavRelPath = savePath;
  }

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
    wav_rel_path: wavRelPath,
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

  const lines = [
    JSON.stringify(header),
    ...segmentsMetadata.map(segment => JSON.stringify({ type: 'segment', ...segment })),
  ];
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

// IPC: list saved audios recursively
try { ipcMain.removeHandler('audios-list'); } catch (e) {}
ipcMain.handle('audios-list', async () => {
  const root = getAudiosRoot();
  const items = listDirRecursive(root, '');
  return { root, items };
});

// IPC: delete a saved file or directory (recursive)
try { ipcMain.removeHandler('audios-delete'); } catch (e) {}
ipcMain.handle('audios-delete', async (_event, relPath) => {
  try {
    if (typeof relPath !== 'string' || !relPath) return { ok: false, error: 'Invalid path' };
    const root = getAudiosRoot();
    const target = path.resolve(root, relPath);
    // Prevent path traversal outside root
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
      return { ok: false, error: 'Path outside audios root' };
    }
    const st = statSafe(target);
    if (!st) return { ok: false, error: 'Not found' };
    if (st.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
      // Also remove sidecar NDJSON alignment if deleting a WAV file
      if (/\.wav$/i.test(target)) {
        const alignPath = target.replace(/\.wav$/i, '.align.ndjson');
        try {
          const stAlign = statSafe(alignPath);
          if (stAlign && stAlign.isFile()) {
            fs.unlinkSync(alignPath);
          }
        } catch (_) {}
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// IPC: build a file:// URL for a saved audio (renderer uses in <audio>)
try { ipcMain.removeHandler('audios-file-url'); } catch (e) {}
ipcMain.handle('audios-file-url', async (_event, relPath) => {
  try {
    if (typeof relPath !== 'string' || !relPath) return { ok: false, error: 'Invalid path' };
    const root = getAudiosRoot();
    const target = path.resolve(root, relPath);
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
      return { ok: false, error: 'Path outside audios root' };
    }
    const st = statSafe(target);
    if (!st || !st.isFile()) return { ok: false, error: 'File not found' };
    const url = 'file://' + target;
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// IPC: read NDJSON alignment sidecar
try { ipcMain.removeHandler('audios-read-align'); } catch (e) {}
ipcMain.handle('audios-read-align', async (_event, relPath) => {
  try {
    if (typeof relPath !== 'string' || !relPath) return { ok: false, error: 'Invalid path' };
    const root = getAudiosRoot();
    const alignAbs = path.resolve(root, relPath);
    if (!alignAbs.startsWith(path.resolve(root) + path.sep)) {
      return { ok: false, error: 'Path outside audios root' };
    }
    if (!/\.align\.ndjson$/i.test(alignAbs)) {
      return { ok: false, error: 'Not an .align.ndjson path' };
    }
    const st = statSafe(alignAbs);
    if (!st || !st.isFile()) return { ok: false, error: 'Alignment not found' };
    const raw = fs.readFileSync(alignAbs, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (!lines.length) return { ok: false, error: 'Empty alignment file' };
    const header = JSON.parse(lines[0]);
    if (!header || header.type !== 'header') return { ok: false, error: 'Invalid alignment header' };
    const segments = [];
    for (let i = 1; i < lines.length; i += 1) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj && obj.type === 'segment') segments.push(obj);
      } catch (_) { /* skip bad line */ }
    }
    const { type, version, ...rest } = header || {};
    const metadata = { ...rest, segments };
    return { ok: true, metadata };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// IPC: invoke Kokoro.js synthesis locally (replaces Python WebSocket)
try { ipcMain.removeHandler('kokoro-synthesize'); } catch (e) {}
ipcMain.handle('kokoro-synthesize', async (_event, payload) => {
  try {
    const result = await synthesizeWithKokoro(payload || {});
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// Utility: read an absolute file as base64 (for legacy saved PDFs, if needed)
try { ipcMain.removeHandler('read-file-base64'); } catch (e) {}
ipcMain.handle('read-file-base64', async (_event, absPath) => {
  try {
    if (typeof absPath !== 'string' || !absPath) return { ok: false, error: 'Invalid path' };
    const st = statSafe(absPath);
    if (!st || !st.isFile()) return { ok: false, error: 'Not found' };
    const buf = fs.readFileSync(absPath);
    return { ok: true, base64: buf.toString('base64') };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.maximize();
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
