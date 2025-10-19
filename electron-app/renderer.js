const SERVICE_URL = 'http://127.0.0.1:8000';

let audioElement;
let lastOpenedFilePath = null;
let lastLoadedUrl = null;
let currentSourceKind = null; // 'url' | 'file' | 'text'
let currentSourceUrl = null;
let currentRawContent = null;
let currentRawContentType = null;
let currentPreviewHtml = null;
let currentTitle = null;

let currentAlignmentMetadata = null;
let flattenedAlignmentTokens = [];
let previewTextNodeIndex = [];
let previewPlainText = '';
let tokenRangeCache = [];
let spokenHighlightSet = null;
let highlightRafHandle = null;
let lastHighlightedTokenIndex = -1;
let pendingRangeRebuildId = null;
let timedTokenIndices = [];
const TOKEN_HIGHLIGHT_EPSILON = 0.03;
const RELATIVE_TIME_FUZZ = 0.05;
const HIGHLIGHT_API_AVAILABLE = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

function logAlignment(metadata, wavRelPath) {
  try {
    const segments = Array.isArray(metadata && metadata.segments) ? metadata.segments : [];
    const label = wavRelPath ? `[Alignment] ${wavRelPath}` : '[Alignment]';
    if (!segments.length) {
      if (metadata && metadata.has_token_timestamps === false) {
        console.info(`${label} No token timestamps available.`);
      } else {
        console.info(`${label} No segment timing metadata found.`);
      }
      return;
    }

    console.group(label);
    segments.forEach((segment, idx) => {
      const offset = typeof segment.offset_seconds === 'number' ? segment.offset_seconds.toFixed(3) : '?';
      const duration = typeof segment.duration_seconds === 'number' ? segment.duration_seconds.toFixed(3) : '?';
      const segLabel = `Segment ${idx} (offset ${offset}s, duration ${duration}s)`;
      const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
      console.group(segLabel);
      if (!tokens.length) {
        console.info('No tokens for this segment.');
      } else {
        tokens.forEach((token) => {
          const index = typeof token.index === 'number' ? token.index : '?';
          const text = token.text || '';
          const start = typeof token.start_ts === 'number' ? token.start_ts.toFixed(3) : '-';
          const end = typeof token.end_ts === 'number' ? token.end_ts.toFixed(3) : '-';
          console.info(`#${index}: ${start}s → ${end}s "${text}"`);
        });
      }
      console.groupEnd();
    });
    console.groupEnd();
  } catch (err) {
    console.warn('[Alignment] Failed to log alignment metadata:', err);
  }
}

function normalizeCharForMatch(char) {
  switch (char) {
    case '“':
    case '”':
    case '„':
    case '«':
    case '»':
      return '"';
    case '‘':
    case '’':
    case '‚':
      return "'";
    case '–':
    case '—':
      return '-';
    default:
      return char.toLowerCase();
  }
}

function normalizeStringForMatch(str) {
  const input = String(str || '');
  let normalized = '';
  let lastWasSpace = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = normalizeCharForMatch(input[i]);
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        normalized += ' ';
        lastWasSpace = true;
      }
    } else {
      normalized += ch;
      lastWasSpace = false;
    }
  }
  return normalized.trim();
}

