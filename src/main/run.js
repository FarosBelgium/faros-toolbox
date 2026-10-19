// Runs a program and collects its output. Never goes through a shell, so file names
// and versions can't be interpreted as shell syntax.

const { spawn } = require('child_process');

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...opts });
    } catch (e) {
      resolve({ code: -1, stdout, stderr: String(e.message || e) });
      return;
    }
    child.stdout && child.stdout.on('data', (d) => { stdout += d; });
    child.stderr && child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e.message || e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Environment for starting an installed app: without the variables that make an
// Electron binary behave differently (e.g. run as plain Node) when inherited from us.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^ELECTRON_/.test(k) || k === 'CHROME_DESKTOP' || k === 'GIO_LAUNCHED_DESKTOP_FILE' || k === 'GIO_LAUNCHED_DESKTOP_FILE_PID') delete env[k];
  }
  return env;
}

function launchDetached(cmd, args = []) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: cleanEnv(), windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { run, cleanEnv, launchDetached, sleep };
