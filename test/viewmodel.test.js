import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, DEFAULTS, UNREADABLE_REFUSAL, normalizeAppConfig, pairingAddress } from '../src/core/config.js';
import { Logger } from '../src/core/log.js';
import {
  AGENT_INSTALL_COMMAND, DEFAULT_RELAY_PORT, DEFAULT_REMOTE_BROWSE, PROFILE_NOTE, UNREADABLE_REFUSAL_TEXT, agentsView, cleanError, configFailureView, errorField, fmtBytes, fmtDuration,
  appMenuView, generalView, hostRows, logForHost, logText, pairingAddressOf, pairingView, parseGeneralForm, parseHostForm, parsePort, pickSelected, transportText, withHostSnapshot,
  aliasOptions, aliasWarning, parseTestForm, problemBar, testResultView,
} from '../src/ui/viewmodel.js';

// Two hosts as HostManager.snapshot() reports them: A on localhost:19988, B on 127.0.0.2:19988 (BBR-21).
function hostSnap(id, localAddress, extra = {}) {
  return {
    id, name: '', overall: 'stopped', label: 'Stopped', host: `jon@${id}.invalid`, connected: false,
    localAddress, localPort: 19988, pairingAddress: pairingAddressOf({ localAddress, localPort: 19988 }),
    tunnel: { state: 'stopped', detail: '' }, status: null, warnings: [], traffic: null, connections: [], pairing: null, busy: null,
    ...extra,
  };
}
const twoHosts = (a = {}, b = {}) => ({
  overall: 'allDown', label: 'All hosts down',
  hosts: [hostSnap('dev004', '127.0.0.1', a), hostSnap('dev005', '127.0.0.2', b)],
});
const NOW = Date.parse('2026-11-18T12:00:00Z');
const livePairing = (port) => ({ code: 'ABCD-EF12', address: `localhost:${port}`, expiresAt: '2026-11-18T12:05:00Z' });

// ---------- host list ----------

test('viewmodel: host rows list every host in config order, each with its own address, and mark the selection', () => {
  const state = twoHosts({ name: 'main box', overall: 'ready', label: 'Connected' }, { busy: 'setting up' });
  assert.deepEqual(hostRows(state, 'dev005'), [
    { id: 'dev004', title: 'main box', host: 'jon@dev004.invalid', address: 'localhost:19988', overall: 'ready', label: 'Connected', glyph: '●', selected: false },
    { id: 'dev005', title: 'dev005', host: 'jon@dev005.invalid', address: '127.0.0.2:19988', overall: 'stopped', label: 'setting up…', glyph: '■', selected: true },
  ]);
  assert.deepEqual(hostRows(null, 'x'), []);
});

test('viewmodel: the selection survives while its host exists, and falls back to the first host when it goes', () => {
  const { hosts } = twoHosts();
  assert.equal(pickSelected(hosts, 'dev005'), 'dev005');
  assert.equal(pickSelected(hosts, 'removed'), 'dev004');
  assert.equal(pickSelected(hosts, null), 'dev004');
  assert.equal(pickSelected([], 'dev004'), null);
});

test('viewmodel: a per-host state event replaces only that host; an unknown host is ignored', () => {
  const state = twoHosts();
  const next = withHostSnapshot(state, hostSnap('dev005', 19990, { overall: 'ready' }));
  assert.deepEqual(next.hosts.map((h) => [h.id, h.overall]), [['dev004', 'stopped'], ['dev005', 'ready']]);
  assert.equal(next.hosts[0], state.hosts[0], 'the other host is the same object');
  assert.equal(withHostSnapshot(state, hostSnap('ghost', 1)), state);
});

// ---------- config file (BBR-36) ----------

