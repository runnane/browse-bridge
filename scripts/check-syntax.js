// Syntax-check every source file with `node --check` (no build step in this repo).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(c|m)?js$/.test(name) ? [p] : [];
  });
}

const files = [...walk('src'), ...walk('test'), ...walk('scripts')];
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`syntax ok: ${files.length} files`);
