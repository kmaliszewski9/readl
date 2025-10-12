const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Register IPC handler early to avoid race conditions
try { ipcMain.removeHandler('open-file-dialog'); } catch (e) {}
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Documents', extensions: ['html', 'htm', 'md', 'markdown', 'txt'] }
    ]
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
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
      // Also remove sidecar metadata JSON if deleting a WAV file
      if (/\.wav$/i.test(target)) {
        const metaPath = target.replace(/\.wav$/i, '.json');
        try {
          const metaStat = statSafe(metaPath);
          if (metaStat && metaStat.isFile()) {
            fs.unlinkSync(metaPath);
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

// IPC: read metadata JSON (sidecar next to .wav)
try { ipcMain.removeHandler('audios-read-meta'); } catch (e) {}
ipcMain.handle('audios-read-meta', async (_event, relPath) => {
  try {
    if (typeof relPath !== 'string' || !relPath) return { ok: false, error: 'Invalid path' };
    const root = getAudiosRoot();
    const wavAbs = path.resolve(root, relPath);
    if (!wavAbs.startsWith(path.resolve(root) + path.sep)) {
      return { ok: false, error: 'Path outside audios root' };
    }
    const metaAbs = wavAbs.replace(/\.wav$/i, '.json');
    const st = statSafe(metaAbs);
    if (!st || !st.isFile()) return { ok: false, error: 'Metadata not found' };
    const raw = fs.readFileSync(metaAbs, 'utf8');
    const json = JSON.parse(raw);
    return { ok: true, metadata: json };
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


