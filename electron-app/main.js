const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

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

const workerRequests = new Map();
let kokoroWorker = null;

function resolveWorkerRequest(requestId, payload, { reject = false } = {}) {
  const pending = workerRequests.get(requestId);
  if (!pending) return;
  workerRequests.delete(requestId);
  if (reject) {
    pending.reject(payload);
  } else {
    pending.resolve(payload);
  }
}

function rejectAllWorkerRequests(error) {
  for (const pending of workerRequests.values()) {
    try {
      pending.reject(error);
    } catch (_) {}
  }
  workerRequests.clear();
}

function handleWorkerMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'result' || !msg.requestId) return;
  resolveWorkerRequest(msg.requestId, msg);
}

function handleWorkerError(err) {
  console.error('[kokoro-worker] error:', err);
  rejectAllWorkerRequests(err instanceof Error ? err : new Error(String(err)));
  if (kokoroWorker) {
    kokoroWorker.terminate().catch(() => {});
  }
  kokoroWorker = null;
}

function handleWorkerExit(code) {
  if (code !== 0) {
    console.warn(`[kokoro-worker] exited with code ${code}`);
  }
  rejectAllWorkerRequests(new Error('Kokoro worker exited'));
  kokoroWorker = null;
}

function ensureKokoroWorker() {
  if (kokoroWorker) return kokoroWorker;
  kokoroWorker = new Worker(path.join(__dirname, 'kokoro-worker.js'));
  kokoroWorker.on('message', handleWorkerMessage);
  kokoroWorker.on('error', handleWorkerError);
  kokoroWorker.on('exit', handleWorkerExit);
  return kokoroWorker;
}

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

try { ipcMain.removeHandler('kokoro-synthesize'); } catch (e) {}
ipcMain.handle('kokoro-synthesize', async (_event, payload) => {
  const requestId = (typeof payload?.request_id === 'string' && payload.request_id.length > 0)
    ? payload.request_id
    : `synth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const worker = ensureKokoroWorker();
  const requestPayload = { ...(payload || {}), request_id: requestId };
  const audioRoot = getAudiosRoot();
  const resultPromise = new Promise((resolve, reject) => {
    workerRequests.set(requestId, { resolve, reject });
  });
  try {
    worker.postMessage({
      type: 'synthesize',
      requestId,
      payload: requestPayload,
      audioRoot,
    });
  } catch (err) {
    const pending = workerRequests.get(requestId);
    if (pending) {
      workerRequests.delete(requestId);
      pending.reject(err);
    }
    return { ok: false, error: String(err && err.message ? err.message : err), request_id: requestId };
  }
  try {
    const response = await resultPromise;
    if (response && response.ok) {
      return { ok: true, request_id: requestId, ...response.result };
    }
    if (response && response.canceled) {
      return { ok: false, canceled: true, error: response.error || 'Synthesis canceled', request_id: requestId };
    }
    const message = response && response.error ? response.error : 'Synthesis failed';
    return { ok: false, error: message, request_id: requestId };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), request_id: requestId };
  }
});

try { ipcMain.removeHandler('kokoro-cancel'); } catch (e) {}
ipcMain.handle('kokoro-cancel', async (_event, rawRequestId) => {
  try {
    const requestId = (typeof rawRequestId === 'string' && rawRequestId.length > 0) ? rawRequestId : null;
    if (!requestId) {
      return { ok: false, error: 'Invalid request id' };
    }
    if (!workerRequests.has(requestId)) {
      return { ok: false, error: 'No active synthesis for request id' };
    }
    if (!kokoroWorker) {
      return { ok: false, error: 'No active worker' };
    }
    kokoroWorker.postMessage({ type: 'cancel', requestId });
    return { ok: true };
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

app.on('before-quit', () => {
  if (kokoroWorker) {
    kokoroWorker.terminate().catch(() => {});
    kokoroWorker = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
