import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionTap, classify, commandName, emptyCounts, addCount, summarizeCounts, MAX_MESSAGE, MAX_NAMES } from '../src/core/actions.js';
import { createCountingProxy } from '../src/core/proxy.js';
import { loadConfig, saveConfig, hostConfig, normalizeAppConfig } from '../src/core/config.js';
import { Logger } from '../src/core/log.js';
import { Controller, actionNote } from '../src/core/controller.js';
import { actionsView, parseHostForm } from '../src/ui/viewmodel.js';

const HEAD_101 = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n';

/** One server → client frame: unmasked, as the relay sends. */
function frame(payload, { opcode = 1, fin = true, rsv = 0, mask = false } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  let head;
  if (body.length < 126) head = Buffer.from([0, body.length]);
  else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  head[0] = (fin ? 0x80 : 0) | rsv | opcode;
  if (mask) head[1] |= 0x80;
  return Buffer.concat([head, body]);
}

const cdp = (method, params = {}, id = 1) => ({ id, method: 'debugger.sendCommand', params: { tabId: 7, method, params } });

function run(chunks) {
  const names = [];
  let undecoded = 0;
  let messages = 0;
  const tap = createActionTap({ onCommand: (n) => names.push(n), onUndecoded: () => undecoded++, onMessage: () => messages++ });
  for (const c of chunks) tap.push(c);
  return { tap, names, undecoded, messages };
}

test('actions: commands after a 101 are named, CDP by its inner method; ping and pairing are read but not counted', () => {
  const bytes = Buffer.concat([
    Buffer.from(HEAD_101),
    frame({ method: 'auth.challenge', params: { nonce: 'n' } }),
    frame({ id: 1, method: 'ping' }),
    frame(cdp('Page.navigate', { url: 'https://example.com/secret' })),
    frame(cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }, 2)),
    frame({ id: 3, method: 'tabs.create', params: { url: 'about:blank' } }),
    frame({ id: 3, result: {} }), // a message without a method is not a command
  ]);
  const { tap, names, undecoded, messages } = run([bytes]);
  assert.equal(tap.state, 'ws');
  assert.deepEqual(names, ['Page.navigate', 'Input.dispatchMouseEvent', 'tabs.create']);
  assert.equal(messages, 6);
  assert.equal(undecoded, 0);
});

test('actions: the same stream split at every byte gives the same names', () => {
  const bytes = Buffer.concat([Buffer.from(HEAD_101), frame(cdp('Runtime.evaluate')), frame(cdp('Page.captureScreenshot', {}, 2))]);
  const { names } = run([...bytes].map((b) => Buffer.from([b])));
  assert.deepEqual(names, ['Runtime.evaluate', 'Page.captureScreenshot']);
});

test('actions: 16- and 64-bit lengths, fragmented text with a ping between, and binary frames skipped', () => {
  const mid = JSON.stringify(cdp('Input.insertText', { text: 'x'.repeat(300) }));
  const big = JSON.stringify(cdp('Runtime.callFunctionOn', { functionDeclaration: 'y'.repeat(70_000) }));
  const split = JSON.stringify(cdp('Input.dispatchKeyEvent'));
  const bytes = Buffer.concat([
    Buffer.from(HEAD_101),
    frame(mid), // 126: 16-bit length
    frame(big), // 127: 64-bit length
    frame(split.slice(0, 10), { fin: false }),
    frame('', { opcode: 9 }), // a ping in the middle of a fragmented message is allowed
    frame(split.slice(10, 20), { opcode: 0, fin: false }),
    frame(split.slice(20), { opcode: 0 }),
    frame(Buffer.from(JSON.stringify(cdp('Page.reload'))), { opcode: 2 }), // binary: not read
  ]);
  const { names, undecoded } = run([bytes.subarray(0, 200), bytes.subarray(200, 50_000), bytes.subarray(50_000)]);
  assert.deepEqual(names, ['Input.insertText', 'Runtime.callFunctionOn', 'Input.dispatchKeyEvent']);
  assert.equal(undecoded, 0);
});

test('actions: a non-101 response is plain HTTP and nothing is read', () => {
  const { tap, names, messages } = run([Buffer.from('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'), frame(cdp('Page.navigate'))]);
  assert.equal(tap.state, 'http');
  assert.deepEqual(names, []);
  assert.equal(messages, 0);
});

