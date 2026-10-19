// User settings, stored as JSON in the app's user data folder.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  autoCheck: true, // check for updates at startup and every few hours
  autoUpdate: false, // install updates of apps that aren't running, without asking
  notify: true, // desktop notification when updates are found
  closeToTray: true, // closing the window keeps the toolbox running in the tray
  launchAtLogin: false,
  notifiedVersions: {}, // app id -> version we already notified about
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first start */ }
    this.data = { ...DEFAULTS, ...saved };
  }

  get(key) { return this.data[key]; }

  public() {
    const { notifiedVersions, ...rest } = this.data;
    return rest;
  }

  update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS && typeof v === typeof DEFAULTS[k]) this.data[k] = v;
    }
    this.save();
    return this.public();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS };
