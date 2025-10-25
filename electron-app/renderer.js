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
let generateBtn = null;
let optionsToggleBtn = null;
let optionsCloseBtn = null;
let optionsDoneBtn = null;
let optionsDrawer = null;
let optionsBackdrop = null;
let speedValueLabel = null;
let isGenerating = false;
let activeSynthesis = null;
let optionsDrawerOpen = false;
let currentOptions = {
  voice: 'af_heart',
  lang: 'a',
  speed: 1
};
let isCancelling = false;
// Gate status updates from stop button when we're cancelling synthesis mid-flight.
let suppressNextStopStatus = false;
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
  if (isCancelling) {
    generateBtn.disabled = true;
    return;
  }
  if (isGenerating) {
    generateBtn.disabled = false;
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

function setGeneratingState(active) {
  isGenerating = !!active;
  if (!isGenerating) {
    isCancelling = false;
  }
  if (!generateBtn) return;
  if (isGenerating) {
    generateBtn.textContent = 'Cancel';
    generateBtn.classList.add('btn-danger');
  } else {
    generateBtn.textContent = 'Generate';
    generateBtn.classList.remove('btn-danger');
  }
  updateGenerateAvailability();
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
  if (isCancelling) {
    return;
  }
  if (isGenerating) {
    cancelSynthesis({ userInitiated: true });
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

async function startSynthesis() {
  if (isGenerating || isCancelling) {
    return;
  }
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
    split_pattern: '\n+',
    preview_html: currentPreviewHtml,
    source_kind: currentSourceKind,
    source_url: currentSourceUrl,
    raw_content: currentRawContent,
    raw_content_type: currentRawContentType,
    title: currentTitle
  };

  status.textContent = 'Synthesizing…';
  resetAlignmentState();
  clearAudioSource();
  setGeneratingState(true);

  try {
    const ws = new WebSocket('ws://127.0.0.1:8000/ws/synthesize');
    const synthesis = {
      socket: ws,
      jobId: null,
      terminalSeen: false,
      cancelled: false
    };
    activeSynthesis = synthesis;

    const closeWs = (code) => {
      try { ws.close(code || 1000); } catch (_) {}
    };

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'start', request: payload }));
      } catch (err) {
        console.error('Failed to send start message:', err);
        status.textContent = `Error: ${err && err.message ? err.message : 'WebSocket send failed'}`;
        hideProgressUi();
        setGeneratingState(false);
        activeSynthesis = null;
        closeWs(1011);
      }
    };

    ws.onmessage = async (ev) => {
      if (activeSynthesis !== synthesis) return;
      try {
        const msg = JSON.parse(ev.data);
        if (!msg || typeof msg !== 'object') return;
        if (!synthesis.jobId && msg.job_id) synthesis.jobId = msg.job_id;
        switch (msg.type) {
          case 'started':
            status.textContent = 'Synthesizing…';
            showProgressUi(0);
            break;
          case 'segment':
            if (typeof msg.progress === 'number') {
              const pct = Math.round(msg.progress * 100);
              updateProgressUi(pct);
              status.textContent = `Synthesizing… ${pct}%`;
            } else {
              status.textContent = 'Synthesizing…';
            }
            break;
          case 'complete': {
            synthesis.terminalSeen = true;
            try {
              if (!msg.ok || !msg.wav_rel_path) throw new Error('Invalid complete message');
              const fileRes = await window.api.getSavedAudioFileUrl(msg.wav_rel_path);
              if (!fileRes || !fileRes.ok || !fileRes.url) throw new Error('Could not resolve saved file URL');
              audioElement.src = fileRes.url;
              await audioElement.play();
              status.textContent = 'Playing';
              updateProgressUi(100);
              hideProgressUi({ resetWidth: false });
              refreshSavedAudios();
              if (msg.align_rel_path) {
                const metaRes = await window.api.getSavedAudioAlignment(msg.align_rel_path);
                if (metaRes && metaRes.ok && metaRes.metadata) {
                  captureAlignmentMetadata(metaRes.metadata);
                }
              }
            } catch (err) {
              console.error('Completion handling failed:', err);
              status.textContent = `Error: ${err && err.message ? err.message : 'Playback failed'}`;
              hideProgressUi();
            }
            setGeneratingState(false);
            activeSynthesis = null;
            closeWs(1000);
            break;
          }
          case 'cancelled':
            synthesis.terminalSeen = true;
            status.textContent = 'Cancelled';
            hideProgressUi();
            setGeneratingState(false);
            activeSynthesis = null;
            closeWs(1000);
            break;
          case 'error':
            synthesis.terminalSeen = true;
            status.textContent = `Error: ${msg && msg.message ? msg.message : 'Unknown error'}`;
            hideProgressUi();
            setGeneratingState(false);
            activeSynthesis = null;
            closeWs(1011);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('WS message handling failed:', err);
      }
    };

    ws.onerror = (ev) => {
      if (activeSynthesis !== synthesis) return;
      console.error('WebSocket error:', ev);
      status.textContent = 'Error: connection failed';
      hideProgressUi();
      setGeneratingState(false);
      activeSynthesis = null;
    };

    ws.onclose = () => {
      if (activeSynthesis !== synthesis) return;
      if (!synthesis.terminalSeen) {
        status.textContent = synthesis.cancelled ? 'Cancelled' : 'Connection closed';
        hideProgressUi();
      }
      setGeneratingState(false);
      activeSynthesis = null;
    };
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err && err.message ? err.message : 'WebSocket failed'}`;
    hideProgressUi();
    setGeneratingState(false);
    activeSynthesis = null;
  }
}

function cancelSynthesis({ userInitiated = false } = {}) {
  if (!activeSynthesis) return;
  const { socket } = activeSynthesis;
  activeSynthesis.cancelled = true;
  isCancelling = true;
  const status = document.getElementById('status');
  if (status) status.textContent = userInitiated ? 'Cancelling…' : 'Cancelling…';
  if (generateBtn) {
    generateBtn.classList.remove('btn-danger');
    generateBtn.textContent = 'Cancelling…';
    generateBtn.disabled = true;
  }
  suppressNextStopStatus = true;
  try {
    if (socket && socket.readyState === WebSocket.OPEN && activeSynthesis.jobId) {
      socket.send(JSON.stringify({ type: 'cancel', job_id: activeSynthesis.jobId }));
    }
  } catch (_err) {
    // ignore send failures during cancel
  }
  try {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      socket.close(1000);
    }
  } catch (_err) {
    // ignore close failures
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
  if (suppressNextStopStatus) {
    suppressNextStopStatus = false;
    return;
  }
  status.textContent = 'Stopped';
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
    const result = await window.api.openFile();
    if (!result || result.canceled) return;
    lastOpenedFilePath = result.filePath || null;
    resetAlignmentState();
    clearAudioSource();
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
  if (lastLoadedUrl && lastLoadedUrl === url) return;
  lastLoadedUrl = url;
  status.textContent = 'Loading URL…';
  try {
    const res = await window.api.fetchUrl(url);
    if (!res || !res.ok) {
      throw new Error(res && res.error ? res.error : 'Failed to load URL');
    }
    const contentType = (res.contentType || '').toLowerCase();
    resetAlignmentState();
    clearAudioSource();
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
      cancelSynthesis({ userInitiated: true });
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

    // If saved recording came from a PDF source, attempt to re-render the PDF for preview for best highlighting
    const kind = (metadata.source_kind || '').toLowerCase();
    const rawType = (metadata.raw_content_type || '').toLowerCase();
    const srcUrl = metadata.source_url || null;
    const isPdf = rawType.includes('application/pdf') || (srcUrl && /\.pdf($|\?)/i.test(srcUrl));
    if (isPdf && window.pdfjsLib) {
      try {
        // Prefer to re-fetch via URL for URL-based sources
        if (kind === 'url' && srcUrl) {
          const res = await window.api.fetchUrl(srcUrl);
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
          const rf = await window.api.readFileBase64(absPath);
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
        const fileRes = await window.api.getSavedAudioFileUrl(wavRelPath);
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
