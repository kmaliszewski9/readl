const fs = require('fs');
const path = require('path');
const readline = require('readline');

const audioStorePath = path.resolve(__dirname, '..', '..', 'electron-app', 'main', 'audio-store.js');
// eslint-disable-next-line import/no-dynamic-require, global-require
const { getAudiosRoot, listDirRecursive, statSafe } = require(audioStorePath);

function isWavFile(entry) {
  return entry && entry.type === 'file' && /\.wav$/i.test(entry.name || '');
}

function loadAlignmentMetadata(audioRoot, relPath) {
  const safeRel = relPath || '';
  const alignRel = safeRel.replace(/\.wav$/i, '.align.ndjson');
  const abs = path.resolve(audioRoot, alignRel);
  const stat = statSafe(abs);
  if (!stat || !stat.isFile()) return null;
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (!lines.length) return null;
    const header = JSON.parse(lines[0]);
    const segments = [];
    for (let i = 1; i < lines.length; i += 1) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj && obj.type === 'segment') segments.push(obj);
      } catch (_) {
        // ignore malformed lines
      }
    }
    const { type, version, ...rest } = header;
    return { ...rest, segments };
  } catch (err) {
    console.warn('Failed to parse alignment metadata for', relPath, err.message);
    return null;
  }
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

function deriveSourceLabel(metadata) {
  if (!metadata) return '';
  const kind = (metadata.source_kind || '').toLowerCase();
  if (kind === 'url') {
    return extractDomain(metadata.source_url) || metadata.source_url || '';
  }
  if (kind === 'file' && metadata.source_url) {
    const filePath = metadata.source_url.replace(/^file:\/\//i, '');
    return path.basename(filePath || metadata.source_url);
  }
  if (kind === 'text') {
    return 'text input';
  }
  return '';
}

function deriveTitle(metadata, relPath) {
  if (metadata && metadata.title) return metadata.title;
  if (metadata && metadata.source_kind === 'text') {
    const match = (relPath || '').match(/^(\d{6,})_/);
    if (match) return `quick-${match[1]}`;
    return 'quick-capture';
  }
  const parts = (relPath || '').split(/[\\/]/);
  return parts[parts.length - 1] || relPath;
}

async function listLibraryEntries({ limit, loadMetadata } = {}) {
  const audioRoot = getAudiosRoot();
  const entries = listDirRecursive(audioRoot, '')
    .filter(isWavFile)
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

  const maxEntries = Number.isFinite(limit) && limit > 0 ? limit : entries.length;
  const result = [];
  for (let i = 0; i < entries.length && result.length < maxEntries; i += 1) {
    const file = entries[i];
    const alignRelPath = (file.relPath || '').replace(/\.wav$/i, '.align.ndjson');
    let metadata = null;
    if (loadMetadata) {
      metadata = loadAlignmentMetadata(audioRoot, file.relPath);
    }
    const metadataTitle = metadata && metadata.title ? metadata.title : null;
    const title = metadataTitle || deriveTitle(metadata, file.relPath);
    const sourceKind = metadata && typeof metadata.source_kind === 'string'
      ? metadata.source_kind
      : null;
    const sourceUrl = metadata && metadata.source_url ? metadata.source_url : null;
    const durationSeconds = metadata && Number.isFinite(metadata.duration_seconds)
      ? metadata.duration_seconds
      : null;
    result.push({
      relPath: file.relPath,
      size_bytes: file.size,
      mtime_ms: file.mtimeMs,
      duration_seconds: durationSeconds,
      voice: metadata ? metadata.voice : null,
      title,
      source_kind: sourceKind,
      source_url: sourceUrl,
      source_label: deriveSourceLabel(metadata),
      align_rel_path: alignRelPath,
      metadata_loaded: Boolean(metadata),
    });
  }
  return result;
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = (answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function deleteLibraryEntry(relPath, { json, yes } = {}) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('relPath is required');
  }
  const audioRoot = getAudiosRoot();
  const normalizedRoot = path.resolve(audioRoot);
  const targetAbs = path.resolve(audioRoot, relPath);
  if (!targetAbs.startsWith(normalizedRoot + path.sep)) {
    throw new Error('Path is outside the audio directory');
  }
  const stat = statSafe(targetAbs);
  if (!stat) {
    throw new Error('Target not found');
  }

  if (!yes && process.stdin.isTTY && !json) {
    const confirmed = await promptYesNo(`Delete ${relPath}? [y/N] `);
    if (!confirmed) {
      console.log('Deletion cancelled.');
      return;
    }
  }

  if (stat.isDirectory()) {
    fs.rmSync(targetAbs, { recursive: true, force: true });
  } else {
    fs.unlinkSync(targetAbs);
    if (/\.wav$/i.test(targetAbs)) {
      const alignPath = targetAbs.replace(/\.wav$/i, '.align.ndjson');
      const alignStat = statSafe(alignPath);
      if (alignStat && alignStat.isFile()) {
        fs.unlinkSync(alignPath);
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, deleted: relPath }));
  } else {
    console.log(`Deleted ${relPath}`);
  }
}

module.exports = {
  listLibraryEntries,
  deleteLibraryEntry,
};