function flattenAlignmentSegments(segments) {
  const flattened = [];
  if (!Array.isArray(segments) || !segments.length) return flattened;
  segments.forEach((segment, segmentIndex) => {
    const hasSegmentOffset = typeof segment?.offset_seconds === 'number' && Number.isFinite(segment.offset_seconds);
    const segmentOffset = hasSegmentOffset ? segment.offset_seconds : 0;
    const segmentDuration = typeof segment?.duration_seconds === 'number' && Number.isFinite(segment.duration_seconds)
      ? segment.duration_seconds
      : null;
    const tokens = Array.isArray(segment && segment.tokens) ? segment.tokens : [];
    tokens.forEach((token, tokenIndex) => {
      if (!token || typeof token.text !== 'string') return;
      const text = token.text;
      const rawStart = typeof token.start_ts === 'number' ? token.start_ts : null;
      const rawEnd = typeof token.end_ts === 'number' ? token.end_ts : null;
      let start = rawStart;
      let end = rawEnd;

      if (rawStart !== null) {
        // When timestamps are segment-relative (common), add the parent offset so playback stays monotonic.
        const treatAsRelative = segmentDuration !== null
          ? rawStart <= segmentDuration + RELATIVE_TIME_FUZZ
          : (hasSegmentOffset && rawStart < segmentOffset + RELATIVE_TIME_FUZZ);
        if (hasSegmentOffset && treatAsRelative) {
          start = rawStart + segmentOffset;
        }
      }

      if (rawEnd !== null) {
        const treatAsRelativeEnd = segmentDuration !== null
          ? rawEnd <= segmentDuration + RELATIVE_TIME_FUZZ
          : (hasSegmentOffset && rawEnd < segmentOffset + RELATIVE_TIME_FUZZ);
        if (hasSegmentOffset && treatAsRelativeEnd) {
          end = rawEnd + segmentOffset;
        }
      }

      flattened.push({
        text,
        normalizedText: normalizeStringForMatch(text),
        startTs: start,
        endTs: end,
        segmentIndex,
        tokenIndex,
        index: flattened.length
      });
    });
  });
  return flattened;
}

function resetAlignmentState() {
  currentAlignmentMetadata = null;
  flattenedAlignmentTokens = [];
  tokenRangeCache = [];
  timedTokenIndices = [];
  lastHighlightedTokenIndex = -1;
  if (pendingRangeRebuildId !== null) {
    cancelAnimationFrame(pendingRangeRebuildId);
    pendingRangeRebuildId = null;
  }
  stopHighlightLoop();
  clearHighlightDecorations();
}

function captureAlignmentMetadata(metadata) {
  if (!metadata || !Array.isArray(metadata.segments) || !metadata.segments.length) {
    resetAlignmentState();
    return;
  }
  currentAlignmentMetadata = metadata;
  flattenedAlignmentTokens = flattenAlignmentSegments(metadata.segments);
  if (!flattenedAlignmentTokens.length) {
    resetAlignmentState();
    return;
  }
  scheduleTokenRangeRebuild();
  if (audioElement && !audioElement.paused && !audioElement.ended) {
    startHighlightLoop();
  }
}

function clearHighlightDecorations() {
  if (spokenHighlightSet) {
    try {
      spokenHighlightSet.clear();
    } catch (_) {
      // ignore
    }
  }
  lastHighlightedTokenIndex = -1;
}

function stopHighlightLoop() {
  if (highlightRafHandle !== null) {
    cancelAnimationFrame(highlightRafHandle);
    highlightRafHandle = null;
  }
}

function rebuildPreviewTextIndex() {
  previewTextNodeIndex = [];
  previewPlainText = '';
  const previewEl = document.getElementById('preview');
  if (!previewEl) return;
  const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT, null);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const value = node.textContent || '';
    if (value.length) {
      const length = value.length;
      previewTextNodeIndex.push({
        node,
        start: offset,
        end: offset + length
      });
      previewPlainText += value;
      offset += length;
    }
    node = walker.nextNode();
  }
}

function createNormalizedTextWithMap(input) {
  const map = [];
  const chars = [];
  let lastWasSpace = true;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    const normChar = normalizeCharForMatch(str[i]);
    if (/\s/.test(normChar)) {
      if (!lastWasSpace) {
        chars.push(' ');
        map.push(i);
        lastWasSpace = true;
      }
    } else {
      chars.push(normChar);
      map.push(i);
      lastWasSpace = false;
    }
  }
  if (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    map.pop();
  }
  return { normalized: chars.join(''), map };
}

