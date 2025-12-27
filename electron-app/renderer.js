let audioElement;
let lastOpenedFilePath = null;
let currentSourceKind = null; // 'url' | 'file' | 'text'
let currentSourceUrl = null;
let currentRawContent = null;
let currentRawContentType = null;
let currentPreviewHtml = null;
let currentTitle = null;
let activeLibraryRelPath = null;
let savedAudiosLoading = false;
const MAX_LIBRARY_SKELETON_ROWS = 6;
const LIBRARY_EMPTY_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M5.5 4h4.75A2.75 2.75 0 0 1 13 6.75v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 16.25v-10A2.25 2.25 0 0 1 6.25 4zM18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5A1.5 1.5 0 0 0 20 15.5v-10A1.5 1.5 0 0 0 18.5 4z"/></svg>';
const LIBRARY_ERROR_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 5h2v7h-2zm0 9h2v2h-2z"/></svg>';

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
let generateBtn = null;
let optionsToggleBtn = null;
let optionsCloseBtn = null;
let optionsDoneBtn = null;
let optionsDrawer = null;
let optionsBackdrop = null;
let speedValueLabel = null;
let isGenerating = false;
let cancelRequested = false;
let optionsDrawerOpen = false;
let currentOptions = {
  voice: 'af_heart',
  lang: 'a',
  speed: 1
};
const TOKEN_HIGHLIGHT_EPSILON = 0.03;
const RELATIVE_TIME_FUZZ = 0.05;
const HIGHLIGHT_API_AVAILABLE = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
const OPTIONS_STORAGE_KEY = 'readl-options-v1';

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
  const timestampMode = detectTokenTimestampMode(segments);
  const tokensAlreadyAbsolute = timestampMode === 'absolute';
  segments.forEach((segment, segmentIndex) => {
    const hasSegmentOffset = typeof segment?.offset_seconds === 'number' && Number.isFinite(segment.offset_seconds);
    const segmentOffset = hasSegmentOffset ? segment.offset_seconds : 0;
    const tokens = Array.isArray(segment && segment.tokens) ? segment.tokens : [];
    tokens.forEach((token, tokenIndex) => {
      if (!token || typeof token.text !== 'string') return;
      const text = token.text;
      const rawStart = typeof token.start_ts === 'number' ? token.start_ts : null;
      const rawEnd = typeof token.end_ts === 'number' ? token.end_ts : null;
      let start = rawStart;
      let end = rawEnd;

      if (rawStart !== null) {
        if (hasSegmentOffset && !tokensAlreadyAbsolute) {
          start = rawStart + segmentOffset;
        }
      }

      if (rawEnd !== null) {
        if (hasSegmentOffset && !tokensAlreadyAbsolute) {
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

function detectTokenTimestampMode(segments) {
  if (!Array.isArray(segments) || !segments.length) {
    return 'unknown';
  }
  let sawTimestamp = false;
  let lastTs = -Infinity;
  for (const segment of segments) {
    const tokens = Array.isArray(segment && segment.tokens) ? segment.tokens : [];
    for (const token of tokens) {
      let ts = null;
      if (typeof token?.start_ts === 'number' && Number.isFinite(token.start_ts)) {
        ts = token.start_ts;
      } else if (typeof token?.end_ts === 'number' && Number.isFinite(token.end_ts)) {
        ts = token.end_ts;
      }
      if (ts === null) continue;
      sawTimestamp = true;
      if (ts + RELATIVE_TIME_FUZZ < lastTs) {
        return 'relative';
      }
      if (ts > lastTs) {
        lastTs = ts;
      }
    }
  }
  return sawTimestamp ? 'absolute' : 'unknown';
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

function getProgressUiElements() {
  const shell = document.getElementById('progressShell');
  return {
    bar: document.getElementById('progressFill'),
    shell
  };
}

function clampProgressPercent(pct) {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

function showProgressUi(initialPct) {
  const { bar, shell } = getProgressUiElements();
  const pct = clampProgressPercent(initialPct);
  if (bar) bar.style.width = `${pct}%`;
  if (shell) shell.style.display = 'block';
}

function updateProgressUi(pct) {
  const { bar } = getProgressUiElements();
  if (bar) bar.style.width = `${clampProgressPercent(pct)}%`;
}

function hideProgressUi({ resetWidth = true } = {}) {
  const { bar, shell } = getProgressUiElements();
  if (resetWidth && bar) bar.style.width = '0%';
  if (shell) shell.style.display = 'none';
}


function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) el.classList.add('active');
  updateShellForScreen(screenId);
}

function isPreviewScreenActive() {
  const preview = document.getElementById('screen-preview');
  return !!(preview && preview.classList.contains('active'));
}

function updateGenerateAvailability(forcePreview) {
  if (!generateBtn) return;
  const onPreview = typeof forcePreview === 'boolean' ? forcePreview : isPreviewScreenActive();
  if (isGenerating) {
    generateBtn.disabled = cancelRequested;
  } else {
    generateBtn.disabled = !onPreview;
  }
}

function updateShellForScreen(screenId) {
  const appEl = document.querySelector('.app');
  const onPreview = screenId === 'screen-preview';
  if (appEl) appEl.classList.toggle('preview-mode', onPreview);
  updateGenerateAvailability(onPreview);
}

function updateGenerateButtonUi() {
  if (!generateBtn) return;
  if (isGenerating) {
    if (cancelRequested) {
      generateBtn.textContent = 'Canceling…';
      generateBtn.disabled = true;
    } else {
      generateBtn.textContent = 'Stop';
    }
    generateBtn.classList.add('btn-danger');
  } else {
    generateBtn.textContent = 'Generate';
    generateBtn.classList.remove('btn-danger');
  }
}

function setGeneratingState(active) {
  isGenerating = !!active;
  if (!isGenerating) {
    cancelRequested = false;
  }
  updateGenerateButtonUi();
  updateGenerateAvailability();
}

function setCancelRequested(active) {
  cancelRequested = !!active;
  updateGenerateButtonUi();
  updateGenerateAvailability();
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function formatGenerationDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function clampSpeed(value) {
  if (!Number.isFinite(value)) return currentOptions.speed;
  if (value < 0.5) return 0.5;
  if (value > 1.5) return 1.5;
  return value;
}

function formatSpeedValue(value) {
  if (!Number.isFinite(value)) return '';
  const fixed = value.toFixed(2);
  let trimmed = fixed.replace(/0+$/, '');
  if (trimmed.endsWith('.')) {
    trimmed += '0';
  }
  if (!trimmed.includes('.')) {
    trimmed += '.0';
  }
  return `${trimmed}x`;
}

function setSpeedValueDisplay(value) {
  if (speedValueLabel) {
    speedValueLabel.textContent = formatSpeedValue(value);
  }
}

function loadOptionsFromStorage() {
  try {
    const raw = localStorage.getItem(OPTIONS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const next = { ...currentOptions };
    if (typeof parsed.voice === 'string') next.voice = parsed.voice;
    if (typeof parsed.lang === 'string') next.lang = parsed.lang;
    const speed = parseFloat(parsed.speed);
    if (Number.isFinite(speed)) next.speed = clampSpeed(speed);
    return next;
  } catch (_err) {
    return null;
  }
}

function persistOptions(options) {
  try {
    localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(options));
  } catch (_err) {
    // ignore storage errors
  }
}

function applyOptionsToInputs(options) {
  const voiceInput = document.getElementById('voice');
  const langInput = document.getElementById('lang');
  const speedInput = document.getElementById('speed');
  if (voiceInput && typeof options.voice === 'string') voiceInput.value = options.voice;
  if (langInput && typeof options.lang === 'string') langInput.value = options.lang;
  if (speedInput && typeof options.speed === 'number') {
    speedInput.value = String(options.speed);
  }
  setSpeedValueDisplay(options.speed);
}

function syncOptionsFromInputs({ persist = true } = {}) {
  const voiceInput = document.getElementById('voice');
  const langInput = document.getElementById('lang');
  const speedInput = document.getElementById('speed');
  if (voiceInput) currentOptions.voice = voiceInput.value || 'af_heart';
  if (langInput) currentOptions.lang = langInput.value || 'a';
  if (speedInput) {
    const parsed = parseFloat(speedInput.value);
    currentOptions.speed = clampSpeed(Number.isFinite(parsed) ? parsed : currentOptions.speed);
  }
  setSpeedValueDisplay(currentOptions.speed);
  if (persist) persistOptions(currentOptions);
  return currentOptions;
}

function setOptionsDrawerOpenState(open) {
  optionsDrawerOpen = !!open;
  if (optionsDrawer) {
    optionsDrawer.classList.toggle('open', optionsDrawerOpen);
    optionsDrawer.setAttribute('aria-hidden', optionsDrawerOpen ? 'false' : 'true');
  }
  if (optionsBackdrop) {
    optionsBackdrop.classList.toggle('active', optionsDrawerOpen);
  }
  if (optionsToggleBtn) {
    optionsToggleBtn.setAttribute('aria-expanded', optionsDrawerOpen ? 'true' : 'false');
  }
  if (optionsDrawerOpen) {
    requestAnimationFrame(() => {
      const voiceInput = document.getElementById('voice');
      if (voiceInput) voiceInput.focus();
    });
  }
}

function openOptionsDrawer() {
  setOptionsDrawerOpenState(true);
}

function closeOptionsDrawer() {
  setOptionsDrawerOpenState(false);
}

function toggleOptionsDrawer() {
  setOptionsDrawerOpenState(!optionsDrawerOpen);
}

function handleGenerateClick() {
  if (isGenerating) {
    cancelActiveSynthesis();
    return;
  }
  if (isPreviewScreenActive()) {
    startSynthesis();
  }
}

function navigateToPreview() {
  showScreen('screen-preview');
}

function navigateToInput() {
  showScreen('screen-input');
}

async function cancelActiveSynthesis() {
  if (!isGenerating) return;
  setCancelRequested(true);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Canceling…';
  try {
    await window.api.engine.cancel();
  } catch (err) {
    console.error('Cancel request failed:', err);
    setCancelRequested(false);
    if (status) status.textContent = 'Cancel failed';
  }
}

async function startSynthesis() {
  if (isGenerating) return;
  const textArea = document.getElementById('text');
  const status = document.getElementById('status');
  if (!textArea || !status) return;

  const voiceInput = document.getElementById('voice');
  const speedInput = document.getElementById('speed');
  const langInput = document.getElementById('lang');

  syncOptionsFromInputs();

  const payload = {
    text: textArea.value,
    voice: voiceInput && voiceInput.value ? voiceInput.value : currentOptions.voice,
    speed: (() => {
      const parsed = speedInput ? parseFloat(speedInput.value) : Number.NaN;
      return clampSpeed(Number.isFinite(parsed) ? parsed : currentOptions.speed);
    })(),
    lang_code: langInput && langInput.value ? langInput.value : currentOptions.lang,
    preview_html: currentPreviewHtml,
    source_kind: currentSourceKind,
    source_url: currentSourceUrl,
    raw_content: currentRawContent,
    raw_content_type: currentRawContentType,
    title: currentTitle
  };

  const synthInvocationStartedAt = nowMs();
  status.textContent = 'Synthesizing…';
  resetAlignmentState();
  clearAudioSource();
  setActiveLibraryRow(null);
  setGeneratingState(true);
  showProgressUi(0);
  let progressHandled = false;
  let generationDurationMs = null;

  // Subscribe to chunk progress updates
  const unsubscribeProgress = window.api.engine.onProgress(({ pct }) => {
    if (!isGenerating) return; // Guard against late/out-of-order updates
    updateProgressUi(pct);
    status.textContent = `Synthesizing… ${pct}%`;
  });

  try {
    const synthResult = await window.api.engine.synthesize(payload);
    if (!synthResult || !synthResult.wav_rel_path) {
      throw new Error('Synthesis did not return an audio path');
    }
    const fileRes = await window.api.filesystem.getSavedAudioFileUrl(synthResult.wav_rel_path);
    if (!fileRes || !fileRes.ok || !fileRes.url) {
      throw new Error('Could not resolve saved file URL');
    }
    const backendElapsed = Number.isFinite(synthResult.elapsed_ms) ? synthResult.elapsed_ms : null;
    const fallbackElapsed = Math.max(0, Math.round(nowMs() - synthInvocationStartedAt));
    generationDurationMs = backendElapsed !== null ? backendElapsed : fallbackElapsed;
    const generationSuffix = (() => {
      const label = formatGenerationDuration(generationDurationMs);
      return label ? ` — generated in ${label}` : '';
    })();
    audioElement.src = fileRes.url;
    try {
      await audioElement.play();
      status.textContent = `Playing${generationSuffix}`;
    } catch (playErr) {
      console.warn('Autoplay failed:', playErr);
      status.textContent = `Ready${generationSuffix}`;
    }
    updateProgressUi(100);
    hideProgressUi({ resetWidth: false });
    progressHandled = true;
    setActiveLibraryRow(synthResult.wav_rel_path || null);
    await refreshSavedAudios({ showSkeleton: false });
    if (synthResult.align_rel_path) {
      const metaRes = await window.api.filesystem.getSavedAudioAlignment(synthResult.align_rel_path);
      if (metaRes && metaRes.ok && metaRes.metadata) {
        captureAlignmentMetadata(metaRes.metadata);
      }
    }
  } catch (err) {
    const message = err && err.message ? err.message : 'Synthesis failed';
    // Check for cancellation - either by name or by message content (IPC wraps errors)
    const isCanceled = (err && err.name === 'AbortError') ||
      (message && (message.includes('AbortError') || message.toLowerCase().includes('canceled')));
    if (isCanceled) {
      status.textContent = 'Canceled';
    } else {
      console.error('Synthesis failed:', err);
      status.textContent = `Error: ${message}`;
    }
  } finally {
    unsubscribeProgress();
    if (!progressHandled) {
      hideProgressUi();
    }
    setGeneratingState(false);
  }
}

function clearAudioSource() {
  if (!audioElement) return;
  try { audioElement.pause(); } catch (_) {}
  audioElement.removeAttribute('src');
  try { audioElement.load(); } catch (_) {}
  stopHighlightLoop();
  clearHighlightDecorations();
}

function stopPlayback() {
  if (!audioElement) return;
  audioElement.pause();
  audioElement.currentTime = 0;
  stopHighlightLoop();
  clearHighlightDecorations();
  const status = document.getElementById('status');
  if (status) status.textContent = 'Stopped';
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

// Markdown support removed

function isHtmlPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function isPdfPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.pdf');
}

function isPdfContentType(ct) {
  return typeof ct === 'string' && ct.toLowerCase().includes('application/pdf');
}

function b64ToUint8Array(b64) {
  try {
    const bin = atob(b64 || '');
    const len = bin.length >>> 0;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  } catch (_) {
    return new Uint8Array(0);
  }
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

async function extractPdfText(pdf) {
  const parts = [];
  try {
    const pageCount = pdf && pdf.numPages ? pdf.numPages : 0;
    for (let i = 1; i <= pageCount; i += 1) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const txt = (tc.items || []).map(it => (it && it.str) ? it.str : '').join(' ').trim();
      if (txt) parts.push(txt);
    }
  } catch (_) {
    // ignore
  }
  return parts.join('\n\n');
}

async function renderPdfFromBytes(bytes, sourceUrl) {
  const previewEl = document.getElementById('preview');
  const textArea = document.getElementById('text');
  if (!previewEl) return;

  // Clear previous content and create the PDF viewer element
  previewEl.innerHTML = '';
  const containerEl = document.createElement('div');
  containerEl.style.position = 'absolute';
  containerEl.style.inset = '0';
  containerEl.style.overflow = 'auto';
  previewEl.appendChild(containerEl);

  const viewerEl = document.createElement('div');
  viewerEl.className = 'pdfViewer';
  containerEl.appendChild(viewerEl);

  if (typeof window.pdfjsLib === 'undefined' || typeof window.pdfjsViewer === 'undefined') {
    previewEl.textContent = 'PDF viewer unavailable (pdfjs not loaded).';
    return;
  }

  const eventBus = new window.pdfjsViewer.EventBus();
  const viewer = new window.pdfjsViewer.PDFViewer({
    container: containerEl,
    viewer: viewerEl,
    eventBus,
    textLayerMode: 2
  });

  // Debounce reindexing as pages/text layers render or the view changes
  let reindexTimer = null;
  const requestReindex = () => {
    if (reindexTimer) clearTimeout(reindexTimer);
    reindexTimer = setTimeout(() => {
      onPreviewDomUpdated();
    }, 50);
  };

  eventBus.on('pagesinit', requestReindex);
  eventBus.on('pagerendered', requestReindex);
  eventBus.on('textlayerrendered', requestReindex);
  eventBus.on('scalechanging', requestReindex);
  eventBus.on('rotationchanging', requestReindex);

  // Load the document
  const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
  const pdfDocument = await loadingTask.promise;
  viewer.setDocument(pdfDocument);
  try { viewer.currentScaleValue = 'page-width'; } catch (_) {}

  // Extract text for TTS from the same source as the text layer
  try {
    const text = await extractPdfText(pdfDocument);
    textArea.value = text || '';
  } catch (_) {
    // ignore
  }

  currentPreviewHtml = null;
  currentTitle = null;
  currentRawContentType = 'application/pdf';
  if (sourceUrl) currentSourceUrl = sourceUrl;
  // We intentionally do not stash raw PDF bytes to avoid bloating metadata.

  // Kick an initial reindex in case first page rendered synchronously
  requestReindex();
}

function renderPreviewAndExtractText(filePath, rawContent) {
  const previewEl = document.getElementById('preview');
  const textArea = document.getElementById('text');

  try {
    let html;
    if (isHtmlPath(filePath)) {
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
    const result = await window.api.filesystem.openFile();
    if (!result || result.canceled) return;
    lastOpenedFilePath = result.filePath || null;
    resetAlignmentState();
    clearAudioSource();
    setActiveLibraryRow(null);
    if ((result.contentType && isPdfContentType(result.contentType)) && result.contentBase64) {
      currentSourceKind = 'file';
      currentSourceUrl = lastOpenedFilePath;
      currentRawContent = null;
      currentRawContentType = 'application/pdf';
      navigateToPreview();
      await renderPdfFromBytes(b64ToUint8Array(result.contentBase64), `file://${lastOpenedFilePath}`);
      return;
    }
    currentSourceKind = 'file';
    currentSourceUrl = lastOpenedFilePath;
    currentRawContent = result.content || '';
    currentRawContentType = getContentTypeForPath(lastOpenedFilePath);
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
  status.textContent = 'Loading URL…';
  try {
    const res = await window.api.filesystem.fetchUrl(url);
    if (!res || !res.ok) {
      throw new Error(res && res.error ? res.error : 'Failed to load URL');
    }
    const contentType = (res.contentType || '').toLowerCase();
    resetAlignmentState();
    clearAudioSource();
    setActiveLibraryRow(null);
    if (isPdfContentType(contentType) && res.bodyBase64) {
      currentSourceKind = 'url';
      currentSourceUrl = res.url || url;
      currentRawContent = null;
      currentRawContentType = 'application/pdf';
      navigateToPreview();
      await renderPdfFromBytes(b64ToUint8Array(res.bodyBase64), res.url || url);
    } else if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      currentSourceKind = 'url';
      currentSourceUrl = res.url || url;
      currentRawContent = res.body || '';
      currentRawContentType = contentType || null;
      renderReaderOrSanitized(res.body || '', res.url || url);
    } else if (contentType.includes('text/plain')) {
      currentSourceKind = 'url';
      currentSourceUrl = res.url || url;
      currentRawContent = res.body || '';
      currentRawContentType = contentType || null;
      const pre = `<pre style="white-space:pre-wrap;">${(res.body || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`;
      renderSanitizedHtmlAndExtractText(pre);
    } else {
      // Fallback: try to render as HTML
      currentSourceKind = 'url';
      currentSourceUrl = res.url || url;
      currentRawContent = res.body || '';
      currentRawContentType = contentType || null;
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
  hideProgressUi();

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

  generateBtn = document.getElementById('generateBtn');
  optionsToggleBtn = document.getElementById('optionsToggle');
  optionsCloseBtn = document.getElementById('optionsClose');
  optionsDoneBtn = document.getElementById('optionsDone');
  optionsDrawer = document.getElementById('optionsDrawer');
  optionsBackdrop = document.getElementById('optionsBackdrop');
  speedValueLabel = document.getElementById('speedValue');
  const voiceInput = document.getElementById('voice');
  const langInput = document.getElementById('lang');
  const speedInput = document.getElementById('speed');

  if (generateBtn) {
    generateBtn.addEventListener('click', handleGenerateClick);
  }

  if (optionsToggleBtn) {
    optionsToggleBtn.addEventListener('click', toggleOptionsDrawer);
    optionsToggleBtn.setAttribute('aria-haspopup', 'dialog');
    optionsToggleBtn.setAttribute('aria-expanded', 'false');
  }
  if (optionsCloseBtn) optionsCloseBtn.addEventListener('click', closeOptionsDrawer);
  if (optionsDoneBtn) optionsDoneBtn.addEventListener('click', closeOptionsDrawer);
  if (optionsBackdrop) {
    optionsBackdrop.addEventListener('click', (event) => {
      if (event.target === optionsBackdrop) closeOptionsDrawer();
    });
  }

  setOptionsDrawerOpenState(false);

  const storedOptions = loadOptionsFromStorage();
  if (storedOptions) currentOptions = storedOptions;
  applyOptionsToInputs(currentOptions);
  persistOptions(currentOptions);

  if (voiceInput) {
    voiceInput.addEventListener('input', () => {
      currentOptions.voice = voiceInput.value || 'af_heart';
    });
    voiceInput.addEventListener('change', () => {
      persistOptions(currentOptions);
    });
  }

  if (langInput) {
    langInput.addEventListener('change', () => {
      currentOptions.lang = langInput.value || 'a';
      persistOptions(currentOptions);
    });
  }

  if (speedInput) {
    speedInput.addEventListener('input', () => {
      const value = clampSpeed(parseFloat(speedInput.value));
      currentOptions.speed = value;
      speedInput.value = String(value);
      setSpeedValueDisplay(value);
    });
    speedInput.addEventListener('change', () => {
      persistOptions(currentOptions);
    });
  }

  setGeneratingState(false);
  const initialScreen = isPreviewScreenActive() ? 'screen-preview' : 'screen-input';
  updateShellForScreen(initialScreen);

  const openFileBtn = document.getElementById('openFileBtn');
  if (openFileBtn) openFileBtn.addEventListener('click', handleOpenFile);

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
      clearAudioSource();
      setActiveLibraryRow(null);
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
      if (isGenerating) return;
      stopPlayback();
      navigateToInput();
    });
  }

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

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && optionsDrawerOpen) {
      event.preventDefault();
      closeOptionsDrawer();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
    const isEditable = target && (target.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
    if (isEditable) return;
    if (event.key === 'o' || event.key === 'O') {
      event.preventDefault();
      toggleOptionsDrawer();
    } else if ((event.key === 'g' || event.key === 'G') && generateBtn && !generateBtn.disabled) {
      event.preventDefault();
      handleGenerateClick();
    }
  });
});



function setActiveLibraryRow(relPath) {
  activeLibraryRelPath = relPath || null;
  const container = document.getElementById('savedAudios');
  if (!container) return;
  const rows = container.querySelectorAll('.list-row');
  rows.forEach((row) => {
    if (!row || !row.dataset) return;
    const isMatch = activeLibraryRelPath && row.dataset.relPath === activeLibraryRelPath;
    if (isMatch) {
      row.classList.add('is-active');
    } else {
      row.classList.remove('is-active');
    }
  });
}

function renderSavedAudiosSkeleton(container, count = MAX_LIBRARY_SKELETON_ROWS) {
  if (!container) return;
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const placeholder = document.createElement('div');
    placeholder.className = 'skeleton-row';
    fragment.appendChild(placeholder);
  }
  container.appendChild(fragment);
}

function renderSavedAudiosMessage(container, { icon, title, body, actions = [] }) {
  if (!container) return;
  container.setAttribute('aria-busy', 'false');
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  wrapper.setAttribute('role', 'status');

  if (icon) {
    const iconWrap = document.createElement('div');
    iconWrap.className = 'empty-state-icon';
    iconWrap.innerHTML = icon;
    wrapper.appendChild(iconWrap);
  }

  if (title) {
    const titleEl = document.createElement('strong');
    titleEl.textContent = title;
    wrapper.appendChild(titleEl);
  }

  if (body) {
    const bodyEl = document.createElement('p');
    bodyEl.textContent = body;
    wrapper.appendChild(bodyEl);
  }

  if (actions.length) {
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'empty-state-actions';
    actions.forEach((action) => {
      if (!action || typeof action.label !== 'string') return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-ghost${action.variant === 'danger' ? ' btn-ghost-danger' : ''}`;
      btn.textContent = action.label;
      if (typeof action.onClick === 'function') {
        btn.addEventListener('click', action.onClick);
      }
      actionsWrap.appendChild(btn);
    });
    wrapper.appendChild(actionsWrap);
  }

  container.appendChild(wrapper);
}

function renderSavedAudiosEmpty(container) {
  const openFileButton = document.getElementById('openFileBtn');
  const addUrlButton = document.getElementById('openUrlModalBtn');
  renderSavedAudiosMessage(container, {
    icon: LIBRARY_EMPTY_ICON,
    title: 'Your library is empty',
    body: 'Import a file, paste text, or add a URL to get started.',
    actions: [
      {
        label: 'Open File…',
        onClick: () => {
          if (openFileButton) openFileButton.click();
        }
      },
      {
        label: 'Add URL…',
        onClick: () => {
          if (addUrlButton) addUrlButton.click();
        }
      }
    ]
  });
}

function renderSavedAudiosError(container, message) {
  renderSavedAudiosMessage(container, {
    icon: LIBRARY_ERROR_ICON,
    title: 'Unable to load library',
    body: message || 'Try again in a moment.',
    actions: [
      {
        label: 'Retry',
        onClick: () => {
          refreshSavedAudios();
        }
      }
    ]
  });
}

function getDateSegmentFromRelPath(relPath) {
  if (!relPath) return '';
  const [first] = String(relPath).split('/');
  return first || '';
}

function formatLibraryDate(relPath) {
  const rawSegment = getDateSegmentFromRelPath(relPath);
  if (!rawSegment) return '—';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawSegment)) return rawSegment;
  const parts = rawSegment.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return rawSegment;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return rawSegment;
  try {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) {
    return rawSegment;
  }
}

function getBaseName(input) {
  if (!input) return '';
  const parts = String(input).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function extractDomain(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.hostname || '').replace(/^www\./i, '');
  } catch (_) {
    return '';
  }
}

function getTimestampFromFileName(name) {
  const match = String(name || '').match(/^(\d{6,})_/);
  return match ? match[1] : '';
}

function deriveDefaultLabel(file) {
  return String(file && file.name ? file.name : '').replace(/\.wav$/i, '');
}

function deriveLabelFromMetadata(file, metadata) {
  if (!metadata) return null;
  if (metadata.title && typeof metadata.title === 'string' && metadata.title.trim()) {
    return metadata.title.trim();
  }
  const kind = (metadata.source_kind || '').toLowerCase();
  if (kind === 'text') {
    const ts = getTimestampFromFileName(file && file.name);
    return ts ? `quick-${ts}` : 'Quick capture';
  }
  if (metadata.source_url) {
    if (kind === 'file') {
      return getBaseName(metadata.source_url) || null;
    }
    if (kind === 'url') {
      return extractDomain(metadata.source_url) || getBaseName(metadata.source_url);
    }
  }
  return null;
}

function deriveLibrarySubtitle(metadata, currentLabel) {
  if (!metadata) return '';
  const kind = (metadata.source_kind || '').toLowerCase();
  let subtitle = '';
  if (kind === 'url' && metadata.source_url) {
    subtitle = extractDomain(metadata.source_url);
  } else if (kind === 'file' && metadata.source_url) {
    subtitle = getBaseName(metadata.source_url);
  } else if (kind === 'text') {
    subtitle = 'Quick capture';
  }
  if (!subtitle) return '';
  if (currentLabel && subtitle.toLowerCase() === currentLabel.toLowerCase()) {
    return '';
  }
  return subtitle;
}

function isWavItem(item) {
  return item && item.type === 'file' && /\.wav$/i.test(item.name || '');
}

function renderSavedAudiosTree(container, items) {
  if (!container) return;
  const wavItems = (items || []).filter(isWavItem).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  if (!wavItems.length) {
    renderSavedAudiosEmpty(container);
    return;
  }

  container.setAttribute('aria-busy', 'false');
  container.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'list';
  list.setAttribute('role', 'list');

  const fragment = document.createDocumentFragment();

  wavItems.forEach((file) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.setAttribute('role', 'listitem');
    row.setAttribute('tabindex', '0');
    row.dataset.relPath = file.relPath || '';
    if (activeLibraryRelPath && row.dataset.relPath === activeLibraryRelPath) {
      row.classList.add('is-active');
    }

    const main = document.createElement('div');
    main.className = 'list-main';

    const dot = document.createElement('span');
    dot.className = 'list-dot';
    main.appendChild(dot);

    const textWrap = document.createElement('div');
    textWrap.className = 'list-text';

    const titleEl = document.createElement('div');
    titleEl.className = 'list-title';
    const defaultLabel = deriveDefaultLabel(file);
    titleEl.textContent = defaultLabel || 'Saved audio';
    textWrap.appendChild(titleEl);

    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'list-meta';
    subtitleEl.textContent = '';
    subtitleEl.hidden = true;
    textWrap.appendChild(subtitleEl);

    main.appendChild(textWrap);
    row.appendChild(main);

    const dateEl = document.createElement('div');
    dateEl.className = 'list-date';
    dateEl.textContent = formatLibraryDate(file.relPath);
    row.appendChild(dateEl);

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'row-actions';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-ghost btn-ghost-danger';
    deleteBtn.textContent = 'Delete';
    actionsWrap.appendChild(deleteBtn);

    row.appendChild(actionsWrap);

    row.setAttribute('aria-label', titleEl.textContent);

    let cachedMeta = null;
    let metadataPromise = null;

    const applyMetadata = (metadata) => {
      if (!metadata) return null;
      cachedMeta = metadata;
      const labelFromMeta = deriveLabelFromMetadata(file, metadata);
      if (labelFromMeta) {
        titleEl.textContent = labelFromMeta;
        row.setAttribute('aria-label', labelFromMeta);
      }
      const subtitle = deriveLibrarySubtitle(metadata, titleEl.textContent);
      if (subtitle) {
        subtitleEl.textContent = subtitle;
        subtitleEl.hidden = false;
      } else {
        subtitleEl.textContent = '';
        subtitleEl.hidden = true;
      }
      return cachedMeta;
    };

    const ensureMetadata = () => {
      if (cachedMeta) return Promise.resolve(cachedMeta);
      if (!metadataPromise) {
        metadataPromise = (async () => {
          try {
            const alignRel = String(file.relPath || '').replace(/\.wav$/i, '.align.ndjson');
            const metaRes = await window.api.filesystem.getSavedAudioAlignment(alignRel);
            if (metaRes && metaRes.ok && metaRes.metadata) {
              return applyMetadata(metaRes.metadata);
            }
          } catch (err) {
            console.warn('Failed to load saved audio metadata', err);
          }
          return null;
        })().then((result) => {
          if (!result) metadataPromise = null;
          return result;
        });
      }
      return metadataPromise;
    };

    // Prefetch metadata quietly to improve perceived performance
    ensureMetadata();

    const openRow = async () => {
      const metadata = await ensureMetadata();
      if (!metadata) return;
      setActiveLibraryRow(file.relPath || null);
      await openSavedRecording(metadata, file.relPath);
    };

    row.addEventListener('click', () => {
      openRow();
    });

    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openRow();
      }
    });

    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const ok = confirm(`Delete ${file.name}?`);
      if (!ok) return;
      try {
        const res = await window.api.filesystem.deleteSavedAudio(file.relPath);
        if (res && res.ok) {
          if (activeLibraryRelPath && activeLibraryRelPath === file.relPath) {
            setActiveLibraryRow(null);
          }
          await refreshSavedAudios();
        }
      } catch (err) {
        console.error('Failed to delete saved audio', err);
      }
    });

    fragment.appendChild(row);
  });

  list.appendChild(fragment);
  container.appendChild(list);
  setActiveLibraryRow(activeLibraryRelPath);
}

async function refreshSavedAudios({ showSkeleton = true } = {}) {
  const status = document.getElementById('status');
  const container = document.getElementById('savedAudios');
  if (!container) return;
  try {
    if (showSkeleton && !savedAudiosLoading) {
      renderSavedAudiosSkeleton(container);
    }
    savedAudiosLoading = true;
    const res = await window.api.filesystem.listSavedAudios();
    const items = Array.isArray(res && res.items) ? res.items : [];
    renderSavedAudiosTree(container, items);
  } catch (err) {
    console.error(err);
    if (status) status.textContent = `Error: ${err && err.message ? err.message : 'Library failed to load'}`;
    renderSavedAudiosError(container, err && err.message ? err.message : '');
  } finally {
    savedAudiosLoading = false;
    container.setAttribute('aria-busy', 'false');
  }
}

// Initial load of saved audios on app start
refreshSavedAudios();

function getContentTypeForPath(filePath) {
  if (!filePath) return 'text/plain';
  const lower = filePath.toLowerCase();
  if (isHtmlPath(lower)) return 'text/html';
  if (isPdfPath(lower)) return 'application/pdf';
  return 'text/plain';
}

async function openSavedRecording(metadata, wavRelPath) {
  try {
    const previewEl = document.getElementById('preview');
    const textArea = document.getElementById('text');
    const voiceInput = document.getElementById('voice');
    const speedInput = document.getElementById('speed');
    const langInput = document.getElementById('lang');

    navigateToPreview();
    setActiveLibraryRow(wavRelPath || null);

    // If saved recording came from a PDF source, attempt to re-render the PDF for preview for best highlighting
    const kind = (metadata.source_kind || '').toLowerCase();
    const rawType = (metadata.raw_content_type || '').toLowerCase();
    const srcUrl = metadata.source_url || null;
    const isPdf = rawType.includes('application/pdf') || (srcUrl && /\.pdf($|\?)/i.test(srcUrl));
    if (isPdf && window.pdfjsLib) {
      try {
        // Prefer to re-fetch via URL for URL-based sources
        if (kind === 'url' && srcUrl) {
          const res = await window.api.filesystem.fetchUrl(srcUrl);
          if (res && res.ok && res.bodyBase64 && /application\/pdf/i.test(res.contentType || '')) {
            await renderPdfFromBytes(b64ToUint8Array(res.bodyBase64), srcUrl);
          } else {
            // Fallback to text-only preview
            const safe = window.DOMPurify.sanitize(metadata.preview_html || '', { USE_PROFILES: { html: true } });
            previewEl.innerHTML = safe;
            onPreviewDomUpdated();
          }
        } else if (kind === 'file' && srcUrl && srcUrl.startsWith('file://')) {
          const absPath = srcUrl.replace(/^file:\/\//, '');
          const rf = await window.api.filesystem.readFileBase64(absPath);
          if (rf && rf.ok && rf.base64) {
            await renderPdfFromBytes(b64ToUint8Array(rf.base64), srcUrl);
          } else {
            const safe = window.DOMPurify.sanitize(metadata.preview_html || '', { USE_PROFILES: { html: true } });
            previewEl.innerHTML = safe;
            onPreviewDomUpdated();
          }
        } else {
          const safe = window.DOMPurify.sanitize(metadata.preview_html || '', { USE_PROFILES: { html: true } });
          previewEl.innerHTML = safe;
          onPreviewDomUpdated();
        }
      } catch (_) {
        const safe = window.DOMPurify.sanitize(metadata.preview_html || '', { USE_PROFILES: { html: true } });
        previewEl.innerHTML = safe;
        onPreviewDomUpdated();
      }
      textArea.value = metadata.text || '';
    } else {
      const safe = window.DOMPurify.sanitize(metadata.preview_html || '', { USE_PROFILES: { html: true } });
      previewEl.innerHTML = safe;
      textArea.value = metadata.text || '';
      onPreviewDomUpdated();
    }

    const appliedVoice = metadata.voice || voiceInput.value || 'af_heart';
    voiceInput.value = appliedVoice;
    const appliedLang = metadata.lang_code || langInput.value || 'a';
    langInput.value = appliedLang;
    let appliedSpeed = currentOptions.speed;
    if (typeof metadata.speed === 'number') {
      appliedSpeed = clampSpeed(metadata.speed);
    } else if (speedInput.value) {
      const parsedSpeed = parseFloat(speedInput.value);
      if (Number.isFinite(parsedSpeed)) {
        appliedSpeed = clampSpeed(parsedSpeed);
      }
    }
    speedInput.value = String(appliedSpeed);
    currentOptions.voice = appliedVoice;
    currentOptions.lang = appliedLang;
    currentOptions.speed = appliedSpeed;
    setSpeedValueDisplay(appliedSpeed);
    persistOptions(currentOptions);

    currentPreviewHtml = metadata.preview_html || null;
    currentSourceKind = metadata.source_kind || 'text';
    currentSourceUrl = metadata.source_url || null;
    currentRawContent = metadata.raw_content || metadata.text || '';
    currentRawContentType = metadata.raw_content_type || 'text/plain';
    currentTitle = metadata.title || null;

    navigateToPreview();

    clearAudioSource();
    if (wavRelPath && audioElement) {
      try {
        const fileRes = await window.api.filesystem.getSavedAudioFileUrl(wavRelPath);
        if (fileRes && fileRes.ok && fileRes.url) {
          audioElement.src = fileRes.url; // do not autoplay
        }
      } catch (_) {
        // ignore
      }
    }

    captureAlignmentMetadata(metadata);
  } catch (e) {
    console.error('Failed to open saved recording:', e);
  }
}
