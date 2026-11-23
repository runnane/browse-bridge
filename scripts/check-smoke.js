// Reads the JSON the headless smoke render writes (BB_SMOKE_OUT=<prefix> →
// <prefix>.json) and decides whether the built AppImage is publishable
// (BBR-72). Red when the file is missing, `errors` is not an empty list, or
// the About dialog does not show the expected version. See .agents/gates.md:
// a renderer load error can leave `errors` empty, so a missing JSON (the
// timeout case) is red too.
//
//   node scripts/check-smoke.js <prefix>.json <version>
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UPDATER_LOAD_FAILED } from '../src/core/appupdate.js';

/** @returns {{ok: boolean, problems: string[]}} */
export function checkSmoke(smoke, version) {
  const problems = [];
  if (!smoke || typeof smoke !== 'object') return { ok: false, problems: ['smoke output is not a JSON object'] };
  if (!Array.isArray(smoke.errors)) problems.push('errors is not a list');
  else if (smoke.errors.length > 0) problems.push(`errors is not empty: ${JSON.stringify(smoke.errors)}`);
  const about = smoke.dialogs?.about;
  if (typeof about !== 'string' || about === '') problems.push('dialogs.about is missing');
  else if (!about.includes(version)) problems.push(`dialogs.about does not show version ${version}`);
  // BBR-73: the packaged build loads electron-updater at start-up; About says so when it could not.
  if (typeof about === 'string' && about.includes(UPDATER_LOAD_FAILED)) problems.push(`dialogs.about says ${UPDATER_LOAD_FAILED}`);
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, version] = process.argv.slice(2);
  if (!file || !version) {
    console.error('usage: node scripts/check-smoke.js <smoke.json> <version>');
    process.exit(2);
  }
  if (!existsSync(file)) {
    console.error(`smoke output ${file} was never written`);
    process.exit(1);
  }
  const r = checkSmoke(JSON.parse(readFileSync(file, 'utf8')), version);
  for (const p of r.problems) console.error(`smoke: ${p}`);
  if (r.ok) console.log(`smoke ok: no errors, About shows ${version}`);
  process.exit(r.ok ? 0 : 1);
}
