import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINKS, REPO_URL, aboutInfo, linkUrl } from '../src/core/about.js';
import { PINNED_BROWSE_VERSION } from '../src/core/config.js';

test('about: the repository link is the project on GitHub', () => {
  assert.equal(REPO_URL, 'https://github.com/runnane/browse-bridge');
  assert.equal(linkUrl('repo'), 'https://github.com/runnane/browse-bridge');
  assert.equal(linkUrl('issues'), 'https://github.com/runnane/browse-bridge/issues');
  assert.equal(linkUrl('browseIssues'), 'https://github.com/anomalyco/browse/issues');
});

test('about: only a listed key opens anything — never a URL, an inherited name or a non-string', () => {
  for (const key of [
    'https://example.invalid/', REPO_URL, 'file:///etc/passwd', 'constructor', '__proto__', 'toString', 'hasOwnProperty',
    '', 'REPO', ' repo', undefined, null, 1, ['repo'], { toString: () => 'repo' },
  ]) {
    assert.equal(linkUrl(key), null, `key ${JSON.stringify(String(key))} must open nothing`);
  }
});

test('about: every link is https and the allowlist cannot be extended at run time', () => {
  for (const [key, { url }] of Object.entries(LINKS)) assert.match(url, /^https:\/\/github\.com\//, key);
  assert.ok(Object.isFrozen(LINKS));
  assert.throws(() => { 'use strict'; LINKS.evil = { url: 'https://example.invalid/' }; });
  assert.equal(linkUrl('evil'), null);
});

test('about: the dialog data names the running version, the licence, the browse pin and every link', () => {
  const info = aboutInfo({ version: '0.1.0+3 1b86d65' });
  assert.equal(info.name, 'browse-bridge');
  assert.equal(info.version, '0.1.0+3 1b86d65');
  assert.equal(info.browseVersion, PINNED_BROWSE_VERSION);
  assert.deepEqual(info.links.map((l) => l.key), Object.keys(LINKS));
  assert.equal(info.links.find((l) => l.key === 'repo').url, REPO_URL);
  assert.equal(aboutInfo().version, 'unknown');
  // The licence named in the dialog is the one the repo ships.
  assert.equal(info.license, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).license);
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License/);
});

test('about: the window offers only link keys main knows, and shows no URL of its own', () => {
  const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-link="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.includes('repo'), 'the About dialog links the repository');
  for (const k of keys) assert.notEqual(linkUrl(k), null, `data-link="${k}" is not in LINKS`);
  // A real href would navigate the app window itself; links go through main.
  assert.doesNotMatch(html, /<a\s[^>]*href=/i);
});

const page = () => readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const helpOf = (html) => html.slice(html.indexOf('<dialog id="helpDialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="helpDialog"')));

test('help: every state the app shows is explained, under the label the app shows it with', async () => {
  const { OVERALL } = await import('../src/core/controller.js');
  const help = helpOf(page());
  const states = Object.fromEntries([...help.matchAll(/<dt data-state="([^"]+)">([^<]+)<\/dt>/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(states).sort(), Object.keys(OVERALL).sort());
  for (const [k, label] of Object.entries(states)) assert.equal(label, OVERALL[k], k);
});

test('help: every control it tells you to click exists under that name outside the help', () => {
  const html = page();
  const help = helpOf(html);
  const rest = html.replace(help, '');
  const named = new Set([...help.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]));
  // Words the help puts in bold that are not this window's controls: the extension's own UI, tab names (data-tab), states.
  const elsewhere = new Set(['Connected', 'advanced', 'Pair with a code', 'browse', 'Status', 'Traffic', 'Log', 'Settings', 'Quit', 'Connect']);
  const unchecked = [...named].filter((n) => !elsewhere.has(n));
  assert.ok(unchecked.includes('Set Up Host') && unchecked.includes('Pair Browser…'), 'the toolbar names are checked');
  // A button reads ">Name<"; a form field's label reads ">Name:<".
  for (const n of unchecked) assert.ok(rest.includes(`>${n}<`) || rest.includes(`>${n}:<`), `the help names "${n}", which no control outside it is labelled`);
  for (const tab of ['Status', 'Traffic', 'Log', 'Settings']) assert.match(rest, new RegExp(`role="tab"[^>]*>${tab}<`));
});