test('actions: anything unexpected gives up with a reason instead of guessing', () => {
  const cases = [
    ['ws-extension', [Buffer.from(HEAD_101.replace('\r\n\r\n', '\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n')), frame(cdp('Page.navigate'))]],
    ['masked', [Buffer.from(HEAD_101), frame(cdp('Page.navigate'), { mask: true })]],
    ['reserved-bits', [Buffer.from(HEAD_101), frame(cdp('Page.navigate'), { rsv: 0x40 })]],
    ['opcode', [Buffer.from(HEAD_101), frame('x', { opcode: 3 })]],
    ['head-too-large', [Buffer.from(`HTTP/1.1 101 x\r\nX: ${'a'.repeat(17_000)}`)]],
  ];
  for (const [reason, chunks] of cases) {
    const { tap, names } = run(chunks);
    assert.equal(tap.state, 'gave-up', reason);
    assert.equal(tap.reason, reason);
    assert.deepEqual(names, [], `${reason}: nothing counted after giving up`);
  }
});

test('actions: an oversized or unparseable message is counted as unreadable, and the stream goes on', () => {
  const huge = JSON.stringify(cdp('Page.navigate', { url: 'z'.repeat(MAX_MESSAGE) }));
  const { tap, names, undecoded } = run([Buffer.concat([Buffer.from(HEAD_101), frame(huge), frame('{not json'), frame(cdp('Page.reload'))])]);
  assert.equal(tap.state, 'ws');
  assert.deepEqual(names, ['Page.reload']);
  assert.equal(undecoded, 2);
});

test('actions: classification follows the names browse 0.1.4 sends', () => {
  assert.equal(classify('Page.navigate'), 'navigate');
  assert.equal(classify('Input.dispatchMouseEvent'), 'pointer');
  assert.equal(classify('Input.insertText'), 'keyboard');
  assert.equal(classify('Page.captureScreenshot'), 'screenshot');
  assert.equal(classify('Runtime.evaluate'), 'script');
  assert.equal(classify('DOM.describeNode'), 'read');
  assert.equal(classify('tabs.create'), 'tab');
  assert.equal(classify('debugger.attach'), 'setup');
  assert.equal(classify('Network.enable'), 'setup');
  assert.equal(classify('Something.new'), 'other');
});

test('actions: relay housekeeping commands are setup (or tab), never "other"; unknown names still are', () => {
  for (const name of ['relay.settings', 'settings.get', 'settings.set', 'update.notice', 'action.setBadge', 'pageStatus.set', 'runtime.reload']) {
    assert.equal(classify(name), 'setup', name);
  }
  assert.equal(classify('tabs.group'), 'tab');
  assert.equal(classify('tabs.cleanup'), 'tab');
  for (const name of ['settings.reset', 'relay.newThing', 'update.other', 'tabs.somethingNew']) {
    assert.equal(classify(name), 'other', `${name} is unknown, so it stays visible as "other"`);
  }
  const c = emptyCounts();
  addCount(c, 'relay.settings');
  addCount(c, 'brand.newCommand');
  assert.equal(c.byType.other, 1);
  assert.equal(c.byType.setup, 1);
});

test('actions: names are untrusted — odd names are "(unnamed)", the name table is capped, and inherited names are just names', () => {
  const c = emptyCounts();
  addCount(c, 'evil name with spaces and a password hunter2');
  addCount(c, '__proto__');
  addCount(c, 'constructor');
  addCount(c, 'constructor');
  for (let i = 0; i < MAX_NAMES + 5; i++) addCount(c, `X.m${i}`);
  assert.equal(c.byName['(unnamed)'], 2, 'spaces and a leading "_" both fail the name shape');
  assert.equal(c.byName.constructor, 2, 'counted as a plain key, not Object.prototype.constructor');
  assert.equal(c.byName['(more)'], 7, 'the 200 slots: (unnamed), constructor and 198 X.m*; the rest overflow');
  assert.equal(c.total, MAX_NAMES + 9);
  assert.equal(commandName('{"method":"debugger.sendCommand","params":{"method":42}}').name, '(unnamed)');
  assert.equal(commandName('{oops hunter2').undecoded, true);
  assert.equal(summarizeCounts({ byType: { ...emptyCounts().byType, pointer: 3, navigate: 1 } }), 'pointer 3 · navigate 1');
});

