/**
 * What the Help and About dialogs show, and the only links the window may
 * open (BBR-32). The renderer names a link by key; main looks the key up
 * here and hands the URL to the system browser. A key that is not listed —
 * a URL, `constructor`, anything not a string — opens nothing, so a page
 * that went wrong still cannot send the user anywhere this file does not name.
 */
import { PINNED_BROWSE_VERSION } from './config.js';

export const REPO_URL = 'https://github.com/runnane/browse-bridge';

/** key → { label, url }. Frozen: the allowlist is not something a caller can extend. */
export const LINKS = Object.freeze({
  repo: Object.freeze({ label: 'github.com/runnane/browse-bridge', url: REPO_URL }),
  issues: Object.freeze({ label: 'Report a browse-bridge problem', url: `${REPO_URL}/issues` }),
  readme: Object.freeze({ label: 'README', url: `${REPO_URL}#readme` }),
  license: Object.freeze({ label: 'MIT License', url: `${REPO_URL}/blob/main/LICENSE` }),
  browse: Object.freeze({ label: 'browse (by OpenCode)', url: 'https://github.com/anomalyco/browse' }),
  browseIssues: Object.freeze({ label: 'browse’s issue tracker', url: 'https://github.com/anomalyco/browse/issues' }),
});

/** The URL for a link key, or null when the key is not on the list. */
export function linkUrl(key) {
  if (typeof key !== 'string' || !Object.hasOwn(LINKS, key)) return null;
  return LINKS[key].url;
}

/** Everything the About dialog shows, as plain data; `version` is the running version (core/version.js). */
export function aboutInfo({ version = '' } = {}) {
  return {
    name: 'browse-bridge',
    version: version || 'unknown',
    description: 'Lets AI agents on a remote dev host drive the browser on this machine, through browse over an SSH tunnel.',
    browseVersion: PINNED_BROWSE_VERSION,
    license: 'MIT',
    links: Object.entries(LINKS).map(([key, { label, url }]) => ({ key, label, url })),
  };
}
