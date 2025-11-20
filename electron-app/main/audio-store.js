const fs = require('fs');
const path = require('path');

function getAudiosRoot() {
  const envDir = process.env.READL_AUDIO_DIR;
  const base = envDir && envDir.trim().length > 0
    ? envDir
    : path.resolve(__dirname, '..', '..', 'audios');
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (_) {}
  return base;
}

function statSafe(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (_) {
    return null;
  }
}

function listDirRecursive(root, rel = '') {
  const full = path.join(root, rel);
  const entries = [];
  let names = [];

  try {
    names = fs.readdirSync(full);
  } catch (_) {
    return entries;
  }

  for (const name of names) {
    const childRel = path.join(rel, name);
    const childFull = path.join(root, childRel);
    const st = statSafe(childFull);
    if (!st) continue;
    if (st.isDirectory()) {
      entries.push({ type: 'dir', name, relPath: childRel });
      entries.push(...listDirRecursive(root, childRel));
    } else {
      entries.push({
        type: 'file',
        name,
        relPath: childRel,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  return entries;
}

module.exports = {
  getAudiosRoot,
  statSafe,
  listDirRecursive,
};

