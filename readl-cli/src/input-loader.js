const fs = require('fs');
const path = require('path');
const { Readability } = require('@mozilla/readability');
const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');
let pdfjsLibPromise = null;

async function getPdfModule() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.js').then((mod) => {
      if (mod && mod.GlobalWorkerOptions) {
        mod.GlobalWorkerOptions.workerSrc = undefined;
      }
      return mod;
    });
  }
  return pdfjsLibPromise;
}

const USER_AGENT = 'ReadlCLI/0.1 (+https://github.com/your-org/readl)';

function ensureString(value) {
  return typeof value === 'string' ? value : '';
}

function stripHtml(html) {
  const { window } = new JSDOM('');
  const tmp = window.document.createElement('div');
  tmp.innerHTML = html || '';
  return tmp.textContent || tmp.innerText || '';
}

function sanitizeHtml(html) {
  const { window } = new JSDOM('');
  const DOMPurify = createDOMPurify(window);
  return DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });
}

function deriveTitleFromSource({ title, sourceKind, sourceUrl, fallbackPath }) {
  if (title && title.trim()) return title.trim();
  if (sourceKind === 'url' && sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.hostname) return parsed.hostname.replace(/^www\./i, '');
    } catch (_) {}
    return sourceUrl;
  }
  if (fallbackPath) {
    return path.basename(fallbackPath);
  }
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error('STDIN is not piped');
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function detectContentTypeFromPath(filePath) {
  if (!filePath) return 'text/plain';
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'text/plain';
}

async function extractPdfText(bytes) {
  const pdfjsLib = await getPdfModule();
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const parts = [];
  try {
    const count = pdf.numPages || 0;
    for (let i = 1; i <= count; i += 1) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const text = (textContent.items || [])
        .map((item) => (item && item.str) ? item.str : '')
        .join(' ')
        .trim();
      if (text) parts.push(text);
    }
  } finally {
    if (pdf && typeof pdf.destroy === 'function') {
      pdf.destroy();
    }
  }
  return parts.join('\n\n');
}

function extractHtmlArticle(html, baseUrl) {
  const dom = new JSDOM(html || '', { url: baseUrl || 'https://localhost' });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (article && article.content) {
    const safeHtml = sanitizeHtml(article.content);
    const textContent = (article.textContent || stripHtml(safeHtml)).trim();
    return {
      html: safeHtml,
      text: textContent,
      title: article.title || null,
    };
  }
  const bodyHtml = dom.window.document.body ? dom.window.document.body.innerHTML : html || '';
  const safeHtml = sanitizeHtml(bodyHtml);
  return {
    html: safeHtml,
    text: stripHtml(safeHtml).trim(),
    title: null,
  };
}

function buildPlainTextResult(text, { sourceKind, sourceUrl, title, rawContentType }) {
  const trimmed = ensureString(text).trim();
  if (!trimmed) {
    throw new Error('No text content found for synthesis');
  }
  const previewHtml = `<pre style="white-space:pre-wrap;">${sanitizeHtml(ensureString(text))}</pre>`;
  return {
    text: trimmed,
    metadata: {
      preview_html: previewHtml,
      raw_content: text,
      raw_content_type: rawContentType || 'text/plain',
      source_kind: sourceKind,
      source_url: sourceUrl || null,
      title: deriveTitleFromSource({ title, sourceKind, sourceUrl }),
    },
  };
}

function buildHtmlResult(html, { sourceKind, sourceUrl, title }) {
  const article = extractHtmlArticle(html, sourceUrl);
  const finalText = article.text && article.text.trim()
    ? article.text.trim()
    : stripHtml(html).trim();
  if (!finalText) {
    throw new Error('HTML input did not contain readable text');
  }
  return {
    text: finalText,
    metadata: {
      preview_html: article.html,
      raw_content: html,
      raw_content_type: 'text/html',
      source_kind: sourceKind,
      source_url: sourceUrl,
      title: deriveTitleFromSource({ title: title || article.title, sourceKind, sourceUrl }),
    },
  };
}

