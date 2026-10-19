// Keeps the state of every app in the catalog (installed version, latest release,
// what's going on right now) and carries out install / update / uninstall / launch.
// Emits 'change' with the full list whenever something changes.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { APPS, releasesPage } = require('./catalog');
const { fetchLatest, compareVersions } = require('./feed');
const { download } = require('./download');

function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|net::ERR_|fetch failed/i.test(msg)) return 'Could not reach GitHub (offline?)';
  if (/HTTP 404/.test(msg)) return 'No release published yet';
  if (/sha512 checksum mismatch/i.test(msg)) return 'The download was corrupt and has been discarded. Try again.';
  return msg.split('\n')[0].slice(0, 240);
}

class Manager extends EventEmitter {
  constructor({ platform, downloadDir, confirm = async () => true, log = () => {}, arch }) {
    super();
    this.platform = platform;
    this.downloadDir = downloadDir;
    this.confirm = confirm; // async ({ title, message, detail, ok }) => boolean
    this.log = log;
    this.arch = arch; // CPU architecture to pick installers for (macOS)
    this.queue = Promise.resolve(); // installs/uninstalls run one at a time
    this.checking = false;
    this.lastCheck = null;
    this.state = new Map(APPS.map((a) => [a.id, {
      app: a, installed: null, version: null, latest: null, file: null,
      busy: null, percent: 0, error: null, feedError: null, running: false,
    }]));
  }

  // What the UI sees (no functions, no internal paths besides the release page).
  snapshot() {
    const apps = [...this.state.values()].map((s) => ({
      id: s.app.id,
      name: s.app.name,
      description: s.app.description,
      icon: s.app.icon,
      installed: s.installed,
      version: s.version,
      latest: s.latest,
      updateAvailable: !!(s.installed && s.latest && s.file && s.version && compareVersions(s.latest, s.version) > 0),
      installable: !!s.file,
      busy: s.busy,
      percent: s.percent,
      error: s.error,
      feedError: s.feedError,
      running: s.running,
      releaseUrl: releasesPage(s.app, s.latest),
    }));
    return { apps, checking: this.checking, lastCheck: this.lastCheck, needsPassword: !!this.platform.needsPassword };
  }

  changed() { this.emit('change', this.snapshot()); }

  set(id, patch) {
    Object.assign(this.state.get(id), patch);
    this.changed();
  }

  get(id) {
    const s = this.state.get(id);
    if (!s) throw new Error(`Unknown app: ${id}`);
    return s;
  }

  // Looks at what is installed locally (fast, no network).
  async detectAll() {
    await Promise.all([...this.state.values()].map(async (s) => {
      try {
        const info = await this.platform.detect(s.app);
        s.installed = info.installed;
        s.version = info.installed ? info.version : null;
        s.running = info.installed ? await this.platform.isRunning(s.app) : false;
      } catch (e) {
        this.log(`detect ${s.app.id}: ${e.message}`);
        s.installed = false;
      }
    }));
    this.changed();
  }

  // Local state + the latest release of every app. Resolves to the apps that have an
  // update available.
  async refresh() {
    if (this.checking) return this.updatesAvailable();
    this.checking = true;
    this.changed();
    try {
      await this.detectAll();
      await Promise.all([...this.state.values()].map(async (s) => {
        try {
          const feed = await fetchLatest(s.app, process.platform, this.arch);
          s.latest = feed.version;
          s.file = feed.file;
          s.feedError = feed.file ? null : 'No installer for this computer in the latest release';
        } catch (e) {
          this.log(`feed ${s.app.id}: ${e.message}`);
          s.feedError = friendlyError(e);
        }
      }));
      this.lastCheck = Date.now();
    } finally {
      this.checking = false;
      this.changed();
    }
    return this.updatesAvailable();
  }

  updatesAvailable() {
    return this.snapshot().apps.filter((a) => a.updateAvailable && !a.busy);
  }

  // Install or update one or more apps. With { auto: true } (automatic updates) apps that
  // are running are left alone instead of asking to close them.
  install(ids, { auto = false } = {}) {
    ids = [...new Set(ids)].filter((id) => !this.get(id).busy);
    if (!ids.length) return Promise.resolve([]);
    for (const id of ids) this.set(id, { busy: 'queued', error: null, percent: 0 });
    const job = this.queue.then(() => this.runInstall(ids, auto));
    this.queue = job.catch(() => {});
    return job;
  }