test('viewmodel: an unreadable config file is a bar naming the file, the error and the kept copy; it survives a per-host event', () => {
  assert.equal(configFailureView(null), null);
  const failure = { path: '/cfg/config.json', message: 'Unexpected token } in JSON', backup: '/cfg/config.json.broken-2026-11-21T16-38-17-752Z', backupError: null };
  const v = configFailureView(failure);
  assert.equal(v.text, 'Could not read /cfg/config.json: Unexpected token } in JSON. The file as it was is kept at /cfg/config.json.broken-2026-11-21T16-38-17-752Z. '
    + 'Settings are not saved over it: fix the file and choose Reload, or choose Start Over to replace it with one empty host.');
  assert.match(v.startOverText, /stays at \/cfg\/config\.json\.broken-/);
  const uncopied = configFailureView({ ...failure, backup: null, backupError: 'EACCES: permission denied' });
  assert.match(uncopied.text, /could not be copied aside \(EACCES: permission denied\)/);
  assert.doesNotMatch(uncopied.text, /kept at/);
  // The failure rides on the state ipc answer; a per-host event must not drop it.
  const state = { ...twoHosts(), configFailure: failure };
  assert.equal(withHostSnapshot(state, hostSnap('dev005', '127.0.0.2', { overall: 'ready' })).configFailure, failure);
});

