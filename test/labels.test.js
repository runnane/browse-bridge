import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfig } from '../src/core/config.js';
import { Controller } from '../src/core/controller.js';
import { Logger } from '../src/core/log.js';
import { trayMenuModel } from '../src/core/tray.js';
import { SETUP_LABEL, RELAY_LABEL, EXTENSION_NAME } from '../src/core/labels.js';
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
