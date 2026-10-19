const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, Notification, nativeImage } = require('electron');
const { Settings } = require('./settings');
const { Manager } = require('./manager');
const updater = require('./updater');

app.setName('faros-toolbox');
if (process.env.FAROS_TOOLBOX_HOME) app.setPath('userData', path.resolve(process.env.FAROS_TOOLBOX_HOME));

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const ASSETS = path.join(__dirname, '..', 'renderer', 'assets');
const startHidden = process.argv.includes('--hidden');
const isTest = !!process.env.FAROS_TOOLBOX_TEST_SYSTEM;

// One toolbox at a time; starting it again shows the window of the running one.
if (!isTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(start);
}

let win = null;
let tray = null;
let settings;
let manager;
let quitting = false;

function makeLogger() {
  const file = path.join(app.getPath('userData'), 'logs', 'toolbox.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.old`); } catch { /* no log yet */ }
  return (line) => { try { fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ } };
}

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 380,
    minHeight: 420,
    show: false,
    backgroundColor: '#14171c',
    title: 'Faros Toolbox',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden || !tray) win.show(); });

  // Never navigate away from the app or open new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Like JetBrains Toolbox: closing the window keeps the toolbox in the tray.
  win.on('close', (e) => {
    if (!quitting && tray && settings.get('closeToTray')) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  // Apps may have been started or closed in the meantime.
  win.on('focus', () => { if (manager && !manager.checking) manager.detectAll().catch(() => {}); });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
    tray = new Tray(img);
    tray.setToolTip('Faros Toolbox');
    tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
    updateTrayMenu();
  } catch {
    tray = null; // no tray on this desktop: closing the window quits
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const { apps } = manager.snapshot();
  const installed = apps.filter((a) => a.installed);
  const updates = apps.filter((a) => a.updateAvailable);
  const menu = Menu.buildFromTemplate([
    { label: 'Open Faros Toolbox', click: showWindow },
    { type: 'separator' },
    ...installed.map((a) => ({ label: `${a.name}${a.updateAvailable ? `  (update ${a.latest})` : ''}`, click: () => manager.launch(a.id) })),
    ...(installed.length ? [{ type: 'separator' }] : []),
    ...(updates.length ? [{ label: `Update all (${updates.length})`, click: () => manager.install(updates.map((a) => a.id)) }] : []),
    { label: 'Check for updates', click: () => checkForUpdates() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(updates.length ? `Faros Toolbox: ${updates.length} update${updates.length > 1 ? 's' : ''} available` : 'Faros Toolbox');
}

async function confirm({ title, message, detail, ok }) {
  const parent = win && win.isVisible() ? win : undefined;
  const opts = { type: 'question', title, message, detail, buttons: [ok, 'Cancel'], defaultId: 0, cancelId: 1, noLink: true };
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  return response === 0;
}

// Checks every app; notifies about new versions and, if enabled, installs them.
async function checkForUpdates({ background = false } = {}) {
  const updates = await manager.refresh();
  if (!background || !updates.length) return updates;

  if (settings.get('autoUpdate')) {
    await manager.install(updates.map((a) => a.id), { auto: true });
    return manager.updatesAvailable();
  }
  const seen = settings.get('notifiedVersions');
  const fresh = updates.filter((a) => seen[a.id] !== a.latest);
  if (fresh.length && settings.get('notify') && Notification.isSupported()) {
    const n = new Notification({
      title: fresh.length === 1 ? `${fresh[0].name} ${fresh[0].latest} is available` : `${fresh.length} updates available`,
      body: fresh.length === 1 ? `You have ${fresh[0].version}. Open Faros Toolbox to update.` : fresh.map((a) => `${a.name} ${a.latest}`).join(', '),
      icon: path.join(ASSETS, 'icon.png'),
    });
    n.on('click', showWindow);
    n.show();
  }
  for (const a of fresh) seen[a.id] = a.latest;
  settings.save();
  return updates;
}

// Start at login (hidden, in the tray). Linux has no API for it: a .desktop file in
// ~/.config/autostart does the same.
function applyLaunchAtLogin(enabled) {
  if (isTest || !app.isPackaged) return;
  if (process.platform === 'linux') {
    const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'faros-toolbox.desktop');
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Faros Toolbox\nExec="${process.execPath}" --hidden\nIcon=faros-toolbox\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      fs.rmSync(file, { force: true });
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

function registerIpc() {
  handle('apps:list', () => manager.snapshot());
  handle('apps:check', () => checkForUpdates().then(() => manager.snapshot()));
  handle('apps:install', (id) => manager.install([id]));
  handle('apps:updateAll', () => manager.install(manager.updatesAvailable().map((a) => a.id)));
  handle('apps:uninstall', (id) => manager.uninstall(id));
  handle('apps:launch', (id) => manager.launch(id));
  handle('apps:releaseNotes', (id) => {
    const a = manager.snapshot().apps.find((x) => x.id === id);
    if (a) shell.openExternal(a.releaseUrl);
  });
  handle('settings:get', () => ({ ...settings.public(), platform: process.platform, version: app.getVersion() }));
  handle('settings:set', (patch) => {
    const next = settings.update(patch);
    if (patch && 'launchAtLogin' in patch) applyLaunchAtLogin(next.launchAtLogin);
    return next;
  });
  handle('toolbox:status', () => updater.getStatus());
  handle('toolbox:check', () => updater.check());
  handle('toolbox:install', () => updater.install());
  handle('toolbox:logs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')));
}

async function start() {
  Menu.setApplicationMenu(null);
  settings = new Settings(app.getPath('userData'));
  const log = makeLogger();
  const platform = require('./platform');
  let arch = process.arch;
  if (process.platform === 'darwin' && platform.cpuArch) arch = await platform.cpuArch();
  manager = new Manager({
    platform,
    downloadDir: path.join(app.getPath('userData'), 'downloads'),
    confirm,
    log,
    arch,
  });
  manager.on('change', (snapshot) => {
    send('apps:changed', snapshot);
    updateTrayMenu();
  });
  log(`Faros Toolbox ${app.getVersion()} on ${process.platform}-${process.arch}`);

  registerIpc();
  createTray();
  createWindow();
  updater.init((status) => send('toolbox:status', status));

  await manager.detectAll();
  if (settings.get('autoCheck')) {
    checkForUpdates({ background: true }).catch((e) => log(`check failed: ${e.message}`));
    setInterval(() => {
      if (settings.get('autoCheck')) checkForUpdates({ background: true }).catch((e) => log(`check failed: ${e.message}`));
    }, CHECK_EVERY_MS).unref();
  } else {
    manager.refresh().catch(() => {}); // still show the latest versions once
  }
}

app.on('before-quit', () => { quitting = true; });
app.on('activate', showWindow); // macOS: click on the Dock icon
app.on('window-all-closed', () => {
  if (!tray || quitting || !settings.get('closeToTray')) app.quit();
});

module.exports = { getManager: () => manager, getSettings: () => settings, checkForUpdates };
