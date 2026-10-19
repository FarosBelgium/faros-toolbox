// Downloads an installer and checks it against the SHA-512 published in the feed.
// The file only gets its final name once the checksum matches, so a half or
// tampered download can never be installed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { net } = require('electron');

async function download(url, dest, { sha512, size = 0, onProgress = () => {}, signal } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Already downloaded earlier (e.g. an install that was cancelled at the password prompt).
  if (fs.existsSync(dest) && (await hashFile(dest)) === sha512) {
    onProgress(100);
    return dest;
  }

  const part = `${dest}.part`;
  const res = await net.fetch(url, { cache: 'no-store', redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || size;
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(part);
  let received = 0;
  let lastPct = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; onProgress(pct, received, total); }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }

  if (hash.digest('base64') !== sha512) {
    fs.rmSync(part, { force: true });
    throw new Error('sha512 checksum mismatch: the download was corrupt or tampered with and has been discarded');
  }
  fs.renameSync(part, dest);
  return dest;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

module.exports = { download, hashFile };
