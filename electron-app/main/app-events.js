function isThenable(value) {
  return value && typeof value.then === 'function';
}

function setupAppEvents({
  app,
  windowManager,
  menuManager,
  kokoroService,
  logger,
}) {
  const log = logger ? logger.child('app') : null;

  async function handleReady() {
    if (log) log.info('App ready');
    if (menuManager && typeof menuManager.install === 'function') {
      menuManager.install();
    }
    windowManager.createMainWindow();
  }

  function handleActivate() {
    if (log) log.info('App activated');
    windowManager.ensureMainWindow();
  }

  function handleBeforeQuit() {
    if (log) log.info('App before-quit');
    if (kokoroService && typeof kokoroService.dispose === 'function') {
      const result = kokoroService.dispose();
      if (isThenable(result)) {
        result.catch((err) => {
          if (log) log.warn('Failed to dispose Kokoro worker', err);
        });
      }
    }
  }

  function handleWindowAllClosed() {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }

  app.whenReady()
    .then(handleReady)
    .catch((err) => {
      if (log) log.error('Failed during app readiness', err);
    });

  app.on('activate', handleActivate);
  app.on('before-quit', handleBeforeQuit);
  app.on('window-all-closed', handleWindowAllClosed);
}

module.exports = {
  setupAppEvents,
};

