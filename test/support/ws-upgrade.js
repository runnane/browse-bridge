import net from 'node:net';

/**
 * Send the browse extension's WebSocket upgrade to address:port with this
 * Host header, and resolve the reply's status line.
 */
export function wsUpgrade(address, port, hostHeader) {
  return new Promise((resolve, reject) => {
    const c = net.connect({ port, host: address }, () => c.write(
      `GET /extension HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'
      + 'Origin: chrome-extension://mfnicocicmmlkpjnaffgihfjhdgjkdjg\r\n\r\n',
    ));
    let buf = '';
    const timer = setTimeout(() => { c.destroy(); resolve(`(no reply) ${buf}`); }, 5000);
    c.on('data', (d) => {
      buf += d;
      if (buf.includes('\r\n')) { clearTimeout(timer); c.destroy(); resolve(buf.split('\r\n')[0]); }
    });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
