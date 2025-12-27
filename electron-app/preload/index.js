const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

const filesystem = {
  openFile: () => invoke('open-file-dialog'),
  fetchUrl: (url) => invoke('fetch-url', url),
  readFileBase64: (absPath) => invoke('read-file-base64', absPath),
  listSavedAudios: () => invoke('audios-list'),
  deleteSavedAudio: (relPath) => invoke('audios-delete', relPath),
  getSavedAudioFileUrl: (relPath) => invoke('audios-file-url', relPath),
  getSavedAudioAlignment: (relPath) => invoke('audios-read-align', relPath),
};

const voices = {
  list: () => invoke('kokoro-voices-list'),
};

const phonemizer = {
  phonemize: ({ text, language, normalize } = {}) => (
    invoke('kokoro-phonemize', { text, language, normalize })
  ),
};

const engine = {
  synthesize: (request) => invoke('kokoro-synthesize', request),
  cancel: () => invoke('kokoro-cancel'),
  /**
   * Subscribe to synthesis progress updates.
   * @param {(info: {done: number, total: number, pct: number}) => void} handler
   * @returns {() => void} Unsubscribe function
   */
  onProgress: (handler) => {
    const listener = (_event, info) => {
      if (typeof handler === 'function') {
        handler(info);
      }
    };
    ipcRenderer.on('kokoro-progress', listener);
    return () => {
      ipcRenderer.off('kokoro-progress', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', {
  filesystem,
  voices,
  phonemizer,
  engine,
});










