// Windows: the apps ship an NSIS installer that installs per user (no admin rights)
// into %LOCALAPPDATA%\Programs\<productName>. "/S" runs it silently; installing over an
// existing version updates it in place. The installed version is read from the
// uninstall entry the installer writes in the registry.

const fs = require('fs');
const path = require('path');
const { run, launchDetached, sleep } = require('../run');

const UNINSTALL_KEYS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// Parses `reg query <key> /s` into { subkey: { name: value } }.
function parseReg(text) {
  const keys = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { current = keys[line.trim()] = {}; continue; }
    const m = current && line.match(/^\s{4}(.+?)\s{4}(REG_\w+)\s{4}(.*)$/);
    if (m) current[m[1]] = m[3];
  }
  return keys;
}

let regCache = null; // one registry scan per refresh, shared by all apps
async function uninstallEntries() {
  if (regCache && Date.now() - regCache.at < 2000) return regCache.entries;
  const entries = [];
  for (const key of UNINSTALL_KEYS) {
    const r = await run('reg', ['query', key, '/s']);
    if (r.code === 0) entries.push(...Object.values(parseReg(r.stdout)));
  }
  regCache = { at: Date.now(), entries };
  return entries;
}

function exeIn(dir, app) { return path.join(dir, `${app.productName}.exe`); }

async function detect(app) {
  const entry = (await uninstallEntries()).find((e) => e.DisplayName && (e.DisplayName === app.productName || e.DisplayName.startsWith(`${app.productName} `)));
  if (entry) {
    const location = (entry.InstallLocation || '').replace(/^"|"$/g, '');
    const exe = location ? exeIn(location, app) : null;
    if (!exe || fs.existsSync(exe)) return { installed: true, version: entry.DisplayVersion || null, location, exe, uninstallString: entry.UninstallString };
  }
  return { installed: false };
}

// The installer exits once it is done; an exit code other than 0 means it failed.
async function install(items) {
  for (const { app, file } of items) {
    regCache = null;
    const r = await run(file, ['/S']);
    if (r.code !== 0) throw new Error(`${app.name} installer failed (exit code ${r.code})`);
  }
  regCache = null;
}

async function uninstall(app) {
  regCache = null;
  const info = await detect(app);
  if (!info.installed || !info.uninstallString) throw new Error(`${app.name} has no uninstaller`);
  const m = info.uninstallString.match(/^"([^"]+)"\s*(.*)$/) || info.uninstallString.match(/^(\S+)\s*(.*)$/);
  const args = [...m[2].split(/\s+/).filter(Boolean), '/S'];
  const r = await run(m[1], args);
  if (r.code !== 0) throw new Error(`Uninstall failed (exit code ${r.code})`);
  // The NSIS uninstaller copies itself to %TEMP% and returns before it is finished.
  for (let i = 0; i < 100; i++) {
    regCache = null;
    if (!(await detect(app)).installed) break;
    await sleep(300);
  }
  regCache = null;
}

async function isRunning(app) {
  const r = await run('tasklist', ['/FI', `IMAGENAME eq ${app.productName}.exe`, '/NH', '/FO', 'CSV']);
  return r.stdout.toLowerCase().includes(`"${app.productName.toLowerCase()}.exe"`);
}

async function stop(app) {
  await run('taskkill', ['/IM', `${app.productName}.exe`, '/T']);
  for (let i = 0; i < 25 && (await isRunning(app)); i++) await sleep(200);
  if (await isRunning(app)) await run('taskkill', ['/IM', `${app.productName}.exe`, '/T', '/F']);
}

async function launch(app) {
  const info = await detect(app);
  const exe = info.exe || exeIn(path.join(process.env.LOCALAPPDATA || '', 'Programs', app.productName), app);
  launchDetached(exe);
}

module.exports = { detect, install, uninstall, isRunning, stop, launch, parseReg, batchInstall: false, needsPassword: false };
