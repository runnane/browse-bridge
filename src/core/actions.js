/**
 * Opt-in action counting (BBR-22): read the relay → browser half of the
 * extension's WebSocket and count the commands the relay sends, by name and by
 * type. Only the command's name is read: `method`, and for
 * `debugger.sendCommand` the CDP method inside it. Parameters (URLs, typed
 * text, scripts) are never kept, logged or shown, and the browser's replies
 * (the other direction) are never decoded at all.
 *
 * Measured against browse 0.1.4: after the HTTP 101 the relay sends plain,
 * uncompressed text frames `{ id, method, params }` (tokio-tungstenite without
 * deflate; pairing encrypts nothing). Anything else — a compression extension,
 * a masked or reserved bit, an unknown opcode, an oversized message — makes the
 * tap give up on that connection and say so, rather than report zero.
 */

/** What a command is, as the Traffic tab groups it. Order is the display order. */
export const ACTION_TYPES = Object.freeze(['navigate', 'pointer', 'keyboard', 'screenshot', 'script', 'read', 'tab', 'setup', 'other']);

/** Names browse 0.1.4 sends (browse-page / browse-relay at v0.1.4), by type. Anything else is "other". */
const BY_NAME = {
  navigate: ['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry', 'Page.stopLoading'],
  pointer: ['Input.dispatchMouseEvent', 'Input.dispatchDragEvent', 'Input.dispatchTouchEvent', 'Input.setInterceptDrags', 'DOM.scrollIntoViewIfNeeded'],
  keyboard: ['Input.dispatchKeyEvent', 'Input.insertText'],
  screenshot: ['Page.captureScreenshot'],
  script: ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.terminateExecution', 'Runtime.releaseObjectGroup', 'Page.createIsolatedWorld'],
  read: ['Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.getNavigationHistory', 'Target.getTargetInfo'],
  tab: ['tabs.create', 'tabs.remove', 'tabs.keepOpen', 'tabs.ungroup', 'tabs.group', 'tabs.cleanup', 'Target.createTarget', 'Target.closeTarget', 'Page.close', 'Page.handleJavaScriptDialog'],
  setup: ['debugger.attach', 'debugger.detach', 'action.setAttached', 'pageStatus.clear', 'pageStatus.set', 'action.setBadge', 'relay.settings', 'settings.get', 'settings.set', 'update.notice', 'runtime.reload', 'Target.setAutoAttach', 'Target.detachFromTarget', 'Runtime.runIfWaitingForDebugger'],
};
const TYPE_OF = new Map(Object.entries(BY_NAME).flatMap(([type, names]) => names.map((n) => [n, type])));

/** Relay messages that are not an agent's action: liveness and pairing. */
const IGNORED = (name) => name === 'ping' || name.startsWith('auth.');

/** A name is shown and counted only in this shape; anything else counts as "(unnamed)". */
const NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
/** Distinct names kept per counter; the rest are counted under "(more)". */
export const MAX_NAMES = 200;
/** A text message longer than this is skipped unread and counted as undecoded. */
export const MAX_MESSAGE = 1024 * 1024;
const MAX_HEAD = 16 * 1024;

/** The type of one command name. */
export function classify(name) {
  const known = TYPE_OF.get(name);
  if (known) return known;
  if (/^(DOM|CSS|Accessibility|DOMSnapshot)\./.test(name)) return 'read';
  if (/^(Emulation|Network|Log|Inspector)\./.test(name) || /\.(enable|disable)$/.test(name) || /^Page\.setLifecycleEventsEnabled$/.test(name)) return 'setup';
  if (/^Input\./.test(name)) return 'pointer';
  return 'other';
}

/** An empty counter: totals per type and per name, in null-prototype objects (names are not trusted). */
export function emptyCounts() {
  const byType = Object.create(null);
  for (const t of ACTION_TYPES) byType[t] = 0;
  return { total: 0, byType, byName: Object.create(null), names: 0 };
}

/** Add one command to a counter. */
export function addCount(counts, name) {
  const key = NAME.test(name) ? name : '(unnamed)';
  counts.total++;
  counts.byType[classify(key)]++;
  if (key in counts.byName) counts.byName[key]++;
  else if (counts.names < MAX_NAMES) {
    counts.byName[key] = 1;
    counts.names++;
  } else counts.byName['(more)'] = (counts.byName['(more)'] ?? 0) + 1;
}

/**
 * The command name of one relay message, or null when it is not a command
 * (a reply, ping, pairing) or cannot be read. Never throws, and never returns
 * anything taken from the parameters except the CDP method name.
 */
export function commandName(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { undecoded: true };
  }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
  const method = msg.method;
  if (IGNORED(method)) return null;
  if (method === 'debugger.sendCommand') {
    const cdp = msg.params?.method;
    return { name: typeof cdp === 'string' ? cdp : '(unnamed)' };
  }
  return { name: method };
}

