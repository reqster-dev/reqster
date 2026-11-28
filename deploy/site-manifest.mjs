#!/usr/bin/env node
// Builds `site-manifest.json` for the release GitHub marks as "latest" and prints it to stdout. The download
// site reads it from a fixed address (releases/latest/download/site-manifest.json) and derives from it both the
// download page data and the Tauri updater manifest, so the site needs neither the GitHub API nor a copy of
// the release files.
//
//   node deploy/site-manifest.mjs > site-manifest.json
//
// Environment: GITHUB_REPOSITORY (default reqster-dev/reqster), GITHUB_TOKEN (optional, API rate limit only).
//
// Shape:
//   version, publishedAt, notes (release body, markdown), updaterNotes (Turkish changelog as plain text, shown
//   in the update dialog), minimumVersion (optional: installs below it must update before the app opens),
//   files    { <download key>: { name, size } }
//   updater  { <tauri platform>: { name, signature } }   (only platforms that have a .sig)
const REPO = process.env.GITHUB_REPOSITORY || 'reqster-dev/reqster';
const API = `https://api.github.com/repos/${REPO}`;
const MINIMUM_MARKER = '<!-- reqster:minimum-version -->';

const DOWNLOADS = [
  ['windows', /_x64-setup\.exe$/],
  ['windows-setup-zip', /_x64-setup\.zip$/],
  ['windows-portable', /_x64-portable\.zip$/],
  ['mac-apple-silicon', /_aarch64\.dmg$/],
  ['mac-intel', /_x64\.dmg$/],
  ['linux', /-linux-x64\.tar\.gz$/],
];
const UPDATER = [
  ['windows-x86_64', /_x64-setup\.exe$/],
  ['darwin-aarch64', /_aarch64\.app\.tar\.gz$/],
  ['darwin-x86_64', /_x64\.app\.tar\.gz$/],
];

async function get(url, accept) {
  const headers = { 'User-Agent': 'reqster-site-manifest', Accept: accept };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// A stable version is greater than its own release candidates (1.0.0 > 1.0.0-rc.30).
function versionKey(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// Highest version that carries the mandatory-update marker and is not newer than the published one.
function minimumVersion(releases, published) {
  const current = versionKey(published);
  let best = null;
  for (const release of releases) {
    if (release.draft || !(release.body || '').includes(MINIMUM_MARKER)) continue;
    const version = release.tag_name.replace(/^v/, '');
    const key = versionKey(version);
    if (key && current && compare(key, current) <= 0 && (!best || compare(key, versionKey(best)) > 0)) best = version;
  }
  return best;
}

// The update dialog is plain text: headings become "Heading:", emphasis and code marks are dropped.
function updaterNotes(body) {
  const marked = /<!-- reqster:notes-tr -->([\s\S]*?)<!-- \/reqster:notes-tr -->/.exec(body);
  if (!marked) return '';
  return marked[1]
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/^###\s+(.*)$/, '$1:').replace(/\*\*|`/g, ''))
    .filter(Boolean)
    .join('\n');
}

const latest = await (await get(`${API}/releases/latest`, 'application/vnd.github+json')).json();
const releases = await (await get(`${API}/releases?per_page=100`, 'application/vnd.github+json')).json();
const version = latest.tag_name.replace(/^v/, '');
const body = (latest.body || '').replace(/\r/g, '');
const assets = [...latest.assets].sort((a, b) => (a.name < b.name ? -1 : 1));

const files = {};
for (const [key, pattern] of DOWNLOADS) {
  const asset = assets.find((a) => pattern.test(a.name));
  if (asset) files[key] = { name: asset.name, size: asset.size };
}

const updater = {};
for (const [platform, pattern] of UPDATER) {
  const asset = assets.find((a) => pattern.test(a.name));
  const sig = asset && assets.find((a) => a.name === `${asset.name}.sig`);
  if (!sig) continue;
  const signature = (await (await get(sig.url, 'application/octet-stream')).text()).trim();
  updater[platform] = { name: asset.name, signature };
}

const manifest = {
  version,
  publishedAt: latest.published_at || latest.created_at,
  notes: body,
  updaterNotes: updaterNotes(body),
  files,
  updater,
};
const minimum = minimumVersion(releases, version);
if (minimum) manifest.minimumVersion = minimum;
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
