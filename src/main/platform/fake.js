// Test double for the end-to-end tests: "installs" into a folder instead of the real
// system. Only used when FAROS_TOOLBOX_TEST_SYSTEM is set together with a loopback
// test feed (see platform/index.js). <dir>/<id>.json holds { version, running }.

const fs = require('fs');
const path = require('path');

const dir = () => process.env.FAROS_TOOLBOX_TEST_SYSTEM;
const file = (app) => path.join(dir(), `${app.id}.json`);
const read = (app) => { try { return JSON.parse(fs.readFileSync(file(app), 'utf8')); } catch { return null; } };
const write = (app, data) => fs.writeFileSync(file(app), JSON.stringify(data));
const log = (line) => fs.appendFileSync(path.join(dir(), 'actions.log'), `${line}\n`);

async function detect(app) {
  const d = read(app);
  return d ? { installed: true, version: d.version, location: file(app), exe: file(app) } : { installed: false };
}

async function install(items) {
  if (fs.existsSync(path.join(dir(), 'fail-install'))) throw new Error('Cancelled: no password entered');
  log(`install ${items.map((i) => i.app.id).join(',')}`);
  for (const { app, file: installer } of items) {
    const version = path.basename(installer).match(/(\d+\.\d+\.\d+)/)[1];
    write(app, { ...(read(app) || {}), version, running: false });
  }
}

async function uninstall(app) { log(`uninstall ${app.id}`); fs.rmSync(file(app), { force: true }); }
async function isRunning(app) { return !!(read(app) || {}).running; }
async function stop(app) { log(`stop ${app.id}`); const d = read(app); if (d) write(app, { ...d, running: false }); }
async function launch(app) { log(`launch ${app.id}`); const d = read(app); if (d) write(app, { ...d, running: true }); }

module.exports = { detect, install, uninstall, isRunning, stop, launch, batchInstall: true, needsPassword: false };