test('viewmodel: a save refused because the config file is unreadable is shown on the form, never on a field the user typed', () => {
  assert.equal(UNREADABLE_REFUSAL_TEXT, UNREADABLE_REFUSAL, 'the window matches the phrase ConfigStore refuses with');
  // A real refusal from a file whose own error would otherwise read as an ssh-host error.
  const dir = mkdtempSync(join(tmpdir(), 'bb-vm-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ hosts: [{ id: 'dev004', host: '-oProxyCommand=x', localAddress: '127.0.0.300' }] }));
  const store = new ConfigStore(path);
  store.open();
  assert.match(store.failure.message, /not a valid ssh destination/);
  let refused = null;
  try {
    store.save({ hosts: [{ id: 'host-1', host: 'u@new.invalid' }] });
  } catch (err) {
    refused = err;
  }
  assert.ok(refused?.message.includes(UNREADABLE_REFUSAL));
  assert.equal(errorField(refused.message), null);
  assert.equal(errorField(cleanError(`Error invoking remote method 'saveConfig': Error: ${refused.message}`)), null);
});

// ---------- log ----------

test('viewmodel: the host log holds exactly that host\'s tagged lines, never a prefix-sharing host\'s or app-wide ones', () => {
  const entries = [
    { ts: '2026-11-18T12:00:01.000Z', level: 'info', source: 'app', message: 'started' },
    { ts: '2026-11-18T12:00:02.000Z', level: 'info', source: 'tunnel', message: 'dev up', host: 'dev' },
    { ts: '2026-11-18T12:00:03.000Z', level: 'warn', source: 'tunnel', message: 'dev2 retrying', host: 'dev2' },
    { ts: '2026-11-18T12:00:04.000Z', level: 'info', source: 'proxy', message: 'dev conn', host: 'dev' },
  ];
  assert.deepEqual(logForHost(entries, 'dev').map((e) => e.message), ['dev up', 'dev conn']);
  assert.deepEqual(logForHost(entries, 'dev2').map((e) => e.message), ['dev2 retrying']);
  assert.deepEqual(logForHost(entries, 'nobody'), []);
  assert.deepEqual(logForHost(entries, 'all').map((e) => e.message), ['started', 'dev up', 'dev2 retrying', 'dev conn']);
  assert.equal(logText(entries[2]), '12:00:03  warn   dev2/tunnel  dev2 retrying');
  assert.equal(logText(entries[0]), '12:00:01  info   app      started');
});

test('viewmodel: a host-tagged line from the Logger filters to its host with the pairing code still redacted', () => {
  const logger = new Logger();
  logger.forHost('dev005').info('pair', 'code ABCD-EF12 issued');
  logger.forHost('dev004').info('pair', 'other host');
  const lines = logForHost(logger.ring, 'dev005');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, 'code ****-**** issued');
});

// ---------- pairing ----------

test('viewmodel: the pairing dialog for host B shows B\'s localhost port and the one-profile-one-host line', () => {
  const state = twoHosts({}, { pairing: livePairing(19990) });
  const v = pairingView(state, 'dev005', { now: NOW });
  assert.equal(v.address, '127.0.0.2:19988');
  assert.equal(v.id, 'dev005');
  assert.equal(v.title, 'Pair Browser with dev005');
  assert.equal(v.code, 'ABCD-EF12');
  assert.equal(v.note, PROFILE_NOTE);
  assert.match(PROFILE_NOTE, /follows one host at a time/);
  assert.match(PROFILE_NOTE, /needs no new code/);
  assert.match(PROFILE_NOTE, /second profile can use another host at the same time/);
});

test('viewmodel: a code issued for another host (e.g. from the tray) opens that host\'s dialog, with that host\'s port', () => {
  // A is selected, B has the live code: the dialog names B and B's port, not A's.
  const state = twoHosts({}, { pairing: livePairing(19990) });
  const v = pairingView(state, 'dev004', { now: NOW });
  assert.equal(v.id, 'dev005');
  assert.equal(v.address, '127.0.0.2:19988');
  // Both live: the selected host wins.
  const both = twoHosts({ pairing: { ...livePairing(19988), code: 'WXYZ-1234' } }, { pairing: livePairing(19990) });
  assert.equal(pairingView(both, 'dev005', { now: NOW }).address, '127.0.0.2:19988');
  assert.equal(pairingView(both, 'dev004', { now: NOW }).address, 'localhost:19988');
});

test('viewmodel: with two live codes, closing one shows the other and closing both shows none', () => {
  const both = twoHosts({ pairing: { ...livePairing(19988), code: 'WXYZ-1234' } }, { pairing: livePairing(19990) });
  assert.equal(pairingView(both, 'dev004', { now: NOW, dismissed: new Set(['WXYZ-1234']) }).address, '127.0.0.2:19988');
  assert.equal(pairingView(both, 'dev005', { now: NOW, dismissed: new Set(['ABCD-EF12']) }).address, 'localhost:19988');
  assert.equal(pairingView(both, 'dev005', { now: NOW, dismissed: new Set(['ABCD-EF12', 'WXYZ-1234']) }), null);
});

test('viewmodel: no dialog for an expired, dismissed or already-connected code', () => {
  assert.equal(pairingView(twoHosts(), 'dev004', { now: NOW }), null);
  assert.equal(pairingView(twoHosts({}, { pairing: livePairing(19990) }), 'dev005', { now: Date.parse('2026-11-18T12:06:00Z') }), null);
  assert.equal(pairingView(twoHosts({}, { pairing: livePairing(19990) }), 'dev005', { now: NOW, dismissed: ['ABCD-EF12'] }), null);
  assert.equal(pairingView(twoHosts({}, { pairing: livePairing(19990), status: { extensionConnected: true } }), 'dev005', { now: NOW }), null);
});

// ---------- host form ----------

test('viewmodel: the Add Host form leaves a blank address to the allocator and needs an ssh host', () => {
  assert.deepEqual(parseHostForm({ id: '', name: ' build ', host: ' jon@dev006 ', localAddress: '', sshOptions: 'IdentityFile=/k, Port=2222', autoConnect: true }, { adding: true }), {
    fields: { name: 'build', host: 'jon@dev006', sshOptions: ['IdentityFile=/k', 'Port=2222'], autoConnect: true, countActions: false },
  });
  assert.deepEqual(parseHostForm({ id: 'dev6', host: 'jon@dev006', localAddress: ' 127.0.0.6 ' }, { adding: true }).fields,
    { name: '', host: 'jon@dev006', sshOptions: [], autoConnect: false, countActions: false, localAddress: '127.0.0.6', id: 'dev6' });
  assert.equal('localPort' in parseHostForm({ host: 'x', localPort: '20000' }, { adding: true }).fields, false, 'the port is never taken from the form');
  assert.deepEqual(parseHostForm({ host: '  ' }, { adding: true }), { error: 'Enter the SSH host (user@host or an ~/.ssh/config alias).', field: 'host' });
  // Editing: the id is never sent, an emptied host is allowed (the host becomes unconfigured).
  assert.deepEqual(parseHostForm({ id: 'hijack', host: '', localAddress: '127.0.0.2' }).fields, { name: '', host: '', sshOptions: [], autoConnect: false, countActions: false, localAddress: '127.0.0.2' });
});

// ---------- BBR-46: ssh guidance, Test Connection, ~/.ssh/config aliases ----------

test('viewmodel: a host\'s recognised ssh failure is a bad bar naming the host; none without one', () => {
  const text = 'No usable key. Load it with ssh-add, or set IdentityFile in SSH options.';
  assert.deepEqual(problemBar(hostSnap('dev004', '127.0.0.1', { name: 'build', problem: { kind: 'auth', text } })), { kind: 'bad', text: `build: ${text}` });
  assert.equal(problemBar(hostSnap('dev004', '127.0.0.1', { problem: null })), null);
  assert.equal(problemBar(hostSnap('dev004', '127.0.0.1')), null);
});

test('viewmodel: Test Connection needs a host, takes the options and a valid remote path, and sends nothing else', () => {
  assert.deepEqual(parseTestForm({ host: ' jon@dev004 ', sshOptions: 'Port=2222, IdentityFile=/k', remoteBrowse: '' }), {
    fields: { host: 'jon@dev004', sshOptions: ['Port=2222', 'IdentityFile=/k'] },
  });
  assert.deepEqual(parseTestForm({ host: 'h', sshOptions: '', remoteBrowse: '/opt/browse' }).fields, { host: 'h', sshOptions: [], remoteBrowse: '/opt/browse' });
  assert.equal(parseTestForm({ host: '', sshOptions: '' }).field, 'host');
  assert.equal(parseTestForm({ host: 'h', remoteBrowse: 'relative/browse' }).field, 'remoteBrowse');
});

test('viewmodel: a test result is one bar at its worst step\'s level, with every step\'s text', () => {
  assert.deepEqual(testResultView({ ok: true, level: 'warn', steps: [{ text: 'Logged in to h.' }, { text: 'browse is not installed yet.' }] }),
    { kind: 'warn', text: 'Logged in to h. browse is not installed yet.' });
  assert.deepEqual(testResultView({ ok: false, level: 'bad', steps: [{ text: 'No usable key.' }] }), { kind: 'bad', text: 'No usable key.' });
  assert.equal(testResultView(null), null);
});

test('viewmodel: aliases become suggestions; one with a LocalForward is labelled and warned about, any case', () => {
  const aliases = [{ alias: 'dev004', localForward: false }, { alias: 'Tunnel', localForward: true }];
  assert.deepEqual(aliasOptions(aliases), [{ value: 'dev004', label: '' }, { value: 'Tunnel', label: 'has a LocalForward: use the plain host instead' }]);
  assert.equal(aliasWarning(aliases, 'dev004'), null);
  assert.equal(aliasWarning(aliases, 'jon@elsewhere'), null);
  assert.match(aliasWarning(aliases, ' tunnel '), /^Tunnel carries a LocalForward in ~\/\.ssh\/config\. .*use the plain user@host instead/);
  assert.deepEqual(aliasOptions(undefined), []);
});

test('viewmodel: each config refusal is shown next to the field it is about; any other error still shows', () => {
  const refusal = (raw) => {
    try {
      normalizeAppConfig(raw);
    } catch (err) {
      return err.message;
    }
    throw new Error('expected a refusal');
  };
  const cases = [
    [{ hosts: [{ id: 'a', host: '-oProxyCommand=evil' }] }, 'host'],
    [{ hosts: [{ id: 'a', host: 'jon@dev 004' }] }, 'host'],
    [{ hosts: [{ id: 'a', host: 'x' }, { id: 'a', host: 'y' }] }, 'id'],
    [{ hosts: [{ id: 'Dev 5', host: 'x' }] }, 'id'],
    [{ hosts: [{ id: 'a', localAddress: '127.0.0.5' }, { id: 'b', localAddress: '127.0.0.5' }] }, 'localAddress'],
    [{ hosts: [{ id: 'a', localAddress: '10.0.0.1' }] }, 'localAddress'],
    [{ hosts: [{ id: 'a', remotePort: 5000, innerPort: 5000 }] }, 'localAddress'],
    [{ hosts: [{ id: 'a', innerPort: 20001 }, { id: 'b', innerPort: 20001 }] }, 'localAddress'],
    [{ hosts: [{ id: 'a', sshOptions: ['nonsense'] }] }, 'sshOptions'],
    [{ hosts: [{ id: 'a', remotePort: 0 }] }, 'remotePort'],
    [{ hosts: [{ id: 'a', remotePort: 'x' }] }, 'remotePort'],
    [{ hosts: [{ id: 'a', innerPort: 70000 }] }, 'localAddress'],
    [{ hosts: [{ id: 'a', transport: 'telnet' }] }, null],
  ];
  assert.deepEqual(cases.map(([raw]) => errorField(refusal(raw))), cases.map(([, field]) => field));
  assert.equal(errorField('something unexpected'), null);
});

// ---------- Advanced host fields and General (BBR-45) ----------

test('viewmodel: the Advanced defaults are config.js\'s', () => {
  assert.equal(DEFAULT_RELAY_PORT, DEFAULTS.remotePort);
  assert.equal(DEFAULT_REMOTE_BROWSE, DEFAULTS.remoteBrowse);
});

test('viewmodel: the Advanced relay port takes a whole port number and refuses anything else on its own field', () => {
  const edit = (remotePort) => parseHostForm({ host: 'jon@dev004', remotePort });
  assert.equal(edit('20088').fields.remotePort, 20088);
  assert.equal(edit(' 1 ').fields.remotePort, 1);
  assert.equal(edit('65535').fields.remotePort, 65535);
  const refused = { error: 'Enter the relay port, a whole number from 1 to 65535 (19988 unless the remote moved it).', field: 'remotePort' };
  for (const bad of ['0', '65536', '-1', '19988.5', '0x50', '1e3', 'abc', '', '   ']) assert.deepEqual(edit(bad), refused, `remotePort ${JSON.stringify(bad)}`);
  // Adding: a blank port is left to the default; a bad one is still refused.
  assert.equal('remotePort' in parseHostForm({ host: 'jon@x', remotePort: '' }, { adding: true }).fields, false);
  assert.deepEqual(parseHostForm({ host: 'jon@x', remotePort: '0' }, { adding: true }), refused);
  // A form that does not carry the field sends nothing for it.
  assert.equal('remotePort' in parseHostForm({ host: 'jon@x' }).fields, false);
  assert.equal(parsePort('08080'), 8080);
  assert.equal(parsePort(null), null);
});

test('viewmodel: the Advanced remote browse path is absolute or under the remote home; blank is the default', () => {
  const edit = (remoteBrowse) => parseHostForm({ host: 'jon@dev004', remoteBrowse });
  assert.equal(edit(' /opt/browse/bin/browse ').fields.remoteBrowse, '/opt/browse/bin/browse');
  assert.equal(edit('$HOME/bin/browse').fields.remoteBrowse, '$HOME/bin/browse');
  assert.equal(edit('~/bin/browse').fields.remoteBrowse, '~/bin/browse');
  assert.equal(edit('').fields.remoteBrowse, '$HOME/.local/bin/browse', 'blank on Edit goes back to the default');
  assert.equal('remoteBrowse' in parseHostForm({ host: 'jon@x', remoteBrowse: ' ' }, { adding: true }).fields, false, 'blank on Add is left out');
  const refused = { error: 'Enter the path of browse on the remote host: absolute, or starting with $HOME/ or ~/.', field: 'remoteBrowse' };
  for (const bad of ['browse', 'bin/browse', '$HOME', '/opt/browse/', '-oProxyCommand=x', '/opt/br\nowse', '$HOMEX/browse']) {
    assert.deepEqual(edit(bad), refused, `remoteBrowse ${JSON.stringify(bad)}`);
  }
});

test('viewmodel: the host form never sends a transport, so Apply cannot flip a local host to ssh', () => {
  assert.equal('transport' in parseHostForm({ host: 'jon@x', transport: 'ssh', remotePort: '19988', remoteBrowse: '' }).fields, false);
  assert.equal(transportText('ssh'), 'ssh');
  assert.equal(transportText('local'), 'local (browse on this machine)');
});

test('viewmodel: General takes a poll interval of 2 to 3600 whole seconds and refuses anything else on its own field', () => {
  assert.deepEqual(parseGeneralForm({ pollSeconds: '30' }), { fields: { pollSeconds: 30 } });
  assert.deepEqual(parseGeneralForm({ pollSeconds: ' 2 ' }), { fields: { pollSeconds: 2 } });
  assert.deepEqual(parseGeneralForm({ pollSeconds: '3600' }), { fields: { pollSeconds: 3600 } });
  const refused = { error: 'Enter the poll interval in whole seconds, from 2 to 3600.', field: 'pollSeconds' };
  for (const bad of ['1', '0', '3601', '', 'ten', '2.5', '-5', '1e2', '0x10', undefined]) {
    assert.deepEqual(parseGeneralForm({ pollSeconds: bad }), refused, `pollSeconds ${JSON.stringify(bad)}`);
  }
  // Only the interval is sent: the pin is shown, never edited.
  assert.deepEqual(Object.keys(parseGeneralForm({ pollSeconds: '10', browseVersion: '9.9.9' }).fields), ['pollSeconds']);
});

test('viewmodel: the General page shows the pin and the config path, and names the upgrade flow as not built', () => {
  assert.equal(generalView(null), null);
  const v = generalView({ pollSeconds: 10, browseVersion: '0.1.4', configPath: '/cfg/config.json' });
  assert.deepEqual([v.pollSeconds, v.browseVersion, v.configPath], ['10', '0.1.4', '/cfg/config.json']);
  assert.match(v.pinNote, /not built yet \(BBR-41\)/);
});

test('viewmodel: the application-menu checkbox is hidden for a packaged build and follows the entry otherwise (BBR-48)', () => {
  assert.deepEqual(appMenuView({ packaged: true, enabled: true }), { hidden: true, checked: false });
  assert.deepEqual(appMenuView(null), { hidden: true, checked: false });
  assert.deepEqual(appMenuView({ packaged: false, enabled: true }), { hidden: false, checked: true });
  assert.deepEqual(appMenuView({ packaged: false, enabled: false }), { hidden: false, checked: false });
});

// ---------- formatting ----------

test('viewmodel: formatting helpers and ipc error prefixes', () => {
  assert.deepEqual([fmtBytes(null), fmtBytes(512), fmtBytes(2048), fmtBytes(3 * 1024 ** 2)], ['—', '512 B', '2.0 KB', '3.0 MB']);
  assert.deepEqual([fmtDuration(4000), fmtDuration(125000), fmtDuration(3_720_000)], ['4s', '2m 5s', '1h 2m']);
  assert.equal(cleanError("Error invoking remote method 'addHost': Error: two hosts have the id \"a\""), 'two hosts have the id "a"');
  assert.equal(cleanError('plain'), 'plain');
});

test('viewmodel: the window shows the same pairing address config.js gives the controller (BBR-21)', () => {
  for (const [localAddress, localPort, want] of [['127.0.0.1', 19988, 'localhost:19988'], ['127.0.0.3', 19988, '127.0.0.3:19988'], ['127.0.0.2', 20001, '127.0.0.2:20001']]) {
    assert.equal(pairingAddressOf({ localAddress, localPort }), want);
    assert.equal(pairingAddress({ localAddress, localPort }), want);
  }
});

// ---------- agents row (BBR-49) ----------

test('agentsView: a list names the agents, an empty list says none set up with the install hint, null is unknown', () => {
  assert.deepEqual(agentsView(['claude', 'codex']), { text: 'claude, codex', hint: '' });
  const none = agentsView([]);
  assert.equal(none.text, 'none set up');
  assert.ok(none.hint.includes(AGENT_INSTALL_COMMAND), 'the hint names the install command');
  assert.deepEqual(agentsView(null), { text: 'unknown', hint: '' });
  assert.deepEqual(agentsView(undefined), { text: 'unknown', hint: '' });
});

test('agentsView: the hint command is the one the README gives', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const given = readme.match(/`(browse install[^`]*)`/);
  assert.ok(given, 'README names a browse install command in backticks');
  assert.equal(given[1], AGENT_INSTALL_COMMAND);
  assert.ok(agentsView([]).hint.includes(given[1]));
});