function findNodeAtOffset(offset) {
  if (!previewTextNodeIndex.length) return null;
  if (offset < 0) offset = 0;
  if (offset >= previewPlainText.length) {
    const last = previewTextNodeIndex[previewTextNodeIndex.length - 1];
    const lastLength = (last.end - last.start);
    return {
      node: last.node,
      offset: lastLength
    };
  }
  for (let i = 0; i < previewTextNodeIndex.length; i += 1) {
    const entry = previewTextNodeIndex[i];
    if (offset >= entry.start && offset < entry.end) {
      return {
        node: entry.node,
        offset: offset - entry.start
      };
    }
  }
  const tail = previewTextNodeIndex[previewTextNodeIndex.length - 1];
  return {
    node: tail.node,
    offset: Math.max(0, tail.end - tail.start)
  };
}

function createRangeForOffsets(start, end) {
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  if (end <= start) return null;
  const startLoc = findNodeAtOffset(start);
  const endLoc = findNodeAtOffset(end);
  if (!startLoc || !endLoc) return null;
  try {
    const range = document.createRange();
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);
    return range;
  } catch (_err) {
    return null;
  }
}

function scheduleTokenRangeRebuild() {
  if (pendingRangeRebuildId !== null) {
    cancelAnimationFrame(pendingRangeRebuildId);
    pendingRangeRebuildId = null;
  }
  pendingRangeRebuildId = requestAnimationFrame(() => {
    pendingRangeRebuildId = null;
    rebuildTokenRanges();
  });
}

function rebuildTokenRanges() {
  tokenRangeCache = [];
  clearHighlightDecorations();
  lastHighlightedTokenIndex = -1;
  timedTokenIndices = [];
  if (!flattenedAlignmentTokens.length || !previewTextNodeIndex.length) {
    return;
  }
  const { normalized: previewNormalized, map: previewMap } = createNormalizedTextWithMap(previewPlainText);
  if (!previewNormalized.length) {
    clearHighlightDecorations();
    return;
  }

  let searchCursor = 0;
  const ranges = [];

  for (let i = 0; i < flattenedAlignmentTokens.length; i += 1) {
    const token = flattenedAlignmentTokens[i];
    const normalizedToken = token.normalizedText;
    const entry = {
      ...token,
      range: null,
      startChar: null,
      endChar: null
    };
    if (!normalizedToken) {
      ranges.push(entry);
      continue;
    }

    let matchIndex = previewNormalized.indexOf(normalizedToken, searchCursor);
    if (matchIndex === -1 && searchCursor > 0) {
      const rewind = Math.max(0, searchCursor - 50);
      matchIndex = previewNormalized.indexOf(normalizedToken, rewind);
    }
    if (matchIndex === -1) {
      matchIndex = previewNormalized.indexOf(normalizedToken, 0);
    }
    if (matchIndex === -1) {
      ranges.push(entry);
      continue;
    }

    const startOrig = previewMap[matchIndex];
    const endOrigIdx = matchIndex + normalizedToken.length - 1;
    const endOrig = endOrigIdx >= 0 && endOrigIdx < previewMap.length
      ? previewMap[endOrigIdx] + 1
      : startOrig + normalizedToken.length;

    const range = createRangeForOffsets(startOrig, endOrig);
    if (range) {
      entry.range = range;
      entry.startChar = startOrig;
      entry.endChar = endOrig;
    }
    const hasTiming = typeof entry.startTs === 'number'
      && typeof entry.endTs === 'number'
      && entry.endTs > entry.startTs;
    if (hasTiming && entry.range) {
      timedTokenIndices.push(i);
    }
    ranges.push(entry);
    searchCursor = matchIndex + normalizedToken.length;
  }

  tokenRangeCache = ranges;
  if (timedTokenIndices.length > 1) {
    timedTokenIndices.sort((a, b) => {
      const tokenA = tokenRangeCache[a];
      const tokenB = tokenRangeCache[b];
      const aStart = tokenA && typeof tokenA.startTs === 'number' ? tokenA.startTs : Infinity;
      const bStart = tokenB && typeof tokenB.startTs === 'number' ? tokenB.startTs : Infinity;
      if (aStart === bStart) {
        const aEnd = tokenA && typeof tokenA.endTs === 'number' ? tokenA.endTs : Infinity;
        const bEnd = tokenB && typeof tokenB.endTs === 'number' ? tokenB.endTs : Infinity;
        return aEnd - bEnd;
      }
      return aStart - bStart;
    });
  }
}

