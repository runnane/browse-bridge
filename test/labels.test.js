import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfig } from '../src/core/config.js';
import { Controller } from '../src/core/controller.js';
import { Logger } from '../src/core/log.js';
import { trayMenuModel } from '../src/core/tray.js';
import {
  SETUP_LABEL, RELAY_LABEL, EXTENSION_NAME, TEST_LABEL, SSH_OPTIONS_LABEL, CHECK_UPDATES_LABEL, UPDATE_LABEL, CHECK_NOW_LABEL,
  UPGRADE_BROWSE_LABEL, ROLLBACK_BROWSE_LABEL, PAIR_LABEL, UNPAIR_LABEL,
} from '../src/core/labels.js';
import { updateSummary } from '../src/core/updater.js';
import { classifySshError } from '../src/core/ssherror.js';
import * as viewmodel from '../src/ui/viewmodel.js';

const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const buttonText = (id) => html.match(new RegExp(`id="${id}"[^>]*>\\s*<svg.*?</svg><span>([^<]*)</span>`, 's'))?.[1];

test('labels: the auto-update warning names the Set Up button by the shared constant', () => {
  const ctl = new Controller({ config: normalizeConfig({ transport: 'local', localAddress: '127.0.0.8' }), logger: new Logger() });
  const [warning] = ctl.statusWarnings({ autoUpdate: 'on' });
  assert.ok(warning.includes(`"${SETUP_LABEL}"`), warning);
  assert.equal(buttonText('btnSetup'), SETUP_LABEL, 'the toolbar button in index.html reads the same label');
});

test('labels: toolbar buttons, tray items and the renderer module share one name per action', () => {
  assert.equal(SETUP_LABEL, 'Set Up Host');
  assert.equal(RELAY_LABEL, 'Restart Relay');
  assert.equal(buttonText('btnRelay'), RELAY_LABEL);
  const agg = { overall: 'ready', label: 'Connected', hosts: [{ id: 'h', name: '', overall: 'ready', label: 'Connected', host: 'u@h.invalid', connected: true }] };
  const sub = trayMenuModel(agg).find((i) => i.submenu).submenu;
  assert.equal(sub.find((i) => i.action === 'setup').label, SETUP_LABEL);
  assert.equal(sub.find((i) => i.action === 'startRelay').label, RELAY_LABEL);
  assert.equal(viewmodel.SETUP_LABEL, SETUP_LABEL);
  assert.equal(viewmodel.RELAY_LABEL, RELAY_LABEL);
});

test('labels: the ssh guidance names the SSH options field, and Test Connection, by the shared constants (BBR-46)', () => {
  assert.equal(TEST_LABEL, 'Test Connection');
  assert.equal(SSH_OPTIONS_LABEL, 'SSH options');
  // The form's own button and field label, which have no toolbar icon.
  assert.equal(html.match(/id="btnTest"[^>]*>([^<]*)</)?.[1], TEST_LABEL);
  assert.equal(html.match(/<label class="label" for="fOpts">([^<]*)<\/label>/)?.[1], `${SSH_OPTIONS_LABEL}:`);
  assert.ok(classifySshError('u@h: Permission denied (publickey).').text.includes(`in ${SSH_OPTIONS_LABEL}.`));
  assert.equal(viewmodel.TEST_LABEL, TEST_LABEL);
  assert.equal(viewmodel.SSH_OPTIONS_LABEL, SSH_OPTIONS_LABEL);
  // Test Connection's advice that names Set Up Host reads it from labels.js too (test/sshtest.test.js pins the sentences).
  assert.match(readFileSync(new URL('../src/core/sshtest.js', import.meta.url), 'utf8'), /\$\{SETUP_LABEL\} installs/);
});