async function buildPdfResult(bytes, { sourceKind, sourceUrl, title }) {
  const text = (await extractPdfText(bytes)).trim();
  if (!text) {
    throw new Error('Unable to extract text from PDF');
  }
  return {
    text,
    metadata: {
      preview_html: null,
      raw_content: null,
      raw_content_type: 'application/pdf',
      source_kind: sourceKind,
      source_url: sourceUrl,
      title: deriveTitleFromSource({ title, sourceKind, sourceUrl }),
    },
  };
}

function normalizeUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function loadFromFile(filePath, opts) {
  const absPath = path.resolve(process.cwd(), filePath);
  const contentType = detectContentTypeFromPath(absPath);
  const sourceUrl = `file://${absPath}`;
  if (contentType === 'application/pdf') {
    const bytes = fs.readFileSync(absPath);
    return buildPdfResult(bytes, { sourceKind: 'file', sourceUrl, title: opts.title || path.basename(absPath) });
  }
  const raw = fs.readFileSync(absPath, 'utf8');
  if (contentType === 'text/html') {
    return buildHtmlResult(raw, { sourceKind: 'file', sourceUrl, title: opts.title || path.basename(absPath) });
  }
  return buildPlainTextResult(raw, {
    sourceKind: 'file',
    sourceUrl,
    title: opts.title || path.basename(absPath),
    rawContentType: 'text/plain',
  });
}

async function loadFromUrl(urlInput, opts) {
  const normalized = normalizeUrl(urlInput);
  if (!normalized) {
    throw new Error('Invalid URL');
  }
  const response = await fetch(normalized, {
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL (${response.status})`);
  }
  const finalUrl = response.url || normalized;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/pdf') || /\.pdf($|\?)/i.test(finalUrl)) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buildPdfResult(buffer, { sourceKind: 'url', sourceUrl: finalUrl, title: opts.title });
  }
  const body = await response.text();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    return buildHtmlResult(body, { sourceKind: 'url', sourceUrl: finalUrl, title: opts.title });
  }
  return buildPlainTextResult(body, {
    sourceKind: 'url',
    sourceUrl: finalUrl,
    title: opts.title,
    rawContentType: contentType || 'text/plain',
  });
}

function countDefinedSources(opts) {
  let count = 0;
  if (opts.text) count += 1;
  if (opts.textFile) count += 1;
  if (opts.url) count += 1;
  if (opts.stdin) count += 1;
  return count;
}

async function loadInput(opts = {}) {
  const totalSources = countDefinedSources(opts);
  let preferredSource = null;
  if (totalSources > 1) {
    throw new Error('Provide only one input source (text, --text-file, --stdin, or --url)');
  }
  if (opts.text) {
    preferredSource = 'text';
  } else if (opts.textFile) {
    preferredSource = 'file';
  } else if (opts.url) {
    preferredSource = 'url';
  } else if (opts.stdin || !process.stdin.isTTY) {
    preferredSource = 'stdin';
  }

  if (!preferredSource) {
    throw new Error('No input provided. Use --text, --text-file, --stdin, or --url.');
  }

  if (preferredSource === 'text') {
    return buildPlainTextResult(opts.text, {
      sourceKind: 'text',
      sourceUrl: null,
      title: opts.title,
      rawContentType: 'text/plain',
    });
  }

  if (preferredSource === 'stdin') {
    const stdinText = await readStdin();
    return buildPlainTextResult(stdinText, {
      sourceKind: 'text',
      sourceUrl: null,
      title: opts.title,
      rawContentType: 'text/plain',
    });
  }

  if (preferredSource === 'file') {
    return loadFromFile(opts.textFile, opts);
  }

  if (preferredSource === 'url') {
    return loadFromUrl(opts.url, opts);
  }

  throw new Error('Unsupported input source');
}

module.exports = {
  loadInput,
};
