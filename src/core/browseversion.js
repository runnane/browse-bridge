/**
 * What the app knows about browse versions beyond its pin (BBR-41): how two
 * versions compare, whether one was tested with this release, and the newest
 * stable version on the npm registry. No imports, so the Electron-free core and
 * the window's renderer (through viewmodel.js) read the same rules; the tested
 * list itself lives in config.js beside the pin and is passed in as data.
 *
 * The registry read goes through an injected `fetch` (the global one by
 * default), so no test makes a network call. Nothing here installs anything:
 * a newer version is only ever offered, and Upgrade is a click per host.
 */

/** The npm package Set Up Host installs. */
export const BROWSE_PACKAGE = '@opencode/browse';

/** The package's dist-tags: { latest, dev, … }. A plain GET, no auth. */
export const BROWSE_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${BROWSE_PACKAGE}/dist-tags`;

/** The check runs at start-up and then this often. A notice, so a timer is enough. */
export const BROWSE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

/**
 * A stable browse version: three whole numbers and nothing else ("0.1.6", not
 * "0.1.6-dev.254"). It ends up in a remote shell argument and an npm spec, so
 * anything else is refused, never passed on.
 */
export function isStableVersion(v) {
  return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v);
}

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b`; null when either is not a stable version. */
export function compareVersions(a, b) {
  if (!isStableVersion(a) || !isStableVersion(b)) return null;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** "tested with this app" or "not yet tested with this app": the words every place uses. */
export function testedText(version, tested) {
  return (tested ?? []).includes(version) ? 'tested with this app' : 'not yet tested with this app';
}

/**
 * Read the newest stable browse from the registry. Never throws. Resolves with
 *   { status: 'ok', latest, checkedAt }
 *   { status: 'failed', reason, checkedAt }   could not tell — never read as "nothing newer"
 * A `latest` tag that is not a stable x.y.z is a failure, not a version.
 */
export async function checkLatestBrowse({ fetch = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, now = () => new Date() } = {}) {
  const checkedAt = now().toISOString();
  const failed = (reason) => ({ status: 'failed', reason, checkedAt });
  if (typeof fetch !== 'function') return failed('this runtime has no fetch');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(BROWSE_DIST_TAGS_URL, { headers: { accept: 'application/json' }, signal: abort.signal });
    if (!res?.ok) return failed(`the npm registry answered HTTP ${res?.status ?? '?'}`);
    let body;
    try {
      body = await res.json();
    } catch {
      return failed('the npm registry answered something that is not JSON');
    }
    const latest = body?.latest;
    if (!isStableVersion(latest)) return failed(`the registry's latest tag is not a stable version (${JSON.stringify(String(latest ?? 'missing')).slice(0, 40)})`);
    return { status: 'ok', latest, checkedAt };
  } catch (err) {
    return failed(abort.signal.aborted ? `the npm registry did not answer in ${Math.round(timeoutMs / 1000)} s` : `the npm registry could not be reached (${String(err?.message ?? err).slice(0, 120)})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the window shows for the upstream check, from main's state
 *   { enabled, checking, result: checkLatestBrowse's | null }
 * and the app's pin and tested list → { line, detail, latest, newer, tested, canCheck, checking }.
 * `line` is the one notice ("browse 0.1.6 available (not yet tested with this app)"),
 * null when nothing newer than the pin is known. `latest` is the version an
 * Upgrade would install, null when the check did not give one.
 */
export function browseUpstreamSummary(state, { pin, tested = [] }) {
  const { enabled = true, checking = false, result = null } = state ?? {};
  const latest = result?.status === 'ok' ? result.latest : null;
  const newer = latest !== null && compareVersions(latest, pin) === 1;
  const line = newer ? `browse ${latest} available (${testedText(latest, tested)})` : null;
  let detail;
  if (!enabled) detail = 'Checking for a newer browse is off (General → Check for updates).';
  else if (checking) detail = 'Checking the npm registry for a newer browse…';
  else if (!result) detail = 'Not checked yet.';
  else if (result.status === 'failed') detail = `Could not check for a newer browse: ${result.reason}.`;
  else if (newer) detail = `${line}. This app pins ${pin}.`;
  else if (latest === pin) detail = `browse ${pin}, the version this app pins, is the newest stable release.`;
  else detail = `The newest stable browse on the registry is ${latest}; this app pins ${pin}.`;
  return { line, detail, latest, newer, tested: [...tested], pin, canCheck: enabled && !checking, checking };
}