/**
 * A tap on the relay → browser bytes of one connection. `push(chunk)` takes the
 * bytes exactly as they cross; it never changes or holds them up (the proxy
 * pipes them separately). It calls `onMessage()` per text message it read
 * (commands, pings and pairing alike: the proof that decoding works),
 * `onCommand(name)` per command, and `onUndecoded()` per message it could not
 * read.
 *
 * `state` is "head" until the response head arrives, then "ws" (decoding),
 * "http" (a plain HTTP response: nothing to count), or "gave-up" with `reason`.
 */
export function createActionTap({ onCommand = () => {}, onUndecoded = () => {}, onMessage = () => {} } = {}) {
  let state = 'head';
  let reason = null;
  let head = Buffer.alloc(0);
  // Frame parsing state.
  let hdr = Buffer.alloc(0); // partial frame header
  let need = 0; // payload bytes still to come for the current frame
  let keep = false; // whether this frame's payload is collected
  let parts = []; // collected payload of the current (possibly fragmented) text message
  let size = 0;
  let inText = false; // inside a fragmented text message
  let tooBig = false;
  let endsMessage = false; // whether the current frame, once its payload is in, ends a text message

  const giveUp = (why) => {
    state = 'gave-up';
    reason = why;
    hdr = head = Buffer.alloc(0);
    parts = [];
  };

  const finishMessage = () => {
    if (tooBig) onUndecoded();
    else {
      const got = commandName(Buffer.concat(parts).toString('utf8'));
      if (got?.undecoded) onUndecoded();
      else {
        onMessage();
        if (got) onCommand(got.name);
      }
    }
    parts = [];
    size = 0;
    inText = false;
    tooBig = false;
  };

  /** Parse a frame header from hdr; returns the bytes after it, or false when more are needed (or it gave up). */
  const startFrame = () => {
    if (hdr.length < 2) return false;
    const b0 = hdr[0];
    const b1 = hdr[1];
    let len = b1 & 0x7f;
    let at = 2;
    if (len === 126) {
      if (hdr.length < 4) return false;
      len = hdr.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (hdr.length < 10) return false;
      const big = hdr.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return giveUp('frame-length'), false;
      len = Number(big);
      at = 10;
    }
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if (b0 & 0x70) return giveUp('reserved-bits'), false;
    if (b1 & 0x80) return giveUp('masked'), false;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return giveUp('opcode'), false;
    if (opcode >= 8 && (len > 125 || !fin)) return giveUp('control-frame'), false;
    if (opcode === 1) {
      if (inText) return giveUp('interleaved'), false;
      inText = true;
    }
    // Text frames and their continuations are collected; binary and control payloads are skipped.
    keep = opcode === 1 || (opcode === 0 && inText);
    const rest = hdr.subarray(at);
    hdr = Buffer.alloc(0);
    need = len;
    endsMessage = fin && keep;
    if (keep && size + len > MAX_MESSAGE) tooBig = true;
    if (need === 0 && endsMessage) finishMessage();
    return rest;
  };

  const feed = (buf) => {
    while (buf.length && state === 'ws') {
      if (need > 0) {
        const n = Math.min(need, buf.length);
        if (keep && !tooBig) {
          parts.push(Buffer.from(buf.subarray(0, n)));
          size += n;
        }
        need -= n;
        buf = buf.subarray(n);
        if (need === 0 && endsMessage) finishMessage();
        continue;
      }
      hdr = Buffer.concat([hdr, buf]);
      buf = startFrame() || Buffer.alloc(0);
    }
  };

  const readHead = (chunk) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) {
      if (head.length > MAX_HEAD) giveUp('head-too-large');
      return;
    }
    const text = head.subarray(0, end).toString('latin1');
    const rest = head.subarray(end + 4);
    head = Buffer.alloc(0);
    if (!/^HTTP\/1\.1 101\b/.test(text)) {
      state = 'http';
      return;
    }
    if (/^sec-websocket-extensions:/im.test(text)) return giveUp('ws-extension');
    state = 'ws';
    if (rest.length) feed(rest);
  };

  return {
    get state() { return state; },
    get reason() { return reason; },
    push(chunk) {
      try {
        if (state === 'head') readHead(chunk);
        else if (state === 'ws') feed(chunk);
      } catch {
        giveUp('error');
      }
    },
  };
}

/** "pointer 20 · script 12 · navigate 2" — non-zero types, most first. Names and counts only. */
export function summarizeCounts(counts) {
  return ACTION_TYPES.filter((t) => counts.byType[t] > 0)
    .sort((a, b) => counts.byType[b] - counts.byType[a])
    .map((t) => `${t} ${counts.byType[t]}`)
    .join(' · ');
}
