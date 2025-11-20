const { Menu } = require('electron');

function createMenuManager({ logger }) {
  const log = logger ? logger.child('menu') : null;

  function install() {
    const template = [];

    if (process.platform === 'darwin') {
      template.push({
        label: 'Readl',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      });
    }

    template.push(
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    );

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    if (log) log.info('Application menu installed');
  }

  return {
    install,
  };
}

module.exports = {
  createMenuManager,
};

