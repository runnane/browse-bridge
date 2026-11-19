import net from 'node:net';
import { Transform } from 'node:stream';
import { createActionTap, emptyCounts, addCount } from './actions.js';

/** A request head larger than this is not HTTP we understand; pass it through untouched. */
const MAX_HEAD = 16 * 1024;

/**
 * A Host header value naming exactly this proxy's own loopback address and
 * port ("127.0.0.3:19988") becomes "127.0.0.1:19988", the only loopback name
 * the relay accepts. The port is never changed: the extension binds its
 * pairing proof to the port it dialed, so that port must be the relay's own
 * (BBR-21). Any other value, such as a DNS-rebound "evil.example:19988",
 * reaches the relay as sent, and the relay refuses it.
 */
export function rewriteHostValue(value, listenHost, port) {
  if (listenHost === '127.0.0.1') return value;
  return value.trim().toLowerCase() === `${listenHost}:${port}` ? `127.0.0.1:${port}` : value;
}

/**
 * Apply rewriteHostValue to one HTTP request head (without its blank line).
 * Returns { head, upgrade, bodyLength }; bodyLength is null when the body's
 * length cannot be known from the head (chunked).
 */
export function rewriteRequestHead(head, listenHost, port) {
  const lines = head.split('\r\n');
  let upgrade = false;
  let bodyLength = 0;
  for (let i = 1; i < lines.length; i++) {
    const m = /^([^:]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (name === 'host') lines[i] = `${m[1]}: ${rewriteHostValue(m[2], listenHost, port)}`;
    else if (name === 'upgrade') upgrade = true;
    else if (name === 'content-length') bodyLength = Number(m[2]) || 0;
    else if (name === 'transfer-encoding' && /chunked/i.test(m[2])) bodyLength = null;
  }
  return { head: lines.join('\r\n'), upgrade, bodyLength };
}

/**
 * The browser → relay direction for a proxy on a loopback address other than
 * 127.0.0.1. The browser's Host names that address, which the relay refuses,
 * so each request head gets rewriteHostValue. After a WebSocket upgrade, a
 * body of unknown length, or a head too large to be one, it is a plain pipe.
 */
function hostRewriter(listenHost, port) {
  let buf = Buffer.alloc(0);
  let skip = 0; // body bytes of the current request still to pass through
  let passthrough = false;
  return new Transform({
    transform(chunk, _enc, done) {
      if (passthrough) return done(null, chunk);
      const out = [];
      buf = Buffer.concat([buf, chunk]);
      while (buf.length) {
        if (skip) {
          const n = Math.min(skip, buf.length);
          out.push(buf.subarray(0, n));
          buf = buf.subarray(n);
          skip -= n;
          continue;
        }
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) {
          if (buf.length > MAX_HEAD) {
            out.push(buf);
            buf = Buffer.alloc(0);
            passthrough = true;
          }
          break;
        }
        const r = rewriteRequestHead(buf.subarray(0, end).toString('latin1'), listenHost, port());
        out.push(Buffer.from(`${r.head}\r\n\r\n`, 'latin1'));
        buf = buf.subarray(end + 4);
        if (r.upgrade || r.bodyLength === null) {
          if (buf.length) out.push(buf);
          buf = Buffer.alloc(0);
          passthrough = true;
          break;
        }
        skip = r.bodyLength;
      }
      done(null, out.length ? Buffer.concat(out) : undefined);
    },
    flush(done) {
      done(null, buf.length ? buf : undefined);
    },
  });
}

/**
 * A TCP proxy that counts what crosses it. The browser extension connects to
 * listenHost:listenPort (a loopback address of this host's own, on the relay's
 * port); each connection is piped to host:targetPort (ssh's -L forward, or the
 * relay itself on the local transport).
 *
 * It counts bytes and connections. Browser → relay is decoded only on a
 * listenHost other than 127.0.0.1, and only far enough to rename that address
 * in the Host header (see rewriteHostValue). Relay → browser is decoded only
 * when `countActions` is on (opt-in, BBR-22), and then only the command names
 * of the relay's WebSocket messages are read (see actions.js); the bytes are
 * observed, never changed. The browser's replies are never decoded.
 */
export function createCountingProxy({ listenHost = '127.0.0.1', listenPort, targetPort, host = '127.0.0.1', countActions = false, onEvent = () => {} }) {
  let nextId = 1;
  let target = targetPort;
  let boundPort = listenPort;
  const sockets = new Set();
  const stats = {
    bytesUp: 0, // browser → relay
    bytesDown: 0, // relay → browser
    connectionsTotal: 0,
    connectionsActive: 0,
    connectionsFailed: 0,
    lastActivity: null,
    /** Null unless countActions: commands the relay sent, and WebSocket connections the tap could not read. */
    actions: countActions ? { ...emptyCounts(), messages: 0, undecodable: 0, undecodedMessages: 0 } : null,
  };

  const server = net.createServer((client) => {
    const id = nextId++;
    const opened = Date.now();
    let up = 0;
    let down = 0;
    stats.connectionsTotal++;
    stats.connectionsActive++;
    sockets.add(client);
    const upstream = net.connect({ host, port: target });
    sockets.add(upstream);
    let connected = false;
    let closed = false;
    const counts = countActions ? emptyCounts() : null;
    let undecoded = 0;
    const tap = countActions
      ? createActionTap({
          onCommand: (name) => {
            addCount(counts, name);
            addCount(stats.actions, name);
          },
          onMessage: () => {
            stats.actions.messages++;
          },
          onUndecoded: () => {
            undecoded++;
            stats.actions.undecodedMessages++;
          },
        })
      : null;

    upstream.on('connect', () => {
      connected = true;
      onEvent({ type: 'open', id, target });
    });
    client.on('data', (chunk) => {
      up += chunk.length;
      stats.bytesUp += chunk.length;
      stats.lastActivity = Date.now();
    });
    upstream.on('data', (chunk) => {
      down += chunk.length;
      stats.bytesDown += chunk.length;
      stats.lastActivity = Date.now();
      if (tap) {
        const before = tap.state;
        tap.push(chunk);
        if (tap.state === 'gave-up' && before !== 'gave-up') stats.actions.undecodable++;
      }
    });
    if (listenHost !== '127.0.0.1') client.pipe(hostRewriter(listenHost, () => boundPort)).pipe(upstream);
    else client.pipe(upstream);
    upstream.pipe(client);

    const finish = (err) => {
      if (closed) return;
      closed = true;
      stats.connectionsActive--;
      if (!connected) stats.connectionsFailed++;
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
      onEvent({
        type: connected ? 'close' : 'fail',
        id,
        target,
        up,
        down,
        ms: Date.now() - opened,
        error: err ? (err.code || err.message) : null,
        actions: tap && tap.state !== 'http' && tap.state !== 'head' ? { counts, undecoded, gaveUp: tap.reason } : null,
      });
    };
    client.on('error', finish);
    upstream.on('error', finish);
    client.on('close', () => finish());
    upstream.on('close', () => finish());
  });

  return {
    stats,
    /** Re-point new connections (the relay moved port). Existing ones keep their target. */
    setTarget(port) { target = port; },
    get target() { return target; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, listenHost, () => {
          server.off('error', reject);
          boundPort = server.address().port;
          resolve(boundPort);
        });
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Resolve true when something accepts a TCP connection on host:port. */
export function probePort(port, { host = '127.0.0.1', timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
