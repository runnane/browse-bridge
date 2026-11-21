// Excerpt of rust/crates/browse-relay/src/protocol.rs at anomalyco/browse v0.1.4 (constants only).
pub const EXTENSION_PROTOCOL_VERSION: i64 = 3;
// Oldest extension protocol this relay still accepts.
pub const MIN_EXTENSION_PROTOCOL_VERSION: i64 = 3;

pub const PAIRING_SCHEME: &str = "opencode-browser-pairing-v3";

let compatible = version.is_some_and(|v| (MIN_EXTENSION_PROTOCOL_VERSION..=EXTENSION_PROTOCOL_VERSION).contains(&v));
