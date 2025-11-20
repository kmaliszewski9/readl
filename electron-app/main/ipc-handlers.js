const { dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { getAudiosRoot, listDirRecursive, statSafe } = require('./audio-store');
const { KokoroTTS, phonemizeDetailed } = require('kokoro-js');

const voicesGetter = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(KokoroTTS.prototype, 'voices');
  return descriptor && typeof descriptor.get === 'function' ? descriptor.get : null;
})();

function getVoiceMetadataList() {
  if (!voicesGetter) return [];
  try {
    const raw = voicesGetter.call({});
    return Object.entries(raw || {}).map(([id, meta]) => ({
      id,
      ...meta,
    }));
  } catch (_) {
    return [];
  }
}

function registerHandler(channel, handler) {
  try {
    ipcMain.removeHandler(channel);
  } catch (_) {}
  ipcMain.handle(channel, handler);
}

function registerIpcHandlers({ kokoroService, logger }) {
  const log = logger ? logger.child('ipc') : null;

  registerHandler('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['html', 'htm', 'txt', 'pdf'] },
      ],
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const filePath = result.filePaths[0];
    try {
      if (/\.pdf$/i.test(filePath)) {
        const buf = fs.readFileSync(filePath);
        return {
          canceled: false,
          filePath,
          contentBase64: buf.toString('base64'),
          contentType: 'application/pdf',
        };
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return { canceled: false, filePath, content };
    } catch (err) {
      return { canceled: true, error: err.message };
    }
  });

  registerHandler('fetch-url', async (_event, urlInput) => {
    try {
      if (!urlInput || typeof urlInput !== 'string') {
        return { ok: false, error: 'Invalid URL' };
      }

      const trimmed = urlInput.trim();
      const normalized = /^(https?:\/\/)/i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;

      const res = await fetch(normalized, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      const contentType = res.headers.get('content-type') || '';
      if (/application\/pdf/i.test(contentType)) {
        const ab = await res.arrayBuffer();
        return {
          ok: true,
          url: res.url || normalized,
          contentType,
          bodyBase64: Buffer.from(ab).toString('base64'),
        };
      }

      const body = await res.text();
      return {
        ok: true,
        url: res.url || normalized,
        contentType,
        body,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  registerHandler('audios-list', async () => {
    const root = getAudiosRoot();
    const items = listDirRecursive(root, '');
    return { root, items };
  });

  registerHandler('audios-delete', async (_event, relPath) => {
    try {
      if (typeof relPath !== 'string' || !relPath) {
        return { ok: false, error: 'Invalid path' };
      }

      const root = getAudiosRoot();
      const target = path.resolve(root, relPath);
      const normalizedRoot = path.resolve(root);
      if (!target.startsWith(normalizedRoot + path.sep) && target !== normalizedRoot) {
        return { ok: false, error: 'Path outside audios root' };
      }

      const st = statSafe(target);
      if (!st) return { ok: false, error: 'Not found' };

      if (st.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
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
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  registerHandler('audios-file-url', async (_event, relPath) => {
    try {
      if (typeof relPath !== 'string' || !relPath) {
        return { ok: false, error: 'Invalid path' };
      }

      const root = getAudiosRoot();
      const target = path.resolve(root, relPath);
      const normalizedRoot = path.resolve(root);
      if (!target.startsWith(normalizedRoot + path.sep) && target !== normalizedRoot) {
        return { ok: false, error: 'Path outside audios root' };
      }

      const st = statSafe(target);
      if (!st || !st.isFile()) {
        return { ok: false, error: 'File not found' };
      }

      return { ok: true, url: `file://${target}` };
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  registerHandler('audios-read-align', async (_event, relPath) => {
    try {
      if (typeof relPath !== 'string' || !relPath) {
        return { ok: false, error: 'Invalid path' };
      }

      const root = getAudiosRoot();
      const alignAbs = path.resolve(root, relPath);
      const normalizedRoot = path.resolve(root);
      if (!alignAbs.startsWith(normalizedRoot + path.sep)) {
        return { ok: false, error: 'Path outside audios root' };
      }
      if (!/\.align\.ndjson$/i.test(alignAbs)) {
        return { ok: false, error: 'Not an .align.ndjson path' };
      }

      const st = statSafe(alignAbs);
      if (!st || !st.isFile()) {
        return { ok: false, error: 'Alignment not found' };
      }

      const raw = fs.readFileSync(alignAbs, 'utf8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (!lines.length) {
        return { ok: false, error: 'Empty alignment file' };
      }

      const header = JSON.parse(lines[0]);
      if (!header || header.type !== 'header') {
        return { ok: false, error: 'Invalid alignment header' };
      }

      const segments = [];
      for (let i = 1; i < lines.length; i += 1) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj && obj.type === 'segment') segments.push(obj);
        } catch (_) {
          // Ignore malformed lines
        }
      }

      const { type, version, ...rest } = header || {};
      const metadata = { ...rest, segments };
      return { ok: true, metadata };
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  registerHandler('kokoro-synthesize', (_event, payload) => {
    return kokoroService.run(payload || {});
  });

  registerHandler('kokoro-cancel', async () => {
    if (kokoroService && typeof kokoroService.cancelActiveJob === 'function') {
      kokoroService.cancelActiveJob();
    }
  });

  registerHandler('kokoro-voices-list', async () => {
    try {
      const voices = getVoiceMetadataList();
      return { ok: true, voices };
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  registerHandler('kokoro-phonemize', async (_event, payload) => {
    try {
      const text = typeof payload?.text === 'string' ? payload.text : '';
      if (!text.trim()) {
        return { ok: false, error: 'Text is required' };
      }
      const languageInput = (() => {
        if (payload && typeof payload.language === 'string' && payload.language.trim()) {
          return payload.language.trim();
        }
        if (payload && typeof payload.lang === 'string' && payload.lang.trim()) {
          return payload.lang.trim();
        }
        return 'a';
      })();
      const normalize = typeof payload?.normalize === 'boolean' ? payload.normalize : true;
      const { phonemes, tokens } = await phonemizeDetailed(text, languageInput, normalize);
      return { ok: true, phonemes, tokens };
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  registerHandler('read-file-base64', async (_event, absPath) => {
    try {
      if (typeof absPath !== 'string' || !absPath) {
        return { ok: false, error: 'Invalid path' };
      }

      const st = statSafe(absPath);
      if (!st || !st.isFile()) {
        return { ok: false, error: 'Not found' };
      }

      const buf = fs.readFileSync(absPath);
      return { ok: true, base64: buf.toString('base64') };
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
      };
    }
  });

  if (log) log.info('IPC handlers registered');
}

module.exports = {
  registerIpcHandlers,
};

