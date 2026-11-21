import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnostics } from '../src/core/diagnostics.js';
import { trayMenuModel } from '../src/core/tray.js';

const DEST = 'alice@build-07.corp.example';
const BARE = 'build-07.corp.example';
const CODE = 'K7Q2-M9XD';
const HOME = '/home/alice';

const snap = (id, name, host, extra = {}) => ({
  id, name, host, overall: 'warning', label: 'Connected, with warnings', connected: true,
  tunnel: { state: 'retrying', detail: `ssh: connect to host ${BARE} port 22: Connection refused` },
  status: { relayVersion: '0.1.3', relayRunning: true, relayPort: 19988, extensionConnected: false, pairingState: 'unpaired', browsers: 0, tabs: 0, autoUpdate: 'on' },
  statusError: `Permission denied (publickey) for ${DEST}, pair with ${CODE}`,
  warnings: [`browse 0.1.3 running on ${BARE}, 0.1.4 pinned`, `auto-update is on, ${name} needs setup`],
  config: {
    id, name, host, transport: 'ssh', localAddress: '127.0.0.1', innerPort: 19989, remotePort: 19988,
    remoteBrowse: '$HOME/.local/bin/browse', browseVersion: '0.1.4', autoConnect: true, countActions: false,
    sshOptions: [`IdentityFile=${HOME}/.ssh/id_build`, `ProxyJump=bastion.corp.example`],
  },
  ...extra,
});

const inputs = (extra = {}) => ({
  version: '0.1.0+3 1b86d65',
  runtime: { electron: '45.3.4', chrome: '140.0.0', node: '24.1.0', os: '6.8.0', session: 'wayland' },
  pinned: '0.1.4',
  hosts: [snap('buildbox', 'Build box', DEST), snap('second', 'Second', 'bob@other.example')],
  // Raw entries, as if the Logger's own redaction had not run, so the bundle's is what is under test.
  log: [
    { ts: '2026-11-21T10:00:00.000Z', level: 'info', source: 'tunnel', host: 'buildbox', message: `ssh -N ${DEST} up` },
    { ts: '2026-11-21T10:00:01.000Z', level: 'warn', source: 'pair', host: 'buildbox', message: `code ${CODE} shown for Build box` },
    { ts: '2026-11-21T10:00:02.000Z', level: 'info', source: 'app', message: `started; config ${HOME}/.config/browse-bridge/config.json` },
  ],
  homeDir: HOME,
  ...extra,
});

test('diagnostics: by default neither the pairing code nor the ssh destination reaches the bundle, in any section', () => {
  const text = buildDiagnostics(inputs());
  for (const secret of [CODE, DEST, BARE, 'alice', 'buildbox', 'Build box', 'bob@other.example', 'other.example', 'bastion.corp.example', '.ssh/id_build']) {
    assert.ok(!text.includes(secret), `bundle must not contain ${secret}`);
  }
  // The same two strings, checked in the sections that carry them as free text.
  const [head, logPart] = text.split('## Log');
  assert.ok(!logPart.includes(CODE) && !logPart.includes(DEST), 'log section');
  assert.ok(!head.includes('Permission denied (publickey) for alice'), 'statusError');
  assert.match(logPart, /\*\*\*\*-\*\*\*\*/);
});

test('diagnostics: hosts are numbered the same way in config, snapshot, warnings and log lines', () => {
  const text = buildDiagnostics(inputs());
  assert.match(text, /### host-1\n/);
  assert.match(text, /### host-2\n/);
  assert.match(text, /connect to host host-1 port 22/); // tunnel detail
  assert.match(text, /Permission denied \(publickey\) for host-1, pair with \*\*\*\*-\*\*\*\*/); // statusError
  assert.match(text, /browse 0\.1\.3 running on host-1, 0\.1\.4 pinned/); // warning
  assert.match(text, /host-1 needs setup/); // a name inside a warning
  assert.match(text, /\[host-1\/tunnel\] ssh -N host-1 up/); // log line and its host tag
  assert.match(text, /"host": "host-2"/);
  assert.match(text, /started; config ~\/\.config\/browse-bridge\/config\.json/);
  assert.match(text, /IdentityFile=<hidden>/);
});

test('diagnostics: hideHostNames false keeps the names and options, and still redacts the pairing code', () => {
  const text = buildDiagnostics(inputs({ hideHostNames: false }));
  assert.ok(text.includes(DEST), 'destination kept');
  assert.ok(text.includes('Build box'), 'name kept');
  assert.ok(text.includes(`IdentityFile=${HOME}/.ssh/id_build`), 'ssh option kept');
  assert.ok(!text.includes(CODE), 'the pairing code is redacted either way');
});

test('diagnostics: version info, pin, relay version and the last 100 log lines', () => {
  const log = Array.from({ length: 150 }, (_, i) => ({ ts: 't', level: 'info', source: 'app', message: `line ${i}` }));
  const text = buildDiagnostics(inputs({ log }));
  assert.match(text, /app: 0\.1\.0\+3 1b86d65/);
  assert.match(text, /Electron 45\.3\.4, Chromium 140\.0\.0, Node 24\.1\.0/);
  assert.match(text, /session: wayland/);
  assert.match(text, /pinned browse: 0\.1\.4/);
  assert.match(text, /relay version: 0\.1\.3/);
  assert.ok(text.includes('line 149') && text.includes('line 50') && !text.includes('line 49\n'));
});

test('diagnostics: an id that is another host number does not get renumbered, and a short id does not eat words', () => {
  const hosts = [snap('dev', '', 'x@one.example'), snap('host-1', '', 'y@two.example')];
  const text = buildDiagnostics(inputs({ hosts, log: [{ ts: 't', level: 'info', source: 'app', message: 'device list' }] }));
  assert.match(text, /### host-1\n[\s\S]*### host-2\n/);
  assert.ok(text.includes('device list'));
});

test('tray: a top-level Copy diagnostics item always copies with names hidden', () => {
  const model = trayMenuModel({ label: 'x', hosts: [] });
  const item = model.find((m) => m.action === 'copyDiagnostics');
  assert.ok(item, 'item present at the top level');
  assert.equal(item.label, 'Copy diagnostics');
  assert.equal(item.submenu, undefined);
});
