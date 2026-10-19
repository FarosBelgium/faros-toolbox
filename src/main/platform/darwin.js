// macOS: the toolbox installs from the release's .zip: it unpacks <productName>.app
// and puts it in /Applications (or ~/Applications when /Applications isn't writable).
// The apps aren't signed with an Apple Developer certificate, which is why they can't
// replace themselves; the toolbox can, because it simply replaces the bundle.
// Files downloaded by the toolbox don't get the "downloaded from the internet"
// quarantine flag, so macOS doesn't block the first start either.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const { run, cleanEnv, sleep } = require('../run');

const candidates = (app) => [
  path.join('/Applications', `${app.productName}.app`),
  path.join(os.homedir(), 'Applications', `${app.productName}.app`),
];

async function bundleVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const r = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function detect(app) {
  for (const p of candidates(app)) {
    if (fs.existsSync(p)) return { installed: true, version: await bundleVersion(p), location: p, exe: p };
  }
  return { installed: false };
}

// Apple Silicon or Intel, also when the toolbox itself runs under Rosetta.
let realArch = null;
async function cpuArch() {
  if (!realArch) {
    const r = await run('sysctl', ['-n', 'hw.optional.arm64']);
    realArch = r.stdout.trim() === '1' ? 'arm64' : 'x64';
  }
  return realArch;
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

async function install(items) {
  for (const { app, file } of items) {
    const existing = (await detect(app)).location;
    const targetDir = existing ? path.dirname(existing) : (writable('/Applications') ? '/Applications' : path.join(os.homedir(), 'Applications'));
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${app.productName}.app`);

    // Unpack next to the target (same volume), then swap the bundles.
    const tmp = fs.mkdtempSync(path.join(targetDir, '.faros-toolbox-'));
    try {
      const r = await run('ditto', ['-x', '-k', file, tmp]);
      if (r.code !== 0) throw new Error(`Could not unpack ${path.basename(file)}: ${r.stderr.trim()}`);
      const unpacked = path.join(tmp, `${app.productName}.app`);
      if (!fs.existsSync(unpacked)) throw new Error(`${app.productName}.app not found in ${path.basename(file)}`);
      await run('xattr', ['-dr', 'com.apple.quarantine', unpacked]);
      if (fs.existsSync(target)) fs.renameSync(target, path.join(tmp, 'old.app'));
      fs.renameSync(unpacked, target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

async function uninstall(app) {
  const info = await detect(app);
  if (info.installed) await shell.trashItem(info.location); // to the Trash, not deleted
}

async function isRunning(app) {
  const info = await detect(app);
  if (!info.installed) return false;
  const r = await run('pgrep', ['-f', `^${info.location}/Contents/MacOS/`]);
  return r.code === 0;
}

async function stop(app) {
  await run('osascript', ['-e', `tell application id "${app.appId}" to quit`]);
  for (let i = 0; i < 50 && (await isRunning(app)); i++) await sleep(200);
  const info = await detect(app);
  if (info.installed && (await isRunning(app))) await run('pkill', ['-KILL', '-f', `^${info.location}/Contents/MacOS/`]);
}

async function launch(app) {
  const info = await detect(app);
  if (info.installed) await run('open', [info.location], { env: cleanEnv() });
}

module.exports = { detect, install, uninstall, isRunning, stop, launch, cpuArch, batchInstall: false, needsPassword: false };
