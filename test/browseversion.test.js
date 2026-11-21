import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_BROWSE_VERSION, TESTED_BROWSE_VERSIONS } from '../src/core/config.js';
import {
  BROWSE_DIST_TAGS_URL, browseUpstreamSummary, checkLatestBrowse, compareVersions, isStableVersion, testedText,
} from '../src/core/browseversion.js';

// ---------- version comparison ----------

test('browse versions: compared number by number, not as text', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1, '10 is newer than 9, though "10" < "9" as text');
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1);
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.4', '0.1.4'), 0);
  assert.equal(compareVersions('0.1.3', '0.1.4'), -1);
});

test('browse versions: only a stable x.y.z is a version; anything else compares as null and is never offered', () => {
  for (const v of ['0.1.4', '10.20.30']) assert.equal(isStableVersion(v), true, v);
  // The registry's dev tag, a shell injection, a range, and non-strings.
  for (const v of ['0.1.6-dev.254', '0.1.6; rm -rf ~', '^0.1.4', '0.1', 'v0.1.4', ' 0.1.4', '', null, undefined, 14]) {
    assert.equal(isStableVersion(v), false, JSON.stringify(v));
  }
  assert.equal(compareVersions('0.1.6-dev.254', '0.1.4'), null);
  assert.equal(compareVersions('0.1.4', undefined), null);
});

test('browse versions: the pin is one of the versions this release was tested with', () => {
  assert.ok(TESTED_BROWSE_VERSIONS.includes(PINNED_BROWSE_VERSION));
  assert.ok(TESTED_BROWSE_VERSIONS.every(isStableVersion));
  assert.ok(Object.isFrozen(TESTED_BROWSE_VERSIONS));
});

// ---------- tested versus untested ----------

const TESTED = ['0.1.4', '0.1.5'];
const ok = (latest) => ({ status: 'ok', latest, checkedAt: '2026-11-21T00:00:00.000Z' });

test('browse upstream: a newer untested version reads "not yet tested", a newer tested one "tested"', () => {
  assert.equal(testedText('0.1.6', TESTED), 'not yet tested with this app');
  assert.equal(testedText('0.1.5', TESTED), 'tested with this app');

  const untested = browseUpstreamSummary({ result: ok('0.1.6') }, { pin: '0.1.4', tested: TESTED });
  assert.equal(untested.line, 'browse 0.1.6 available (not yet tested with this app)');
  assert.equal(untested.detail, 'browse 0.1.6 available (not yet tested with this app). This app pins 0.1.4.');
  assert.deepEqual([untested.latest, untested.newer, untested.canCheck], ['0.1.6', true, true]);

  const tested = browseUpstreamSummary({ result: ok('0.1.5') }, { pin: '0.1.4', tested: TESTED });
  assert.equal(tested.line, 'browse 0.1.5 available (tested with this app)');
  assert.deepEqual(tested.tested, TESTED, 'the list goes to the window as data');
});

test('browse upstream: nothing newer than the pin is no notice; a failed or missing check is never "up to date"', () => {
  const same = browseUpstreamSummary({ result: ok('0.1.4') }, { pin: '0.1.4', tested: TESTED });
  assert.equal(same.line, null);
  assert.equal(same.newer, false);
  assert.match(same.detail, /0\.1\.4, the version this app pins, is the newest stable release/);

  const older = browseUpstreamSummary({ result: ok('0.1.3') }, { pin: '0.1.4', tested: TESTED });
  assert.equal(older.line, null);
  assert.match(older.detail, /newest stable browse on the registry is 0\.1\.3; this app pins 0\.1\.4/);

  const failed = browseUpstreamSummary({ result: { status: 'failed', reason: 'the npm registry answered HTTP 503' } }, { pin: '0.1.4', tested: TESTED });
  assert.deepEqual([failed.line, failed.latest], [null, null]);
  assert.equal(failed.detail, 'Could not check for a newer browse: the npm registry answered HTTP 503.');

  assert.equal(browseUpstreamSummary({}, { pin: '0.1.4' }).detail, 'Not checked yet.');
  assert.match(browseUpstreamSummary({ checking: true }, { pin: '0.1.4' }).detail, /Checking the npm registry/);
  assert.equal(browseUpstreamSummary({ checking: true }, { pin: '0.1.4' }).canCheck, false, 'no second check while one runs');
  const off = browseUpstreamSummary({ enabled: false, result: ok('0.1.6') }, { pin: '0.1.4' });
  assert.equal(off.canCheck, false);
  assert.match(off.detail, /off \(General → Check for updates\)/);
});

// ---------- the registry read, through an injected fetch: no test here reaches the network ----------

/** The dist-tags body exactly as the registry answered it when this was written (2026-11-21). */
const REGISTRY_BODY = { placeholder: '0.0.0', latest: '0.1.5', dev: '0.1.6-dev.254' };

function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    return typeof answer === 'function' ? answer(url, opts) : answer;
  };
  return { fetch, calls };
}
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
const now = () => new Date('2026-11-21T12:00:00.000Z');

test('browse upstream: the latest dist-tag is read from the registry with a plain GET; the dev tag is ignored', async () => {
  const { fetch, calls } = fakeFetch(response(200, REGISTRY_BODY));
  assert.deepEqual(await checkLatestBrowse({ fetch, now }), { status: 'ok', latest: '0.1.5', checkedAt: '2026-11-21T12:00:00.000Z' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.npmjs.org/-/package/@opencode/browse/dist-tags');
  assert.equal(calls[0].url, BROWSE_DIST_TAGS_URL);
  assert.equal(calls[0].opts.method, undefined, 'a GET');
  assert.equal(calls[0].opts.headers.authorization, undefined, 'no auth');
});

test('browse upstream: every way the read can fail resolves as failed, never throws, never yields a version', async () => {
  const cases = [
    [response(503, {}), /answered HTTP 503/],
    [response(200, '<html>'), /not JSON/],
    [response(200, { latest: '0.1.6-dev.254' }), /latest tag is not a stable version/],
    [response(200, { latest: '0.1.6 && curl evil' }), /latest tag is not a stable version/],
    [response(200, {}), /latest tag is not a stable version \("missing"\)/],
    [() => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); }, /could not be reached \(getaddrinfo ENOTFOUND/],
  ];
  for (const [answer, reason] of cases) {
    const res = await checkLatestBrowse({ fetch: fakeFetch(answer).fetch, now });
    assert.equal(res.status, 'failed', String(reason));
    assert.match(res.reason, reason);
    assert.equal('latest' in res, false);
  }
  assert.match((await checkLatestBrowse({ fetch: null })).reason, /no fetch/);
});

test('browse upstream: a registry that never answers is cut off at the timeout', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const res = await checkLatestBrowse({ fetch: fakeFetch(hang).fetch, timeoutMs: 20, now });
  assert.equal(res.status, 'failed');
  assert.match(res.reason, /did not answer in 0 s/);
});