function onPreviewDomUpdated() {
  rebuildPreviewTextIndex();
  scheduleTokenRangeRebuild();
}

function findActiveTokenIndex(timeSeconds) {
  if (!Number.isFinite(timeSeconds) || !timedTokenIndices.length) return -1;
  let low = 0;
  let high = timedTokenIndices.length - 1;
  const epsilon = TOKEN_HIGHLIGHT_EPSILON;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const token = tokenRangeCache[timedTokenIndices[mid]];
    if (!token) break;
    const start = typeof token.startTs === 'number' ? token.startTs : 0;
    const end = typeof token.endTs === 'number' ? token.endTs : start;
    if (timeSeconds < start - epsilon) {
      high = mid - 1;
    } else if (timeSeconds >= end + epsilon) {
      low = mid + 1;
    } else {
      return timedTokenIndices[mid];
    }
  }
  return -1;
}

function ensureHighlightSet() {
  if (!HIGHLIGHT_API_AVAILABLE) {
    if (!ensureHighlightSet.warned) {
      console.warn('[Alignment] CSS Highlight API not available; spoken word highlighting disabled.');
      ensureHighlightSet.warned = true;
    }
    return null;
  }
  if (!spokenHighlightSet) {
    spokenHighlightSet = CSS.highlights.get('spoken');
    if (!spokenHighlightSet) {
      spokenHighlightSet = new Highlight();
      CSS.highlights.set('spoken', spokenHighlightSet);
    }
  }
  return spokenHighlightSet;
}

function applyHighlightIndex(targetIndex) {
  console.log('applyHighlightIndex', targetIndex);
  const highlightSet = ensureHighlightSet();
  if (!highlightSet) {
    lastHighlightedTokenIndex = targetIndex;
    return;
  }
  try {
    highlightSet.clear();
  } catch (_) {
    // ignore
  }
  if (targetIndex >= 0) {
    const token = tokenRangeCache[targetIndex];
    if (token && token.range) {
      try {
        highlightSet.add(token.range);
      } catch (_) {
        // ignore
      }
    }
  }
  lastHighlightedTokenIndex = targetIndex;
}

function updateHighlightForTime(timeSeconds) {
  if (!tokenRangeCache.length || !timedTokenIndices.length) {
    if (lastHighlightedTokenIndex !== -1) {
      applyHighlightIndex(-1);
    }
    return;
  }
  const activeIndex = findActiveTokenIndex(timeSeconds);
  if (activeIndex !== lastHighlightedTokenIndex) {
    applyHighlightIndex(activeIndex);
  }
}

function highlightAnimationStep() {
  if (!audioElement) return;
  highlightRafHandle = null;
  if (!ensureHighlightSet()) return;
  updateHighlightForTime(audioElement.currentTime || 0);
  if (!audioElement.paused && !audioElement.ended) {
    highlightRafHandle = requestAnimationFrame(highlightAnimationStep);
  }
}

function startHighlightLoop() {
  if (!audioElement || !ensureHighlightSet()) return;
  if (highlightRafHandle !== null) return;
  updateHighlightForTime(audioElement.currentTime || 0);
  highlightRafHandle = requestAnimationFrame(highlightAnimationStep);
}


function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) el.classList.add('active');
}

function navigateToPreview() {
  showScreen('screen-preview');
}

function navigateToInput() {
  showScreen('screen-input');
}

