// Installs, detects and uninstalls a real app from its GitHub Release with the Linux
// backend (pkexec + apt-get), like a user clicking Install / Uninstall.
//   xvfb-run -a electron test/linux-install-test.js [app id]      (default: vpnmaster)
// pkexec asks for a password: on CI a polkit rule allows it (see .github/workflows).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { Manager } = require('../src/main/manager');
const linux = require('../src/main/platform/linux');

const id = process.argv.slice(2).find((a) => !a.startsWith('-')) || 'vpnmaster';
const fail = (msg) => { console.log(`  ✗ ${msg}`); app.exit(1); };

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faros-toolbox-install-'));
  const manager = new Manager({ platform: linux, downloadDir: tmp, confirm: async () => true, log: (l) => console.log(`    ${l}`) });
  await manager.refresh();
  let s = manager.snapshot().apps.find((a) => a.id === id);
  if (!s.latest) return fail(`no release found for ${id}: ${s.feedError}`);
  if (s.installed) return fail(`${id} is already installed; run this on a machine without it`);
  console.log(`  latest ${id}: ${s.latest}`);

  await manager.install([id]);
  s = manager.snapshot().apps.find((a) => a.id === id);
  if (!s.installed || s.version !== s.latest) return fail(`install: installed=${s.installed} version=${s.version} error=${s.error}`);
  if (!fs.existsSync(`/opt/${manager.get(id).app.productName}`)) return fail('not in /opt');
  if (fs.readdirSync(tmp).length) return fail('download not cleaned up');
  console.log(`  ✓ installed ${id} ${s.version}`);

  if (!(await manager.uninstall(id))) return fail(`uninstall: ${manager.snapshot().apps.find((a) => a.id === id).error}`);
  console.log(`  ✓ uninstalled ${id}`);
  app.exit(0);
});
