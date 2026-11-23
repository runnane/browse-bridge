// (BBR-72 negative control: touched so the release workflow's path filter fires.)
// Prints PINNED_BROWSE_VERSION from src/core/config.js, so CI (and anyone
// fetching the matching browse binary) never hard-codes the version.
import { PINNED_BROWSE_VERSION } from '../src/core/config.js';

process.stdout.write(`${PINNED_BROWSE_VERSION}\n`);
