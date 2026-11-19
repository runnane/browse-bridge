/**
 * The browse extension's code pairing, as a Node client (BBR-21). The crypto
 * below is the extension's own (browse extension 0.0.17, background.js),
 * renamed for reading. What matters for the bridge: the key and every proof
 * are bound to `127.0.0.1:<port>/extension`, where <port> is the port the
 * extension dialed, so pairing only works when that is the relay's own port.
 */
const enc = new TextEncoder();
const V = 'opencode-browser-pairing-v3';
const ORIGIN = 'chrome-extension://mfnicocicmmlkpjnaffgihfjhdgjkdjg';

const bound = (port) => `127.0.0.1:${port}/extension`;
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? enc.encode(data) : data));
}
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
function b64(bytes) {
  let t = '';
  for (const b of bytes) t += String.fromCharCode(b);
  return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const tokenProof = async (token, who, port, extNonce, relayNonce) => b64(await hmac(enc.encode(token), `${V}|${who}|${bound(port)}|${relayNonce}|${extNonce}`));
async function sessionKey(codeKey, secret, s) {
  const head = enc.encode(`${V}|session|${bound(s.port)}|${s.extensionNonce}|${s.relayNonce}|${s.extensionKey}|${s.relayKey}|`);
  const all = new Uint8Array(head.length + secret.length);
  all.set(head);
  all.set(secret, head.length);
  return hmac(enc.encode(codeKey), all);
}
const sessionProof = async (key, who) => b64(await hmac(key, `${V}|proof|${who}`));
async function unwrap(key, wrapped) {
  if (typeof wrapped !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(wrapped)) return undefined;
  const pad = await hmac(key, `${V}|wrap`);
  return b64(unb64(wrapped).map((b, i) => b ^ pad[i]));
}
async function codeKey(code) {
  const k = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`${V}|code`), iterations: 1e5 }, k, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function ecdh() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return {
    publicKey: b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    async secret(other) {
      const pub = await crypto.subtle.importKey('raw', unb64(other), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, pair.privateKey, 256));
    },
  };
}

/**
 * Pair with `url` (ws://<address>:<port>/extension) using a code from
 * `browse pair`. Resolves { paired: true } once the relay accepts the final
 * proof, or { paired: false, closeCode, reason } when it closes the socket.
 */
export async function pairWithCode(url, rawCode, { timeoutMs = 10_000 } = {}) {
  const code = rawCode.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  const port = Number(new URL(url).port);
  const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
  const keys = await ecdh();
  return new Promise((resolve) => {
    let session = null;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ paired: false, closeCode: null, reason: 'timeout' }), timeoutMs);
    const ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
    ws.onopen = () => ws.send(JSON.stringify({ method: 'hello', params: {
      version: '0.0.17', build: '2026-11-14T18:26:36.415Z', protocolVersion: 3, profileId: crypto.randomUUID(),
      profileName: 'browse', browser: 'Chrome', pairing: { nonce, mode: 'code', ecdh: keys.publicKey },
    } }));
    ws.onerror = () => {};
    ws.onclose = (e) => finish({ paired: false, closeCode: e.code, reason: e.reason });
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.params ?? {};
      if (m.method === 'auth.challenge') {
        const key = await sessionKey(await codeKey(code), await keys.secret(p.ecdh), {
          port, extensionNonce: nonce, relayNonce: p.nonce, extensionKey: keys.publicKey, relayKey: String(p.ecdh),
        });
        session = { key, relayNonce: p.nonce };
        ws.send(JSON.stringify({ method: 'auth.code', params: { proof: await sessionProof(key, 'extension') } }));
      } else if (m.method === 'auth.token' && session) {
        if ((await sessionProof(session.key, 'relay')) !== p.proof) return finish({ paired: false, closeCode: null, reason: 'relay proof mismatch' });
        const token = await unwrap(session.key, p.wrapped);
        ws.send(JSON.stringify({ method: 'auth.response', params: { proof: await tokenProof(token, 'extension', port, nonce, session.relayNonce) } }));
        // The relay closes the socket on a bad final proof; still open a moment later means accepted.
        setTimeout(() => finish(ws.readyState === WebSocket.OPEN ? { paired: true } : { paired: false, closeCode: null, reason: 'closed after response' }), 1000);
      }
    };
  });
}
