const { testFeedBase } = require('../feed');

function load() {
  if (process.env.FAROS_TOOLBOX_TEST_SYSTEM && testFeedBase()) return require('./fake');
  if (process.platform === 'linux') return require('./linux');
  if (process.platform === 'win32') return require('./win32');
  if (process.platform === 'darwin') return require('./darwin');
  throw new Error(`Unsupported platform: ${process.platform}`);
}

module.exports = load();