  async runInstall(ids, auto) {
    // 1. Download and verify every installer (in parallel).
    const ready = [];
    await Promise.all(ids.map(async (id) => {
      const s = this.get(id);
      if (!s.file) {
        this.set(id, { busy: null, error: s.feedError || 'Check for updates first' });
        return;
      }
      this.set(id, { busy: 'downloading', percent: 0 });
      try {
        const dest = path.join(this.downloadDir, path.basename(s.file.name));
        const file = await download(s.file.downloadUrl, dest, {
          sha512: s.file.sha512,
          size: s.file.size,
          onProgress: (pct) => { if (pct !== s.percent) this.set(id, { percent: pct }); },
        });
        ready.push({ app: s.app, file, id });
      } catch (e) {
        this.log(`download ${id}: ${e.message}`);
        this.set(id, { busy: null, error: friendlyError(e) });
      }
    }));

    // 2. Apps that are running have to be closed first.
    const toInstall = [];
    const relaunch = [];
    for (const item of ready) {
      const s = this.get(item.id);
      const running = s.installed && (await this.platform.isRunning(s.app));
      if (running) {
        const ok = !auto && await this.confirm({
          title: `Update ${s.app.name}`,
          message: `${s.app.name} is running`,
          detail: `${s.app.name} will be closed to install version ${s.latest}, and started again afterwards. Unsaved work and open connections in ${s.app.name} are lost.`,
          ok: `Close and update`,
        });
        if (!ok) {
          this.set(item.id, { busy: null, running: true, error: auto ? null : 'Update postponed: the app is running' });
          continue;
        }
        this.set(item.id, { busy: 'closing' });
        await this.platform.stop(s.app);
        relaunch.push(s.app);
      }
      toInstall.push(item);
    }
    if (!toInstall.length) return [];

    // 3. Install (Linux: one password prompt for all of them).
    for (const item of toInstall) this.set(item.id, { busy: 'installing' });
    const groups = this.platform.batchInstall ? [toInstall] : toInstall.map((i) => [i]);
    const installed = [];
    for (const group of groups) {
      try {
        this.log(`install ${group.map((i) => `${i.id} ${path.basename(i.file)}`).join(', ')}`);
        await this.platform.install(group.map(({ app, file }) => ({ app, file })));
        for (const i of group) {
          fs.rmSync(i.file, { force: true });
          installed.push(i.id);
        }
      } catch (e) {
        this.log(`install failed: ${e.message}`);
        for (const i of group) this.set(i.id, { error: friendlyError(e) });
      }
    }

    // 4. Read back what is installed now, and restart the apps we closed.
    await this.detectAll();
    for (const id of ids) {
      const s = this.get(id);
      this.set(id, { busy: null, percent: 0 });
      if (installed.includes(id) && s.installed && s.latest && compareVersions(s.version, s.latest) < 0) {
        this.set(id, { error: `Installed, but ${s.app.name} still reports version ${s.version}` });
      }
    }
    for (const app of relaunch) {
      if (this.get(app.id).installed) await this.launch(app.id).catch(() => {});
    }
    return installed;
  }

  async uninstall(id) {
    const s = this.get(id);
    if (!s.installed || s.busy) return false;
    const ok = await this.confirm({
      title: `Uninstall ${s.app.name}`,
      message: `Uninstall ${s.app.name}?`,
      detail: `${s.app.name} ${s.version || ''} is removed from this computer. Your settings and saved data are kept, so they are back when you install it again.${s.running ? `\n\n${s.app.name} is running and will be closed first.` : ''}`,
      ok: 'Uninstall',
      danger: true,
    });
    if (!ok) return false;
    const job = this.queue.then(async () => {
      this.set(id, { busy: 'uninstalling', error: null });
      try {
        if (await this.platform.isRunning(s.app)) await this.platform.stop(s.app);
        await this.platform.uninstall(s.app);
      } catch (e) {
        this.log(`uninstall ${id}: ${e.message}`);
        this.set(id, { error: friendlyError(e) });
      }
      await this.detectAll();
      this.set(id, { busy: null });
      return !this.get(id).installed;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async launch(id) {
    const s = this.get(id);
    if (!s.installed) return;
    await this.platform.launch(s.app);
    this.set(id, { running: true });
  }
}

module.exports = { Manager, friendlyError };
