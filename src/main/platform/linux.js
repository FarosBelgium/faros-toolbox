// Linux (Debian/Ubuntu): the apps are .deb packages that install into /opt/<productName>.
// Installing or removing a package is system-wide, so it goes through pkexec, which
// shows the desktop's password prompt. Several updates are installed with one apt-get
// call, so "Update all" asks for the password only once.

const fs = require('fs');
const { run, launchDetached, sleep } = require('../run');

const exePath = (app) => `/opt/${app.productName}/${app.executable}`;

async function detect(app) {
  const r = await run('dpkg-query', ['-W', '-f=${Status}\t${Version}', app.id]);
  const [status = '', version = ''] = r.stdout.split('\t');
  if (r.code !== 0 || !/ installed$/.test(status.trim())) return { installed: false };
  // Debian may add a revision (1.2.0-1); the apps' own versions never have one.
  return { installed: true, version: version.trim().replace(/-\d+$/, ''), location: `/opt/${app.productName}`, exe: exePath(app) };
}

// Chromium can start processes with the "no new privileges" flag; setuid programs such as
// pkexec can't work in such a process (and neither in its children).
function hasNoNewPrivs() {
  try { return /^NoNewPrivs:\s*1$/m.test(fs.readFileSync('/proc/self/status', 'utf8')); } catch { return false; }
}

function pkexecError(r, what) {
  if (r.code === 126) return new Error('Cancelled: no password entered');
  if (r.code === 127) {
    return new Error(hasNoNewPrivs()
      ? 'Could not ask for your password. Close Faros Toolbox completely, start it again from the applications menu and try again.'
      : 'Not allowed to install software (pkexec refused). Is a polkit agent running?');
  }
  if (r.code === -1 && /ENOENT/.test(r.stderr)) return new Error('pkexec is not installed (sudo apt install pkexec)');
  const lines = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).filter((l) => /^(E:|dpkg:|error)/i.test(l));
  if (lines.some((l) => /lock/i.test(l))) return new Error('Another program is installing software (apt is locked). Try again in a minute.');
  return new Error(`${what} failed${lines.length ? `: ${lines.slice(-2).join(' ')}` : ` (exit code ${r.code})`}`);
}

const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-o', 'DPkg::Lock::Timeout=120', '-y'];

// items: [{ app, file }]  (file = verified .deb on disk)
async function install(items) {
  // apt-get resolves the packages' dependencies; --allow-downgrades so a reinstall of an
  // older release (e.g. after a pulled release) works too.
  const r = await run('pkexec', [...APT, '--allow-downgrades', 'install', ...items.map((i) => i.file)]);
  if (r.code !== 0) throw pkexecError(r, 'Installation');
}

async function uninstall(app) {
  // "remove" (not "purge") keeps the user's settings in ~/.config/<app>.
  const r = await run('pkexec', [...APT, 'remove', app.id]);
  if (r.code !== 0) throw pkexecError(r, 'Uninstall');
}

async function isRunning(app) {
  const r = await run('pgrep', ['-f', `^${exePath(app)}`]);
  return r.code === 0;
}

async function stop(app) {
  await run('pkill', ['-TERM', '-f', `^${exePath(app)}`]);
  for (let i = 0; i < 50 && (await isRunning(app)); i++) await sleep(200);
  if (await isRunning(app)) await run('pkill', ['-KILL', '-f', `^${exePath(app)}`]);
}

function launch(app) {
  launchDetached(exePath(app));
}

module.exports = { detect, install, uninstall, isRunning, stop, launch, hasNoNewPrivs, batchInstall: true, needsPassword: true };