async function synthesizeAndPlay() {
  const textArea = document.getElementById('text');
  const voiceInput = document.getElementById('voice');
  const speedInput = document.getElementById('speed');
  const langInput = document.getElementById('lang');
  const status = document.getElementById('status');

  const payload = {
    text: textArea.value,
    voice: voiceInput.value || 'af_heart',
    speed: parseFloat(speedInput.value) || 1.0,
    lang_code: langInput.value || 'a',
    split_pattern: '\n+',
    // metadata for server-side sidecar json
    preview_html: currentPreviewHtml,
    source_kind: currentSourceKind,
    source_url: currentSourceUrl,
    raw_content: currentRawContent,
    raw_content_type: currentRawContentType,
    title: currentTitle
  };

  status.textContent = 'Synthesizing…';
  resetAlignmentState();
  try {
    const res = await fetch(`${SERVICE_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const msg = await res.text();
      throw new Error(`${res.status} ${msg}`);
    }

    const data = await res.json();
    if (!data || !data.ok || !data.wav_rel_path) {
      throw new Error('Invalid synth response');
    }
    const fileRes = await window.api.getSavedAudioFileUrl(data.wav_rel_path);
    if (!fileRes || !fileRes.ok || !fileRes.url) {
      throw new Error('Could not resolve saved file URL');
    }
    audioElement.src = fileRes.url;
    await audioElement.play();
    status.textContent = 'Playing';
    // Refresh library since a new file was saved
    refreshSavedAudios();

    // Fetch alignment NDJSON and log token timestamps
    if (!data.align_rel_path) throw new Error('Missing align_rel_path in response');
    const metaRes = await window.api.getSavedAudioAlignment(data.align_rel_path);
    if (metaRes && metaRes.ok && metaRes.metadata) {
      logAlignment(metaRes.metadata, data.wav_rel_path);
      captureAlignmentMetadata(metaRes.metadata);
    }
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err.message}`;
  }
}

function stopPlayback() {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
    stopHighlightLoop();
    clearHighlightDecorations();
    const status = document.getElementById('status');
    status.textContent = 'Stopped';
  }
}

function stripHtmlToText(htmlString) {
  const container = document.createElement('div');
  container.innerHTML = htmlString;
  // Remove script/style
  container.querySelectorAll('script, style').forEach(el => el.remove());
  return container.textContent || container.innerText || '';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderPlainTextPreview(textContent) {
  const pre = `<pre style="white-space:pre-wrap;">${escapeHtml(textContent || '')}</pre>`;
  renderSanitizedHtmlAndExtractText(pre);
}

function isMarkdownPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function isHtmlPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function isLikelyUrl(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.length < 4) return false;
  const hasProtocol = /^https?:\/\//i.test(s);
  const looksLikeDomain = /^[a-z0-9][a-z0-9\-\.]*\.[a-z]{2,}(?:\:[0-9]{2,5})?(?:\/\S*)?$/i.test(s);
  return hasProtocol || looksLikeDomain;
}

function renderSanitizedHtmlAndExtractText(html) {
  const previewEl = document.getElementById('preview');
  const textArea = document.getElementById('text');
  const safeHtml = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  previewEl.innerHTML = safeHtml;
  const textContent = stripHtmlToText(safeHtml).trim();
  textArea.value = textContent;
  currentPreviewHtml = safeHtml;
  // if not set elsewhere, assume simple text content
  if (!currentSourceKind) currentSourceKind = 'text';
  currentTitle = null;
  onPreviewDomUpdated();
}

function tryReaderModeExtraction(html, baseUrl) {
  try {
    if (typeof window.Readability === 'undefined') return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(html || '', 'text/html');
    if (!doc) return null;

    // Ensure <base> so relative URLs resolve, which improves Readability signals
    if (baseUrl) {
      const head = doc.head || doc.getElementsByTagName('head')[0] || doc.documentElement;
      const base = doc.createElement('base');
      base.setAttribute('href', baseUrl);
      if (head.firstChild) {
        head.insertBefore(base, head.firstChild);
      } else {
        head.appendChild(base);
      }
    }

    const reader = new window.Readability(doc);
    const article = reader.parse();
    if (!article || !article.content) return null;

    const safeArticleHtml = window.DOMPurify.sanitize(article.content, { USE_PROFILES: { html: true } });
    const text = (article.textContent || stripHtmlToText(safeArticleHtml) || '').trim();
    return { html: safeArticleHtml, text, title: article.title || '' };
  } catch (_e) {
    return null;
  }
}

