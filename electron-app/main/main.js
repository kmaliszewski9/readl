const { app } = require('electron');
const { createLogger } = require('./logger');
const { createWindowManager } = require('./window-manager');
const { createMenuManager } = require('./menu-manager');
const { createKokoroService } = require('./kokoro-service');
const { registerIpcHandlers } = require('./ipc-handlers');
const { setupAppEvents } = require('./app-events');

const logger = createLogger('main');
const windowManager = createWindowManager({ logger });
const menuManager = createMenuManager({ logger });
const kokoroService = createKokoroService({ logger });

registerIpcHandlers({ kokoroService, logger });

setupAppEvents({
  app,
  windowManager,
  menuManager,
  kokoroService,
  logger,
});