/** A fake relay: answers the upgrade with a 101 and then sends `frames`, then closes. */
async function fakeRelay(frames) {
  const server = net.createServer((s) => {
    s.once('data', () => {
      s.write(HEAD_101);
      for (const f of frames) s.write(f);
      setTimeout(() => s.end(), 20);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function throughProxy(proxyOpts, frames) {
  const relay = await fakeRelay(frames);
  const events = [];
  const proxy = createCountingProxy({ listenPort: 0, targetPort: relay.address().port, onEvent: (e) => events.push(e), ...proxyOpts });
  const port = await proxy.listen();
  const received = await new Promise((resolve, reject) => {
    const c = net.connect({ port, host: '127.0.0.1' }, () => c.write('GET /extension HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n\r\n'));
    const got = [];
    c.on('data', (d) => got.push(d));
    c.on('close', () => resolve(Buffer.concat(got)));
    c.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 20));
  await proxy.close();
  relay.close();
  return { proxy, events, received };
}

const SECRET = 'hunter2-typed-by-the-agent';
const SAMPLE = [
  frame(cdp('Input.insertText', { text: SECRET })),
  frame(cdp('Page.navigate', { url: `https://x.example/?q=${SECRET}` }, 2)),
  frame(`{"method":"${SECRET}`), // unparseable: its text must not surface through a parse error
  frame(cdp(`type ${SECRET}`, {}, 3)), // parseable, but a method name no browse sends: never shown as given
];

test('proxy: with countActions off, nothing is decoded and the bytes pass unchanged', async () => {
  const { proxy, events, received } = await throughProxy({}, SAMPLE);
  assert.equal(proxy.stats.actions, null);
  assert.equal(events.find((e) => e.type === 'close').actions, null);
  assert.deepEqual(received, Buffer.concat([Buffer.from(HEAD_101), ...SAMPLE]));
});

test('proxy: with countActions on, commands are counted per connection and in total, and the bytes still pass unchanged', async () => {
  const { proxy, events, received } = await throughProxy({ countActions: true }, SAMPLE);
  assert.deepEqual(received, Buffer.concat([Buffer.from(HEAD_101), ...SAMPLE]), 'observing never alters the stream');
  const a = proxy.stats.actions;
  const shown = JSON.stringify([a, actionsView({ actions: a })]);
  assert.ok(!shown.includes(SECRET), `no parameter or hostile name in the stats or the Traffic view: ${shown}`);
  assert.equal(a.total, 3);
  assert.equal(a.byName['(unnamed)'], 1);
  assert.equal(a.byType.keyboard, 1);
  assert.equal(a.byType.navigate, 1);
  assert.equal(a.undecodedMessages, 1);
  const close = events.find((e) => e.type === 'close');
  assert.equal(close.actions.counts.total, 3);
  assert.equal(close.actions.undecoded, 1);
});

test('controller: the close line names types and counts only — no parameter, no unreadable text reaches the log', async () => {
  const { events } = await throughProxy({ countActions: true }, SAMPLE);
  const dir = mkdtempSync(join(tmpdir(), 'bb-act-'));
  const logger = new Logger({ file: join(dir, 'app.log') });
  const ctl = new Controller({ config: { ...hostConfig(normalizeAppConfig({}), 'host-1'), countActions: true }, logger });
  for (const e of events) ctl.onProxyEvent(e);
  const line = logger.ring.map((e) => e.message).find((m) => m.includes('closed after'));
  assert.match(line, / · 3 commands: (\w+ 1 · ){2}\w+ 1 · 1 unreadable$/);
  const all = `${JSON.stringify(logger.ring)}\n${readFileSync(join(dir, 'app.log'), 'utf8')}\n${JSON.stringify(ctl.snapshot())}`;
  assert.ok(!all.includes(SECRET), 'the secret is nowhere in the log, the file or the snapshot');
  assert.equal(actionNote(null), '');
});

test('config: countActions defaults off, survives save → load, and is a host field the form sends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-cfg-'));
  const path = join(dir, 'config.json');
  assert.equal(hostConfig(normalizeAppConfig({}), 'host-1').countActions, false);
  saveConfig(path, { hosts: [{ id: 'a', host: 'jon@dev004', countActions: true }, { id: 'b', host: 'jon@dev005' }] });
  const loaded = loadConfig(path);
  assert.equal(hostConfig(loaded, 'a').countActions, true);
  assert.equal(hostConfig(loaded, 'b').countActions, false);
  assert.ok(!readFileSync(path, 'utf8').includes('"countActions": false'), 'the default is not stored');
  assert.equal(hostConfig(normalizeAppConfig({ hosts: [{ countActions: 'yes' }] }), 'host-1').countActions, false, 'only true turns it on');
  assert.equal(parseHostForm({ host: 'h', countActions: true }).fields.countActions, true);
  assert.equal(parseHostForm({ host: 'h' }).fields.countActions, false);
});

test('viewmodel: off reads as off, never as zero actions; counts read as commands with the caveat', () => {
  assert.equal(actionsView(null).summary, '—');
  assert.equal(actionsView({ actions: null }).summary, 'Off');
  const on = actionsView({ actions: { total: 3, byType: { navigate: 1, pointer: 2, other: 0 }, byName: { 'Page.navigate': 1, 'Input.dispatchMouseEvent': 2 }, undecodable: 1, undecodedMessages: 0 } });
  assert.equal(on.summary, '3 commands: pointer 2 · navigate 1');
  assert.equal(on.top, 'Input.dispatchMouseEvent 2 · Page.navigate 1');
  assert.match(on.note, /1 connection could not be read/);
  assert.match(on.note, /several browser commands/);
  assert.equal(actionsView({ actions: { total: 0, byType: {}, byName: {}, undecodable: 0, undecodedMessages: 0 } }).summary, 'No commands yet');
});
