const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: async () => {
    const result = await ipcRenderer.invoke('open-file-dialog');
    return result;
  },
  fetchUrl: async (url) => {
    const result = await ipcRenderer.invoke('fetch-url', url);
    return result;
  },
  readFileBase64: async (absPath) => {
    return await ipcRenderer.invoke('read-file-base64', absPath);
  },
  listSavedAudios: async () => {
    return await ipcRenderer.invoke('audios-list');
  },
  deleteSavedAudio: async (relPath) => {
    return await ipcRenderer.invoke('audios-delete', relPath);
  },
  getSavedAudioFileUrl: async (relPath) => {
    return await ipcRenderer.invoke('audios-file-url', relPath);
  },
  getSavedAudioAlignment: async (relPath) => {
    return await ipcRenderer.invoke('audios-read-align', relPath);
  },
  synthesize: async (request) => {
    return await ipcRenderer.invoke('kokoro-synthesize', request);
  },
  cancelSynthesis: async () => {
    await ipcRenderer.invoke('kokoro-cancel');
  }
});