test('labels: the update controls in index.html carry the names the messages use (BBR-43)', () => {
  assert.equal(CHECK_UPDATES_LABEL, 'Check for updates');
  assert.equal(UPDATE_LABEL, 'Update and Restart');
  assert.equal(CHECK_NOW_LABEL, 'Check Now');
  assert.equal(html.match(/<input type="checkbox" id="checkUpdates">([^<]*)</)?.[1], CHECK_UPDATES_LABEL);
  assert.equal(html.match(/id="btnUpdateNow"[^>]*>([^<]*)</)?.[1], UPDATE_LABEL);
  assert.equal(html.match(/id="btnCheckUpdates"[^>]*>([^<]*)</)?.[1], CHECK_NOW_LABEL);
  // The off notice names the checkbox; the page's hint and the README name the update button.
  assert.ok(updateSummary({ enabled: false }).detail.includes(`General → ${CHECK_UPDATES_LABEL}`));
  assert.ok(html.includes(`click ${UPDATE_LABEL} in About`));
  assert.ok(readme.includes(`**${UPDATE_LABEL}**`));
  assert.ok(readme.includes(`**${CHECK_UPDATES_LABEL}**`));
  assert.equal(viewmodel.UPDATE_LABEL, UPDATE_LABEL);
  assert.equal(viewmodel.CHECK_UPDATES_LABEL, CHECK_UPDATES_LABEL);
});

test('labels: the Upgrade and Roll back buttons carry the names the warnings, General and the README use (BBR-41)', () => {
  assert.equal(UPGRADE_BROWSE_LABEL, 'Upgrade browse');
  assert.equal(ROLLBACK_BROWSE_LABEL, 'Roll back browse');
  assert.equal(html.match(/id="btnUpgradeBrowse"[^>]*>([^<]*)</)?.[1], UPGRADE_BROWSE_LABEL);
  assert.equal(html.match(/id="btnRollbackBrowse"[^>]*>([^<]*)</)?.[1], ROLLBACK_BROWSE_LABEL);
  assert.equal(html.match(/id="btnCheckBrowse"[^>]*>([^<]*)</)?.[1], CHECK_NOW_LABEL);
  assert.ok(html.includes(`<b>${UPGRADE_BROWSE_LABEL}</b>`) && html.includes(`<b>${ROLLBACK_BROWSE_LABEL}</b>`), 'Help names both');
  assert.ok(readme.includes(`**${UPGRADE_BROWSE_LABEL}**`));
  assert.ok(readme.includes(`**${ROLLBACK_BROWSE_LABEL}**`));
  assert.equal(viewmodel.UPGRADE_BROWSE_LABEL, UPGRADE_BROWSE_LABEL);
  assert.equal(viewmodel.ROLLBACK_BROWSE_LABEL, ROLLBACK_BROWSE_LABEL);
});

test('labels: every element renderer.js looks up is in index.html, and every name it imports is exported', () => {
  // node --check cannot see either: a missing id or export stops the whole window from loading.
  const renderer = readFileSync(new URL('../src/ui/renderer.js', import.meta.url), 'utf8');
  const ids = [...new Set([...renderer.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.includes('btnUpgradeBrowse') && ids.includes('browseWant'), 'the scan finds the BBR-41 elements');
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `index.html has no element id="${id}"`);
  const imported = /import \{([^}]*)\} from '\.\/viewmodel\.js'/.exec(renderer)[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.ok(imported.includes('browseView'));
  for (const name of imported) assert.ok(name in viewmodel, `viewmodel.js does not export ${name}`);
});

test('labels: the extension is called OpenCode Browse where a person is told to find it', () => {
  assert.equal(EXTENSION_NAME, 'OpenCode Browse');
  assert.match(html, /Extensions → OpenCode Browse → Options/);
  assert.match(html, /Install the <b>OpenCode Browse<\/b> extension/);
  assert.match(readme, /Install the \*\*OpenCode Browse\*\* extension/);
  assert.doesNotMatch(html, /Extensions → browse/);
});

test('labels: the README and Help use no other name for the setup and relay actions', () => {
  assert.doesNotMatch(readme, /Set up remote host|Start relay/);
  assert.doesNotMatch(html, /port pair/);
  assert.match(html, /next free loopback address/);
});

test('labels: Pair Browser and Unpair carry the names the Browsers list and its help use (BBR-98)', () => {
  assert.equal(PAIR_LABEL, 'Pair Browser…');
  assert.equal(UNPAIR_LABEL, 'Unpair…');
  assert.equal(buttonText('btnPair'), PAIR_LABEL, 'the toolbar button the empty list names');
  assert.equal(viewmodel.PAIR_LABEL, PAIR_LABEL);
  assert.equal(html.match(/class="btn small bunpair"[^>]*>([^<]*)</)?.[1], UNPAIR_LABEL, 'the row template the renderer clones');
  assert.ok(html.includes(`<b>${UNPAIR_LABEL}</b>`), 'Help names the button by the same text');
  assert.ok(readme.includes(`**${UNPAIR_LABEL}**`), 'so does the README');
});