function renderReaderOrSanitized(html, baseUrl) {
  const previewEl = document.getElementById('preview');
  const textArea = document.getElementById('text');

  const result = tryReaderModeExtraction(html, baseUrl);
  if (result && result.html) {
    previewEl.innerHTML = result.html;
    textArea.value = result.text || '';
    currentPreviewHtml = result.html;
    currentTitle = result.title || null;
    onPreviewDomUpdated();
    return;
  }
  renderSanitizedHtmlAndExtractText(html);
}

function renderPreviewAndExtractText(filePath, rawContent) {
  const previewEl = document.getElementById('preview');
  const textArea = document.getElementById('text');

  try {
    let html;
    if (isMarkdownPath(filePath)) {
      // Render markdown to HTML
      html = window.marked.parse(rawContent);
    } else if (isHtmlPath(filePath)) {
      const baseUrl = filePath ? `file://${filePath}` : undefined;
      renderReaderOrSanitized(rawContent, baseUrl);
      return;
    } else {
      // Plain text
      html = `<pre style="white-space:pre-wrap;">${rawContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`;
    }
    renderSanitizedHtmlAndExtractText(html);
  } catch (err) {
    console.error('Preview render failed:', err);
    previewEl.textContent = 'Failed to render preview.';
  }
}

async function handleOpenFile() {
  const status = document.getElementById('status');
  status.textContent = '';
  try {
    const result = await window.api.openFile();
    if (!result || result.canceled) return;
    lastOpenedFilePath = result.filePath || null;
    currentSourceKind = 'file';
    currentSourceUrl = lastOpenedFilePath;
    currentRawContent = result.content || '';
    currentRawContentType = getContentTypeForPath(lastOpenedFilePath);
    resetAlignmentState();
    renderPreviewAndExtractText(lastOpenedFilePath, result.content || '');
    navigateToPreview();
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err.message}`;
  }
}

async function loadUrlAndRender(urlInput) {
  const status = document.getElementById('status');
  const url = urlInput && urlInput.trim();
  if (!isLikelyUrl(url)) return;
  if (lastLoadedUrl && lastLoadedUrl === url) return;
  lastLoadedUrl = url;
  status.textContent = 'Loading URL…';
  try {
    const res = await window.api.fetchUrl(url);
    if (!res || !res.ok) {
      throw new Error(res && res.error ? res.error : 'Failed to load URL');
    }
    const contentType = (res.contentType || '').toLowerCase();
    currentSourceKind = 'url';
    currentSourceUrl = res.url || url;
    currentRawContent = res.body || '';
    currentRawContentType = contentType || null;
    resetAlignmentState();
    if (contentType.includes('text/markdown')) {
      const html = window.marked.parse(res.body || '');
      renderSanitizedHtmlAndExtractText(html);
    } else if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      renderReaderOrSanitized(res.body || '', res.url || url);
    } else if (contentType.includes('text/plain')) {
      const pre = `<pre style="white-space:pre-wrap;">${(res.body || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`;
      renderSanitizedHtmlAndExtractText(pre);
    } else {
      // Fallback: try to render as HTML
      renderReaderOrSanitized(res.body || '', res.url || url);
    }
    status.textContent = 'URL loaded';
    navigateToPreview();
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err.message}`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  audioElement = document.getElementById('player');
  if (audioElement) {
    audioElement.addEventListener('play', () => {
      startHighlightLoop();
    });
    audioElement.addEventListener('pause', () => {
      stopHighlightLoop();
      clearHighlightDecorations();
    });
    audioElement.addEventListener('ended', () => {
      stopHighlightLoop();
      clearHighlightDecorations();
    });
    audioElement.addEventListener('seeking', () => {
      if (audioElement.paused || audioElement.ended) return;
      updateHighlightForTime(audioElement.currentTime || 0);
    });
    audioElement.addEventListener('timeupdate', () => {
      if (audioElement.paused || audioElement.ended) return;
      updateHighlightForTime(audioElement.currentTime || 0);
    });
  }

  const openFileBtn = document.getElementById('openFileBtn');
  if (openFileBtn) openFileBtn.addEventListener('click', handleOpenFile);
  document.getElementById('playBtn').addEventListener('click', synthesizeAndPlay);
  document.getElementById('stopBtn').addEventListener('click', stopPlayback);
  const previewBtn = document.getElementById('previewBtn');
  const backBtn = document.getElementById('backBtn');
  const inputText = document.getElementById('inputText');

  const urlModalBackdrop = document.getElementById('urlModalBackdrop');
  const openUrlModalBtn = document.getElementById('openUrlModalBtn');
  const modalUrlField = document.getElementById('modalUrlField');
  const urlCancelBtn = document.getElementById('urlCancelBtn');
  const urlLoadBtn = document.getElementById('urlLoadBtn');

  if (previewBtn && inputText) {
    previewBtn.addEventListener('click', () => {
      const content = (inputText.value || '').trim();
      const hiddenTextArea = document.getElementById('text');
      hiddenTextArea.value = content;
      currentSourceKind = 'text';
      currentSourceUrl = null;
      currentRawContent = content;
      currentRawContentType = 'text/plain';
      currentTitle = null;
      resetAlignmentState();
      if (isLikelyUrl(content)) {
        navigateToPreview();
        loadUrlAndRender(content);
      } else {
        renderPlainTextPreview(content);
        navigateToPreview();
      }
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      stopPlayback();
      navigateToInput();
    });
  }

  // URL modal
  function openUrlModal() {
    if (!urlModalBackdrop) return;
    urlModalBackdrop.style.display = 'flex';
    if (modalUrlField) {
      modalUrlField.value = '';
      setTimeout(() => modalUrlField.focus(), 0);
    }
  }

  function closeUrlModal() {
    if (!urlModalBackdrop) return;
    urlModalBackdrop.style.display = 'none';
  }

  if (openUrlModalBtn) openUrlModalBtn.addEventListener('click', openUrlModal);
  if (urlCancelBtn) urlCancelBtn.addEventListener('click', closeUrlModal);
  if (urlModalBackdrop) {
    urlModalBackdrop.addEventListener('click', (e) => {
      if (e.target === urlModalBackdrop) closeUrlModal();
    });
  }
  if (urlLoadBtn && modalUrlField) {
    const loadUrlFromModal = () => {
      const value = (modalUrlField.value || '').trim();
      if (!isLikelyUrl(value)) return;
      closeUrlModal();
      navigateToPreview();
      loadUrlAndRender(value);
    };
    urlLoadBtn.addEventListener('click', loadUrlFromModal);
    modalUrlField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadUrlFromModal();
      if (e.key === 'Escape') closeUrlModal();
    });
  }

});



