// Compare the pinned browse's extension protocol range with upstream's newest stable
// release, from source (BBR-50). Plain HTTPS to the public GitHub API, no auth, no deps.
// Exit codes: 0 compatible, 1 incompatible, 2 network/parse error.
import { PINNED_BROWSE_VERSION } from '../src/core/config.js';
import {
  PROTOCOL_RS_PATH,
  WATCHED_FILES,
  changedWatchedFiles,
  parseProtocolConstants,
  verdict,
} from '../src/core/pincheck.js';

const REPO = 'anomalyco/browse';
const headers = { 'User-Agent': 'browse-bridge-pin-check', Accept: 'application/vnd.github+json' };

async function get(url, kind) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return kind === 'json' ? res.json() : res.text();
}

async function main() {
  const pinTag = `v${PINNED_BROWSE_VERSION}`;
  const latestTag = (await get(`https://api.github.com/repos/${REPO}/releases/latest`, 'json')).tag_name;
  const raw = (tag) => get(`https://raw.githubusercontent.com/${REPO}/${tag}/${PROTOCOL_RS_PATH}`, 'text');
  const pin = parseProtocolConstants(await raw(pinTag));
  const latest = parseProtocolConstants(await raw(latestTag));
  const changed =
    pinTag === latestTag
      ? []
      : changedWatchedFiles(await get(`https://api.github.com/repos/${REPO}/compare/${pinTag}...${latestTag}`, 'json'));

  const fmt = (c) => `protocol ${c.min}..${c.current}, scheme ${c.scheme}`;
  console.log(`pin    ${pinTag}: ${fmt(pin)}`);
  console.log(`latest ${latestTag}: ${fmt(latest)}`);
  console.log(`watched files changed ${pinTag}...${latestTag} (of ${WATCHED_FILES.length}): ${changed.length ? '' : 'none'}`);
  for (const f of changed) console.log(`  ${f}`);

  const v = verdict(pin, latest);
  if (v.compatible) {
    console.log(`compatible: the newest stable extension (protocol ${latest.current}) is within the pin's ${pin.min}..${pin.current}`);
    return 0;
  }
  for (const r of v.reasons) console.error(`INCOMPATIBLE: ${r}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`pin check could not complete (network or parse error): ${err.message}`);
    process.exit(2);
  },
);
