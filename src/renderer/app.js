const $ = (sel) => document.querySelector(sel);

let snapshot = { apps: [], checking: false, lastCheck: null, needsPassword: false };
let settings = {};
let toolboxStatus = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

async function call(promise) {
  const res = await promise;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

const BUSY_LABEL = {
  queued: () => 'Waiting…',
  downloading: (a) => `Downloading ${a.percent}%`,
  closing: (a) => `Closing ${a.name}…`,
  installing: () => (snapshot.needsPassword ? 'Installing… (enter your password)' : 'Installing…'),
  uninstalling: () => (snapshot.needsPassword ? 'Uninstalling… (enter your password)' : 'Uninstalling…'),
};

function versionLine(a) {
  if (a.installed) {
    if (a.updateAvailable) return el('span', {}, a.version || '?', ' → ', el('b', { class: 'new' }, a.latest));
    return el('span', {}, a.version || 'unknown version', a.running ? el('span', { class: 'pill' }, 'running') : null);
  }
  if (a.latest) return el('span', {}, a.latest);
  return el('span', { class: 'muted' }, snapshot.checking ? 'checking…' : '');
}

function primaryButton(a) {
  if (a.busy) return null;
  if (a.installed && a.updateAvailable) return el('button', { class: 'btn primary small', 'data-action': 'update', onclick: () => act('install', a) }, 'Update');
  if (a.installed) return el('button', { class: 'btn small', 'data-action': 'open', onclick: () => act('launch', a) }, 'Open');
  if (!a.installable) return null;
  return el('button', { class: 'btn primary small', 'data-action': 'install', onclick: () => act('install', a) }, 'Install');
}

function appRow(a) {
  const busy = a.busy && el('div', { class: 'progress' },
    el('div', { class: 'bar' + (a.busy === 'downloading' ? '' : ' indeterminate') }, el('span', { style: a.busy === 'downloading' ? `width:${a.percent}%` : '' })),
    el('div', { class: 'progress-label' }, (BUSY_LABEL[a.busy] || (() => a.busy))(a)));

  const notice = !a.busy && (a.error || (!a.installed && a.feedError));
  return el('div', { class: `app${a.installed ? ' installed' : ''}`, 'data-id': a.id },
    el('img', { class: 'app-icon', src: a.icon, alt: '', ondblclick: () => a.installed && act('launch', a) }),
    el('div', { class: 'app-body' },
      el('div', { class: 'app-name' }, a.name),
      el('div', { class: 'app-version' }, versionLine(a)),
      !a.installed && el('div', { class: 'app-desc' }, a.description),
      busy,
      notice && el('div', { class: 'app-error' }, notice)),
    el('div', { class: 'app-actions' },
      primaryButton(a),
      el('button', { class: 'btn icon small', title: 'More', 'data-action': 'menu', onclick: (e) => openMenu(e, a) }, '⋯')));
}

function render() {
  const installed = snapshot.apps.filter((a) => a.installed);
  const available = snapshot.apps.filter((a) => !a.installed);
  $('#list-installed').replaceChildren(...installed.map(appRow));
  $('#list-available').replaceChildren(...available.map(appRow));
  $('#h-installed').classList.toggle('hidden', !installed.length);
  $('#h-available').classList.toggle('hidden', !available.length);

  const updates = snapshot.apps.filter((a) => a.updateAvailable && !a.busy);
  $('#updates-banner').classList.toggle('hidden', updates.length < 1);
  $('#updates-text').textContent = updates.length === 1 ? `Update available for ${updates[0].name}` : `${updates.length} updates available`;
  $('#btn-update-all').textContent = updates.length === 1 ? 'Update' : 'Update all';

  $('#btn-check').classList.toggle('spinning', snapshot.checking);
  renderFooter();
}

function renderFooter() {
  const parts = [snapshot.checking ? 'Checking for updates…' : `Checked ${ago(snapshot.lastCheck)}`];
  const footer = $('#footer');
  footer.replaceChildren(el('span', {}, parts.join('')), el('span', { class: 'spacer' }), toolboxBadge());
}

// The toolbox's own update, in the footer (and in detail on the settings page).
function toolboxBadge() {
  const s = toolboxStatus;
  if (!s) return null;
  if (s.state === 'ready') return el('button', { class: 'btn primary small', onclick: () => api.toolbox.install() }, s.platform === 'linux' ? `Install toolbox ${s.newVersion}` : `Restart to update`);
  if (s.state === 'available-manual') return el('button', { class: 'btn small', onclick: () => api.toolbox.install() }, `Toolbox ${s.newVersion}: download`);
  if (s.state === 'downloading') return el('span', { class: 'muted' }, `Toolbox update ${s.percent || 0}%`);
  return el('span', { class: 'muted' }, `v${s.version}`);
}

function renderToolboxUpdate() {
  const s = toolboxStatus || {};
  const text = {
    dev: 'Running from source: no updates.',
    idle: 'Not checked yet.',
    checking: 'Checking…',
    'up-to-date': `Up to date (checked ${ago(s.checkedAt)}).`,
    downloading: `Downloading ${s.newVersion} (${s.percent || 0}%)…`,
    ready: `Version ${s.newVersion} is ready to install.`,
    'available-manual': `Version ${s.newVersion} is available.`,
    error: s.message,
  }[s.state] || '';
  $('#toolbox-update').replaceChildren(
    el('div', {}, `Version ${s.version || '?'}`),
    el('div', { class: s.state === 'error' ? 'app-error' : 'muted' }, text),
    el('div', { class: 'row' },
      s.state !== 'dev' && el('button', { class: 'btn small', onclick: () => api.toolbox.check() }, 'Check now'),
      ['ready', 'available-manual'].includes(s.state) && el('button', { class: 'btn primary small', onclick: () => api.toolbox.install() }, s.state === 'ready' ? 'Install & restart' : 'Download')));
}

async function act(what, a) {
  closeMenu();
  try {
    await call(api.apps[what](a.id));
  } catch (e) {
    console.error(e);
  }
}

// ---- "⋯" menu ----
function openMenu(e, a) {
  e.stopPropagation();
  const items = [];
  if (a.installed && !a.busy) items.push(['Open', () => act('launch', a)]);
  if (a.installed && a.updateAvailable && !a.busy) items.push([`Update to ${a.latest}`, () => act('install', a)]);
  if (!a.installed && a.installable && !a.busy) items.push([`Install ${a.latest}`, () => act('install', a)]);
  items.push([a.latest ? `Release notes ${a.latest}` : 'Releases page', () => act('releaseNotes', a)]);
  if (a.installed && !a.busy) items.push(['Uninstall…', () => act('uninstall', a), 'danger']);

  const menu = $('#menu');
  menu.replaceChildren(...items.map(([label, fn, cls]) => el('button', { class: `menu-item ${cls || ''}`, onclick: fn }, label)));
  menu.classList.remove('hidden');
  const r = e.currentTarget.getBoundingClientRect();
  const h = menu.offsetHeight;
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(8, r.right - w)}px`;
  menu.style.top = `${r.bottom + h + 4 > window.innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
}
function closeMenu() { $('#menu').classList.add('hidden'); }
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); showView('apps'); } });
window.addEventListener('blur', closeMenu);