function renderSavedAudiosTree(container, items) {
  // Flat list of saved recordings, WAV files only; no JSON sidecars or folders
  function isWav(item) {
    return item && item.type === 'file' && /\.wav$/i.test(item.name || '');
  }
  function getDateFromRelPath(relPath) {
    if (!relPath) return '';
    const first = String(relPath).split('/')[0] || '';
    // Expect YYYY-MM-DD
    return first;
  }
  function getTimestampFromFileName(name) {
    const m = String(name).match(/^(\d{6,})_/); // HHMMSSmmm...
    return m ? m[1] : '';
  }
  function getBaseName(p) {
    if (!p) return '';
    const parts = String(p).split(/[\\\/]/);
    return parts[parts.length - 1] || '';
  }

  const wavItems = (items || []).filter(isWav).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

  container.innerHTML = '';
  const list = document.createElement('div');

  for (const file of wavItems) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.margin = '4px 0';
    row.style.cursor = 'pointer';

    const label = document.createElement('span');
    label.style.flex = '1 1 auto';
    const defaultLabel = String(file.name || '').replace(/\.wav$/i, '');
    label.textContent = defaultLabel;

    const dateSpan = document.createElement('span');
    dateSpan.style.color = 'var(--muted)';
    dateSpan.style.fontSize = '12px';
    dateSpan.textContent = getDateFromRelPath(file.relPath);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-secondary';
    delBtn.textContent = 'Delete';

    // Attach actions
    let cachedMeta = null;
    row.addEventListener('click', async () => {
      if (cachedMeta) {
        openSavedRecording(cachedMeta, file.relPath);
        return;
      }
      const alignRel = String(file.relPath || '').replace(/\.wav$/i, '.align.ndjson');
      const metaRes = await window.api.getSavedAudioAlignment(alignRel);
      if (metaRes && metaRes.ok && metaRes.metadata) {
        cachedMeta = metaRes.metadata;
        openSavedRecording(metaRes.metadata, file.relPath);
      }
    });

    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = confirm(`Delete ${file.name}?`);
      if (!ok) return;
      const res = await window.api.deleteSavedAudio(file.relPath);
      if (res && res.ok) {
        await refreshSavedAudios();
      }
    });

    // Resolve label from metadata
    (async () => {
      try {
        const alignRel = String(file.relPath || '').replace(/\.wav$/i, '.align.ndjson');
        const metaRes = await window.api.getSavedAudioAlignment(alignRel);
        if (!metaRes || !metaRes.ok || !metaRes.metadata) return;
        cachedMeta = metaRes.metadata;
        const kind = (cachedMeta.source_kind || '').toLowerCase();
        if (kind === 'text') {
          const ts = getTimestampFromFileName(file.name || '') || '';
          label.textContent = ts ? `quick-${ts}` : `quick`;
        } else if (kind === 'file' && cachedMeta.source_url) {
          const base = getBaseName(cachedMeta.source_url);
          label.textContent = base || label.textContent;
        } else {
          // leave default label
        }
      } catch (_) {
        // ignore
      }
    })();

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flex = '1 1 auto';
    left.style.alignItems = 'center';
    left.style.gap = '8px';
    left.appendChild(label);
    if (dateSpan.textContent) left.appendChild(dateSpan);

    row.appendChild(left);
    row.appendChild(delBtn);
    list.appendChild(row);
  }

  container.appendChild(list);
}

