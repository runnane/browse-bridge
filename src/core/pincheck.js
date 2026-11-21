// Pure parser and verdict for scripts/check-browse-pin.js (BBR-50): is the newest
// stable upstream extension still inside the pinned relay's protocol range?
// No I/O here, so the tests run it against fixture text.

// Upstream files whose change between two tags a human should read first.
export const WATCHED_FILES = [
  'rust/crates/browse-relay/src/handshake.rs',
  'rust/crates/browse-relay/src/pairing.rs',
  'rust/crates/browse-relay/src/protocol.rs',
  'src/agent-relay/protocol.ts',
  'src/background/agent-relay/wire.ts',
];

export const PROTOCOL_RS_PATH = 'rust/crates/browse-relay/src/protocol.rs';

// Reads the three constants from protocol.rs text. Throws if one is missing, so a
// renamed constant upstream is a loud failure rather than a silent pass.
export function parseProtocolConstants(text) {
  const num = (name) => {
    // Anchored on `pub const ` so the MIN_ constant never satisfies the plain name.
    const m = new RegExp(`pub const ${name}\\s*:\\s*[iu]\\d+\\s*=\\s*(\\d+)\\s*;`).exec(text);
    if (!m) throw new Error(`${name} not found in protocol.rs`);
    return Number(m[1]);
  };
  const scheme = /pub const PAIRING_SCHEME\s*:\s*&str\s*=\s*"([^"]+)"\s*;/.exec(text);
  if (!scheme) throw new Error('PAIRING_SCHEME not found in protocol.rs');
  return {
    current: num('EXTENSION_PROTOCOL_VERSION'),
    min: num('MIN_EXTENSION_PROTOCOL_VERSION'),
    scheme: scheme[1],
  };
}

// pin / latest: parseProtocolConstants results. The newest stable extension speaks
// latest.current; the pinned relay accepts pin.min..pin.current.
export function verdict(pin, latest) {
  const reasons = [];
  if (latest.current > pin.current) {
    reasons.push(`extension protocol ${latest.current} is newer than the pin's ${pin.current} (relay would refuse it)`);
  }
  if (latest.current < pin.min) {
    reasons.push(`extension protocol ${latest.current} is older than the pin's minimum ${pin.min} (relay would refuse it)`);
  }
  if (latest.scheme !== pin.scheme) {
    reasons.push(`pairing scheme changed: "${pin.scheme}" -> "${latest.scheme}"`);
  }
  return { compatible: reasons.length === 0, reasons };
}

// Which watched files appear in a GitHub compare API response's `files` array.
export function changedWatchedFiles(compare) {
  const names = new Set((compare?.files ?? []).map((f) => f.filename));
  return WATCHED_FILES.filter((f) => names.has(f));
}