// ---- settings ----
function showView(name) {
  $('#view-apps').classList.toggle('hidden', name !== 'apps');
  $('#view-settings').classList.toggle('hidden', name !== 'settings');
}

async function loadSettings() {
  settings = await call(api.settings.get());
  for (const input of document.querySelectorAll('[data-setting]')) input.checked = !!settings[input.dataset.setting];
  if (settings.platform === 'linux') $('#auto-update-hint').textContent = 'Only apps that aren\'t running are updated. Asks for your password, because .deb packages install system-wide.';
}

for (const input of document.querySelectorAll('[data-setting]')) {
  input.addEventListener('change', async () => {
    settings = await call(api.settings.set({ [input.dataset.setting]: input.checked }));
  });
}

$('#btn-settings').addEventListener('click', () => { showView('settings'); renderToolboxUpdate(); });
$('#btn-back').addEventListener('click', () => showView('apps'));
$('#btn-check').addEventListener('click', () => { api.apps.check(); api.toolbox.check(); });
$('#btn-update-all').addEventListener('click', () => api.apps.updateAll());
$('#btn-logs').addEventListener('click', () => api.toolbox.logs());

api.apps.onChange((s) => { snapshot = s; render(); });
api.toolbox.onStatus((s) => { toolboxStatus = s; renderFooter(); renderToolboxUpdate(); });
setInterval(renderFooter, 30 * 1000); // keep "checked x min ago" current

(async () => {
  snapshot = await call(api.apps.list());
  toolboxStatus = await call(api.toolbox.status());
  render();
  await loadSettings();
})();
