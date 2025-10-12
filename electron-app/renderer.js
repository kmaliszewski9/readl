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
  } catch (err) {
    console.error(err);
    status.textContent = `Error: ${err.message}`;
  }
}

function stopPlayback() {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
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
      const metaRes = await window.api.getSavedAudioMetadata(file.relPath);
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
        const metaRes = await window.api.getSavedAudioMetadata(file.relPath);
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
  } catch (e) {
    console.error('Failed to open saved recording:', e);
  }
}