async function refreshSavedAudios() {
  const status = document.getElementById('status');
  try {
    const res = await window.api.listSavedAudios();
    if (!res || !res.items) return;
    const container = document.getElementById('savedAudios');
    if (container) {
      renderSavedAudiosTree(container, res.items);
    }
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err.message}`;
  }
}

// Initial load of saved audios on app start
refreshSavedAudios();

function getContentTypeForPath(filePath) {
  if (!filePath) return 'text/plain';
  const lower = filePath.toLowerCase();
  if (isMarkdownPath(lower)) return 'text/markdown';
  if (isHtmlPath(lower)) return 'text/html';
  return 'text/plain';
}

function openSavedRecording(metadata, wavRelPath) {
  try {
    const previewEl = document.getElementById('preview');
    const textArea = document.getElementById('text');
    const voiceInput = document.getElementById('voice');
    const speedInput = document.getElementById('speed');
    const langInput = document.getElementById('lang');

    const safe = window.DOMPurify.sanitize(metadata.preview_html || '', { USE_PROFILES: { html: true } });
    previewEl.innerHTML = safe;
    textArea.value = metadata.text || '';
    onPreviewDomUpdated();

    voiceInput.value = metadata.voice || voiceInput.value || 'af_heart';
    if (typeof metadata.speed === 'number') speedInput.value = String(metadata.speed);
    langInput.value = metadata.lang_code || langInput.value || 'a';

    currentPreviewHtml = safe;
    currentSourceKind = metadata.source_kind || 'text';
    currentSourceUrl = metadata.source_url || null;
    currentRawContent = metadata.raw_content || metadata.text || '';
    currentRawContentType = metadata.raw_content_type || 'text/plain';
    currentTitle = metadata.title || null;

    navigateToPreview();

    captureAlignmentMetadata(metadata);
    logAlignment(metadata, wavRelPath);
  } catch (e) {
    console.error('Failed to open saved recording:', e);
  }
}
