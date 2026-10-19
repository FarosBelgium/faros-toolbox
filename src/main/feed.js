// Reads an app's electron-builder update feed (latest*.yml) and picks the installer
// for this computer.

const yaml = require('js-yaml');
const { net } = require('electron');

const FEED_FILE = { linux: 'latest-linux.yml', win32: 'latest.yml', darwin: 'latest-mac.yml' };

// Test hook: serve feeds from a local server instead of GitHub. Only loopback URLs are
// accepted, so this cannot be used to redirect installs to another machine.
// The value is a base URL; the app's repo name is appended: <base>/<repo>/<file>.
function testFeedBase() {
  const base = process.env.FAROS_TOOLBOX_FEED;
  return base && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(base) ? base.replace(/\/+$/, '') : null;
}

function feedBase(app) {
  const test = testFeedBase();
  return test ? `${test}/${app.repo}` : `https://github.com/${app.owner}/${app.repo}/releases/latest/download`;
}

// Compares x.y.z versions (with an optional -prerelease, which sorts before the release).
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre = ''] = String(v).trim().replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// macOS: the toolbox installs from the .zip (a .dmg needs mounting), for the real CPU,
// also when the toolbox itself runs under Rosetta.
function pickFile(files, platform, arch) {
  if (platform === 'darwin') {
    const zips = files.filter((f) => f.url.endsWith('.zip'));
    return zips.find((f) => f.url.includes(`-mac-${arch}.`)) || zips.find((f) => !/-mac-(arm64|x64)\./.test(f.url)) || null;
  }
  if (platform === 'linux') return files.find((f) => f.url.endsWith('.deb')) || null;
  if (platform === 'win32') return files.find((f) => f.url.endsWith('.exe')) || null;
  return null;
}

function parseFeed(text, platform = process.platform, arch = process.arch) {
  const doc = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA }); // everything stays a string
  if (!doc || typeof doc !== 'object' || !doc.version) throw new Error('Update feed has no version');
  const files = (Array.isArray(doc.files) ? doc.files : [])
    .filter((f) => f && typeof f.url === 'string' && typeof f.sha512 === 'string')
    .map((f) => ({ url: f.url, sha512: f.sha512, size: Number(f.size) || 0 }));
  if (!files.length && doc.path && doc.sha512) files.push({ url: doc.path, sha512: doc.sha512, size: 0 });
  return { version: String(doc.version), releaseDate: doc.releaseDate || null, files, file: pickFile(files, platform, arch) };
}

async function fetchText(url) {
  const res = await net.fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

async function fetchLatest(app, platform = process.platform, arch) {
  const base = feedBase(app);
  const feed = parseFeed(await fetchText(`${base}/${FEED_FILE[platform]}`), platform, arch);
  if (feed.file) {
    // The url in the feed is relative to the feed (a release asset name).
    feed.file.downloadUrl = /^https?:\/\//.test(feed.file.url) ? feed.file.url : `${base}/${encodeURIComponent(feed.file.url)}`;
    feed.file.name = feed.file.url.split('/').pop();
  }
  return feed;
}

module.exports = { fetchLatest, parseFeed, compareVersions, pickFile, feedBase, testFeedBase, FEED_FILE };
