// End-to-end tests. Runs inside Electron on Linux, Windows and macOS:
//   npm test            (on Linux: npm run test:headless, so no window pops up)
// Serves the apps' update feeds from a local HTTP server and "installs" into a temp
// folder (src/main/platform/fake.js), then drives the real UI.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { app, dialog, BrowserWindow } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faros-toolbox-test-'));
const system = path.join(tmp, 'system');
const feedDir = path.join(tmp, 'feed');
fs.mkdirSync(system);
process.env.FAROS_TOOLBOX_HOME = path.join(tmp, 'home');
process.env.FAROS_TOOLBOX_TEST_SYSTEM = system;

// Confirmation dialogs: answer with whatever the test sets here (0 = OK, 1 = Cancel).
let dialogAnswer = 0;
const dialogs = [];
dialog.showMessageBox = async (...args) => {
  const opts = args.length > 1 ? args[1] : args[0];
  dialogs.push(opts.message);
  return { response: dialogAnswer };
};

// ---- the feed server: <base>/<repo>/<latest*.yml | installer> ----
const REPOS = { shellfish: ['shellfish', 'Shellfish'], edbmax: ['edbmax', 'EDBMax'], vpnmaster: ['VpnMaster', 'VPNMaster'] };
const served = [];
const missing = new Set(); // repos that answer 404
const tampered = new Set(); // repos whose installer gets one byte flipped

function installerName(id, version) {
  const product = REPOS[id][1];
  if (process.platform === 'win32') return `${product}-Setup-${version}.exe`;
  if (process.platform === 'darwin') return `${product}-${version}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  return `${id}_${version}_amd64.deb`;
}

function publish(id, version) {
  const dir = path.join(feedDir, REPOS[id][0]);
  fs.mkdirSync(dir, { recursive: true });
  const name = installerName(id, version);
  const data = crypto.randomBytes(300 * 1024);
  fs.writeFileSync(path.join(dir, name), data);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const other = process.platform === 'darwin'
    ? `  - url: ${name.replace('.zip', '.dmg')}\n    sha512: AAAA\n    size: 1\n`
    : '';
  const yml = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${data.length}\n${other}path: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-19T10:00:00.000Z'\n`;
  const feedName = { linux: 'latest-linux.yml', win32: 'latest.yml', darwin: 'latest-mac.yml' }[process.platform];
  fs.writeFileSync(path.join(dir, feedName), yml);
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  served.push(rel);
  const repo = rel.split('/')[0];
  const file = path.join(feedDir, rel);
  if (missing.has(repo) || !file.startsWith(feedDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  let data = fs.readFileSync(file);
  if (tampered.has(repo) && !rel.endsWith('.yml')) { data = Buffer.from(data); data[1000] ^= 0xff; }
  res.writeHead(200, { 'Content-Length': data.length });
  res.end(data);
});

// ---- installed state before the toolbox starts ----
const installed = (id, version, running = false) => fs.writeFileSync(path.join(system, `${id}.json`), JSON.stringify({ version, running }));
const readInstalled = (id) => { try { return JSON.parse(fs.readFileSync(path.join(system, `${id}.json`), 'utf8')); } catch { return null; } };
const actions = () => { try { return fs.readFileSync(path.join(system, 'actions.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

publish('shellfish', '2.0.0');
publish('edbmax', '1.0.1');
publish('vpnmaster', '1.2.0');
installed('shellfish', '1.6.2');
installed('edbmax', '1.0.1');

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(50);
  }
}

process.on('unhandledRejection', (e) => { console.log('\nUNHANDLED:', (e && e.stack) || e); app.exit(3); });

server.listen(0, '127.0.0.1', () => {
  process.env.FAROS_TOOLBOX_FEED = `http://127.0.0.1:${server.address().port}/`;
  require('../src/main/main.js'); // the real app: window, tray, IPC, manager
});

app.whenReady().then(async () => {
  console.log(`Faros Toolbox e2e on ${process.platform}-${process.arch}, Electron ${process.versions.electron}`);
  await until(() => process.env.FAROS_TOOLBOX_FEED, 5000, 'feed server');
  const main = require('../src/main/main.js');
  const win = await until(() => BrowserWindow.getAllWindows()[0], 10000, 'main window');
  await until(() => !win.webContents.isLoading(), 10000, 'window load');
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') console.log(`      [renderer ${e.level}] ${e.message}`); });
  const js = (code) => win.webContents.executeJavaScript(code);
  const manager = await until(() => main.getManager(), 5000, 'manager');
  const appState = (id) => manager.snapshot().apps.find((a) => a.id === id);
  const rowText = (id) => js(`(document.querySelector('.app[data-id="${id}"]') || {}).innerText || ''`);
  const click = (id, action) => js(`document.querySelector('.app[data-id="${id}"] [data-action="${action}"]').click()`);
  const listOf = (id) => js(`(document.querySelector('.app[data-id="${id}"]') || {parentElement:{}}).parentElement.id`);

  // ---- pure functions ----
  await test('version comparison', async () => {
    const { compareVersions } = require('../src/main/feed');
    assert(compareVersions('1.10.0', '1.9.9') > 0, '1.10.0 > 1.9.9');
    assert(compareVersions('v1.2.0', '1.2') === 0, 'v1.2.0 == 1.2');
    assert(compareVersions('1.2.0-beta.1', '1.2.0') < 0, 'prerelease sorts first');
    assert(compareVersions('2.0.0', '10.0.0') < 0, 'numeric, not text');
  });

  await test('feed parsing picks the installer for each OS', async () => {
    const { parseFeed } = require('../src/main/feed');
    const mac = `version: 1.6.2\nfiles:\n  - url: Shellfish-1.6.2-mac-x64.zip\n    sha512: aaa\n    size: 10\n  - url: Shellfish-1.6.2-mac-arm64.zip\n    sha512: bbb\n    size: 11\n  - url: Shellfish-1.6.2-mac-arm64.dmg\n    sha512: ccc\n    size: 12\npath: Shellfish-1.6.2-mac-x64.zip\nsha512: aaa\nreleaseDate: '2026-10-17T15:07:44.939Z'\n`;
    assert(parseFeed(mac, 'darwin', 'arm64').file.sha512 === 'bbb', 'arm64 zip');
    assert(parseFeed(mac, 'darwin', 'x64').file.url === 'Shellfish-1.6.2-mac-x64.zip', 'x64 zip');
    const deb = parseFeed('version: 1.0.1\nfiles:\n  - url: edbmax_1.0.1_amd64.deb\n    sha512: x==\n    size: 137488800\npath: edbmax_1.0.1_amd64.deb\n', 'linux');
    assert(deb.version === '1.0.1' && deb.file.url === 'edbmax_1.0.1_amd64.deb' && deb.file.size === 137488800, 'deb');
    const exe = parseFeed('version: 1.2.0\nfiles:\n  - url: VPNMaster-Setup-1.2.0.exe\n    sha512: y==\n    size: 5\n', 'win32');
    assert(exe.file.url === 'VPNMaster-Setup-1.2.0.exe', 'exe');
    let threw = false;
    try { parseFeed('nothing: here'); } catch { threw = true; }
    assert(threw, 'feed without version is rejected');
  });

  await test('Windows registry parsing', async () => {
    const { parseReg } = require('../src/main/platform/win32');
    const keys = parseReg('\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\6e1b-guid\r\n    DisplayName    REG_SZ    Shellfish 1.6.2\r\n    DisplayVersion    REG_SZ    1.6.2\r\n    InstallLocation    REG_SZ    C:\\Users\\x\\AppData\\Local\\Programs\\Shellfish\r\n    UninstallString    REG_SZ    "C:\\Users\\x\\AppData\\Local\\Programs\\Shellfish\\Uninstall Shellfish.exe" /currentuser\r\n');
    const e = Object.values(keys)[0];
    assert(e.DisplayVersion === '1.6.2' && e.InstallLocation.endsWith('\\Shellfish') && e.UninstallString.includes('/currentuser'), JSON.stringify(e));
  });

  if (process.platform === 'linux') {
    await test('Linux: detects installed .deb packages with dpkg', async () => {
      const linux = require('../src/main/platform/linux');
      const none = await linux.detect({ id: 'faros-toolbox-no-such-package', productName: 'X', executable: 'x' });
      assert(none.installed === false, 'unknown package is not installed');
      const r = require('child_process').spawnSync('dpkg-query', ['-W', '-f=${Version}', 'dpkg']);
      const dpkg = await linux.detect({ id: 'dpkg', productName: 'X', executable: 'x' });
      assert(dpkg.installed && dpkg.version === String(r.stdout).replace(/-\d+$/, ''), JSON.stringify(dpkg));
    });
  }

  // ---- the app, against the local feeds ----
  await test('startup check: installed apps, updates and available apps are listed', async () => {
    await until(() => manager.snapshot().lastCheck, 10000, 'first check');
    await until(async () => (await rowText('shellfish')).includes('2.0.0'), 5000, 'shellfish row with new version');
    assert(await listOf('shellfish') === 'list-installed', 'shellfish under Installed');
    assert(await listOf('edbmax') === 'list-installed', 'edbmax under Installed');
    assert(await listOf('vpnmaster') === 'list-available', 'vpnmaster under Available');
    assert((await rowText('shellfish')).includes('1.6.2'), 'shows installed version');
    assert(appState('shellfish').updateAvailable && !appState('edbmax').updateAvailable, 'only shellfish has an update');
    assert(await js(`!document.querySelector('#updates-banner').classList.contains('hidden')`), 'update banner shown');
    assert((await js(`document.querySelector('#updates-text').textContent`)).includes('Shellfish'), 'banner names Shellfish');
    assert(await js(`!!document.querySelector('.app[data-id="edbmax"] [data-action="open"]')`), 'up-to-date app has Open');
    assert(await js(`!!document.querySelector('.app[data-id="vpnmaster"] [data-action="install"]')`), 'available app has Install');
    assert(served.some((s) => s.startsWith('VpnMaster/')), 'feed fetched per repo');
  });

  await test('install an app from the UI', async () => {
    await click('vpnmaster', 'install');
    await until(async () => (await listOf('vpnmaster')) === 'list-installed', 8000, 'vpnmaster installed');
    assert(readInstalled('vpnmaster').version === '1.2.0', 'installed version 1.2.0');
    assert((await rowText('vpnmaster')).includes('1.2.0'), 'row shows 1.2.0');
    assert(served.includes(`VpnMaster/${installerName('vpnmaster', '1.2.0')}`), 'installer downloaded');
    const downloads = path.join(process.env.FAROS_TOOLBOX_HOME, 'downloads');
    assert(fs.readdirSync(downloads).length === 0, 'download removed after install');
  });

  await test('a tampered download is rejected and nothing is installed', async () => {
    tampered.add('shellfish');
    await click('shellfish', 'update');
    await until(async () => (await rowText('shellfish')).includes('corrupt'), 8000, 'corrupt error');
    assert(readInstalled('shellfish').version === '1.6.2', 'still 1.6.2');
    assert(!actions().some((a) => a.includes('shellfish')), 'installer never ran');
    const downloads = path.join(process.env.FAROS_TOOLBOX_HOME, 'downloads');
    assert(fs.readdirSync(downloads).length === 0, `no partial file left: ${fs.readdirSync(downloads)}`);
    tampered.delete('shellfish');
  });

  await test('update an app from the banner', async () => {
    await js(`document.querySelector('#btn-update-all').click()`);
    await until(() => readInstalled('shellfish').version === '2.0.0', 8000, 'shellfish 2.0.0');
    await until(async () => !(await rowText('shellfish')).includes('→'), 5000, 'no update arrow');
    assert(!appState('shellfish').error, `no error: ${appState('shellfish').error}`);
    await until(() => js(`document.querySelector('#updates-banner').classList.contains('hidden')`), 3000, 'banner hidden');
  });

  await test('a running app: cancel postpones, OK closes, updates and restarts it', async () => {
    publish('vpnmaster', '1.3.0');
    installed('vpnmaster', '1.2.0', true);
    await manager.refresh();
    assert(appState('vpnmaster').updateAvailable && appState('vpnmaster').running, 'update for running app');
    assert((await rowText('vpnmaster')).includes('1.3.0'), 'row shows 1.3.0');

    dialogAnswer = 1;
    const before = dialogs.length;
    await manager.install(['vpnmaster']);
    assert(dialogs.length === before + 1 && /running/.test(dialogs[before]), 'asked to close it');
    assert(readInstalled('vpnmaster').version === '1.2.0', 'not updated after Cancel');
    assert(/postponed/.test(appState('vpnmaster').error), 'postponed message');

    dialogAnswer = 0;
    await manager.install(['vpnmaster']);
    assert(readInstalled('vpnmaster').version === '1.3.0', 'updated after OK');
    const log = actions().slice(-3);
    assert(log[0] === 'stop vpnmaster' && log[1] === 'install vpnmaster' && log[2] === 'launch vpnmaster', `order: ${log}`);
    assert(readInstalled('vpnmaster').running, 'started again');
  });

  await test('Update all installs several apps with one installer run', async () => {
    publish('shellfish', '2.1.0');
    publish('edbmax', '1.1.0');
    installed('vpnmaster', '1.3.0', false);
    await manager.refresh();
    await until(async () => (await js(`document.querySelector('#updates-text').textContent`)) === '2 updates available', 3000, 'banner with 2 updates');
    await js(`document.querySelector('#btn-update-all').click()`);
    await until(() => readInstalled('shellfish').version === '2.1.0' && readInstalled('edbmax').version === '1.1.0', 8000, 'both updated');
    const installs = actions().filter((a) => a.startsWith('install '));
    assert(installs[installs.length - 1] === 'install shellfish,edbmax' || installs[installs.length - 1] === 'install edbmax,shellfish', `one batch: ${installs.slice(-2)}`);
  });

  await test('a failed install (e.g. password prompt cancelled) shows the error', async () => {
    publish('edbmax', '1.2.0');
    await manager.refresh();
    fs.writeFileSync(path.join(system, 'fail-install'), '');
    await click('edbmax', 'update');
    await until(async () => (await rowText('edbmax')).includes('no password entered'), 8000, 'error shown');
    assert(readInstalled('edbmax').version === '1.1.0', 'still old version');
    assert(await js(`!!document.querySelector('.app[data-id="edbmax"] [data-action="update"]')`), 'Update button back');
    fs.rmSync(path.join(system, 'fail-install'));
    // The verified installer was kept, so retrying doesn't download it again.
    const before = served.filter((s) => s.endsWith(installerName('edbmax', '1.2.0'))).length;
    await manager.install(['edbmax']);
    assert(readInstalled('edbmax').version === '1.2.0', 'retry worked');
    assert(served.filter((s) => s.endsWith(installerName('edbmax', '1.2.0'))).length === before, 'no second download');
  });

  await test('automatic updates skip apps that are running', async () => {
    publish('shellfish', '2.2.0');
    publish('vpnmaster', '1.4.0');
    installed('vpnmaster', '1.3.0', true);
    main.getSettings().update({ autoUpdate: true });
    const before = dialogs.length;
    await main.checkForUpdates({ background: true });
    assert(readInstalled('shellfish').version === '2.2.0', 'shellfish auto-updated');
    assert(readInstalled('vpnmaster').version === '1.3.0', 'running vpnmaster left alone');
    assert(dialogs.length === before, 'no dialog for automatic updates');
    assert(appState('vpnmaster').updateAvailable, 'vpnmaster update still offered');
    main.getSettings().update({ autoUpdate: false });
  });

  await test('the ⋯ menu: uninstall after confirmation', async () => {
    await js(`document.querySelector('.app[data-id="edbmax"] [data-action="menu"]').click()`);
    const items = await js(`[...document.querySelectorAll('#menu .menu-item')].map((b) => b.textContent)`);
    assert(items.includes('Uninstall…') && items.some((t) => t.startsWith('Release notes')), `menu: ${items}`);
    dialogAnswer = 1;
    await js(`[...document.querySelectorAll('#menu .menu-item')].find((b) => b.textContent === 'Uninstall…').click()`);
    await wait(300);
    assert(readInstalled('edbmax'), 'Cancel keeps it');
    dialogAnswer = 0;
    await manager.uninstall('edbmax');
    assert(!readInstalled('edbmax'), 'uninstalled');
    await until(async () => (await listOf('edbmax')) === 'list-available', 3000, 'edbmax back under Available');
  });

  await test('Open launches the installed app', async () => {
    installed('shellfish', '2.2.0', false);
    await manager.detectAll();
    await click('shellfish', 'open');
    await until(() => readInstalled('shellfish').running, 3000, 'launched');
    await until(async () => (await rowText('shellfish')).includes('running'), 3000, 'running pill');
  });

  await test('an app without releases shows a message instead of Install', async () => {
    missing.add('edbmax');
    await manager.refresh();
    assert(appState('edbmax').feedError === 'No release published yet', appState('edbmax').feedError);
    assert((await rowText('edbmax')).includes('No release published yet'), 'shown in the row');
    missing.delete('edbmax');
    await manager.refresh();
    assert(!appState('edbmax').feedError && appState('edbmax').installable, 'recovers');
  });

  await test('settings are saved', async () => {
    await js(`document.querySelector('#btn-settings').click()`);
    assert(await js(`!document.querySelector('#view-settings').classList.contains('hidden')`), 'settings view');
    assert(await js(`document.querySelector('[data-setting="autoCheck"]').checked`), 'autoCheck on by default');
    await js(`(() => { const i = document.querySelector('[data-setting="notify"]'); i.click(); })()`);
    const file = path.join(process.env.FAROS_TOOLBOX_HOME, 'settings.json');
    await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).notify === false, 3000, 'notify=false saved');
    await js(`document.querySelector('#btn-back').click()`);
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
