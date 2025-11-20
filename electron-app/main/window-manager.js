const { BrowserWindow } = require('electron');
const path = require('path');

function createWindowManager({ logger }) {
  const log = logger ? logger.child('window') : null;
  const trackedWindows = new Set();

  function createMainWindow() {
    const win = new BrowserWindow({
      width: 900,
      height: 700,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    trackedWindows.add(win);

    win.on('closed', () => {
      trackedWindows.delete(win);
      if (log) log.info('Main window closed');
    });

    win.maximize();
    win.loadFile(path.join(__dirname, '..', 'index.html'));

    if (log) log.info('Main window created');

    return win;
  }

  function ensureMainWindow() {
    const existing = BrowserWindow.getAllWindows();
    if (!existing.length) {
      return createMainWindow();
    }
    return existing[0];
  }

  function allWindows() {
    return Array.from(trackedWindows);
  }

  return {
    createMainWindow,
    ensureMainWindow,
    allWindows,
  };
}

module.exports = {
  createWindowManager,
};

