// BBR-54: the native install in SETUP_SCRIPT, run for real against fakes.
//
// Nothing here touches the network or a real browse. Every run gets a PATH
// that is an allow-list: a private bin of symlinks to the real tools the
// script needs, plus fake `curl` (serves two local files by URL and logs every
// request), `uname`, `ldd`, `ss` and optionally `npm`. /usr/bin is never on
// that PATH, so the real curl and npm cannot be reached even by a test bug.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_FUNCS, SETUP_SCRIPT, parseSetupOutput, verifySetup } from '../src/core/browse.js';

// Every temp root this file makes, removed once all its tests have run (BBR-61).
// runSetup returns paths inside its root that the assertions read, so removal
// waits for the end of the file rather than the end of runSetup.
const roots = [];
const tmpRoot = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const PIN = '0.1.4';
const metaUrl = (target, pin = PIN) => `https://registry.npmjs.org/@opencode%2fbrowse-${target}/${pin}`;
const tgzUrl = (target, pin = PIN) => `https://registry.npmjs.org/@opencode/browse-${target}/-/browse-${target}-${pin}.tgz`;

function real(tool) {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) if (existsSync(join(dir, tool))) return join(dir, tool);
  throw new Error(`test needs ${tool} on this machine`);
}
const BASH = real('bash');
const SH = '/bin/sh';

/** Everything SETUP_SCRIPT and the fakes call, minus what a case leaves out. */
const TOOLS = ['mktemp', 'rm', 'mv', 'chmod', 'mkdir', 'cp', 'cut', 'tr', 'wc', 'od', 'base64', 'sha512sum', 'grep', 'sed', 'tar', 'gzip', 'awk'];

function exe(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

/** A private bin dir: real tools by symlink (except `omit`), plus fakes. */
function makeBin(root, { omit = [], extra = [], os = 'Linux', arch = 'x86_64', libc = 'glibc' } = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const t of [...TOOLS, ...extra]) if (!omit.includes(t)) symlinkSync(real(t), join(bin, t));
  // Never the real curl. fakeCurl() replaces this stub when a run needs answers.
  if (!omit.includes('curl')) exe(join(bin, 'curl'), '#!/bin/sh\necho "stub curl: no network in tests" >&2\nexit 7\n');
  exe(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -m) echo ${arch} ;; *) echo ${os} ;; esac\n`);
  // musl's ldd prints its banner to stderr and exits 1; glibc's prints to stdout and exits 0.
  exe(join(bin, 'ldd'), libc === 'musl'
    ? '#!/bin/sh\necho "musl libc (x86_64)" >&2\necho "Version 1.2.4" >&2\nexit 1\n'
    : '#!/bin/sh\necho "ldd (GNU libc) 2.39"\n');
  exe(join(bin, 'ss'), "#!/bin/sh\nprintf '%s\\n' 'LISTEN 0 4096 127.0.0.1:29988 0.0.0.0:*'\n");
  return bin;
}

const STATUS = JSON.stringify({ relay: { running: true, pid: 4242, endpoint: 'http://127.0.0.1:29988' }, autoUpdate: { effective: 'off' } });
const fakeBrowse = (version) => `#!/bin/sh\ncase "$1" in\n  version) echo ${version} ;;\n  status) printf '%s\\n' '${STATUS}' ;;\n  *) : ;;\nesac\n`;

/** A real gzip'd npm-style tarball holding package/bin/browse, made locally. */
function makeTarball(root, bin) {
  const src = join(root, 'pkgsrc');
  mkdirSync(join(src, 'package', 'bin'), { recursive: true });
  exe(join(src, 'package', 'bin', 'browse'), fakeBrowse(PIN));
  writeFileSync(join(src, 'package', 'package.json'), JSON.stringify({ name: '@opencode/browse-linux-x64', version: PIN }));
  const tgz = join(root, 'pkg.tgz');
  const r = spawnSync(real('tar'), ['-czf', tgz, '-C', src, 'package'], { env: { PATH: bin } });
  assert.equal(r.status, 0, r.stderr?.toString());
  const bytes = readFileSync(tgz);
  return {
    tgz,
    browse: readFileSync(join(src, 'package', 'bin', 'browse'), 'utf8'),
    hex: createHash('sha512').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

/** Minified, like the registry's version document. */
function metaJson(target, { integrity, tarball }) {
  return JSON.stringify({ name: `@opencode/browse-${target}`, version: PIN, dist: { integrity, shasum: '0'.repeat(40), tarball, fileCount: 2 } });
}

/** Fake curl: the metadata URL and the tarball URL map to local files; anything else is 404. */
function fakeCurl(bin, root, routes) {
  const log = join(root, 'requests.log');
  const cases = Object.entries(routes).map(([url, file]) => `  '${url}') src='${file}' ;;`).join('\n');
  exe(join(bin, 'curl'), `#!/bin/sh
out=""; fmt=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -w) fmt=$2; shift ;;
    --connect-timeout|--max-time|--retry|--retry-max-time|--retry-delay) shift ;;
    http*) url=$1 ;;
  esac
  shift
done
echo "$url" >> '${log}'
src=""
case "$url" in
${cases}
esac
if [ -z "$src" ]; then
  [ -n "$fmt" ] && { printf 404; exit 0; }
  echo "curl: (22) The requested URL returned error: 404" >&2; exit 22
fi
cp "$src" "$out" || exit 23
[ -n "$fmt" ] && printf 200
exit 0
`);
  return log;
}

function fakeNpm(bin, root, browseText) {
  const sentinel = join(root, 'npm-called');
  exe(join(bin, 'npm'), `#!/bin/sh
echo "$*" > '${sentinel}'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/browse" <<'EOF'
${browseText}EOF
chmod 755 "$HOME/.local/bin/browse"
`);
  return sentinel;
}

/**
 * One whole SETUP_SCRIPT run, as exec.js runs it (`bash -s -- <browse> <pin>`
 * with the script on stdin), in a throwaway HOME.
 */
function runSetup({ os = 'Linux', arch = 'x86_64', libc = 'glibc', omit = [], npm = false, pin = PIN, browsePath = '$HOME/.local/bin/browse', meta, preinstall, curlExit } = {}) {
  const root = tmpRoot('bb-setup-');
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const bin = makeBin(root, { omit, os, arch, libc, extra: npm ? ['cat'] : [] });
  const pkg = makeTarball(root, bin);
  const target = 'linux-x64';
  const metaFile = join(root, 'meta.json');
  writeFileSync(metaFile, metaJson(target, { integrity: pkg.integrity, tarball: tgzUrl(target), ...meta }));
  const log = fakeCurl(bin, root, { [metaUrl(target)]: metaFile, [tgzUrl(target)]: pkg.tgz });
  // A host that cannot reach the registry at all: curl fails (6 = DNS, 28 = timeout) and prints no status.
  if (curlExit) exe(join(bin, 'curl'), `#!/bin/sh\necho "$*" >> '${log}'\necho "curl: (${curlExit}) could not reach the host" >&2\nexit ${curlExit}\n`);
  const sentinel = npm ? fakeNpm(bin, root, pkg.browse) : join(root, 'npm-called');
  if (preinstall) preinstall(home);
  const r = spawnSync(BASH, ['-s', '--', browsePath, pin], {
    input: SETUP_SCRIPT,
    env: { HOME: home, PATH: bin, TMPDIR: tmp },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const requests = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const installed = join(home, '.local', 'bin', 'browse');
  return {
    ...r, pkg, home, tmp, requests, installed,
    parsed: parseSetupOutput(r.stdout),
    npmCalled: existsSync(sentinel) ? readFileSync(sentinel, 'utf8').trim() : null,
    lastLine: r.stdout.split('\n').filter((l) => l && !l.startsWith('@@')).pop() ?? '',
  };
}

/**
 * Run one INSTALL_FUNCS function under a given shell, PATH = a private bin.
 * Under bash it runs with SETUP_SCRIPT's own `set -uo pipefail`.
 */
function piece(shell, bin, call, args = []) {
  const prelude = shell === BASH ? 'set -uo pipefail\n' : '';
  const r = spawnSync(shell, ['-c', `${prelude}${INSTALL_FUNCS}\n${call} "$@"`, 'sh', ...args], {
    env: { PATH: bin },
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('setup script: SETUP_SCRIPT parses under bash, and INSTALL_FUNCS under sh (dash) and bash', () => {
  assert.equal(spawnSync(BASH, ['-n'], { input: SETUP_SCRIPT }).status, 0);
  for (const shell of [SH, BASH]) assert.equal(spawnSync(shell, ['-n'], { input: INSTALL_FUNCS }).status, 0, shell);
});

for (const shell of [SH, BASH]) {
  test(`setup pieces (${shell}): target from uname and ldd; no baseline, musl from ldd or alpine-release`, () => {
    const root = tmpRoot('bb-piece-');
    const cases = [
      [{ arch: 'x86_64' }, 0, 'linux-x64'],
      [{ arch: 'amd64' }, 0, 'linux-x64'],
      [{ arch: 'aarch64' }, 0, 'linux-arm64'],
      [{ arch: 'arm64' }, 0, 'linux-arm64'],
      [{ arch: 'x86_64', libc: 'musl' }, 0, 'linux-x64-musl'],
      [{ arch: 'aarch64', libc: 'musl' }, 0, 'linux-arm64-musl'],
      [{ arch: 'armv7l' }, 2, ''],
      [{ os: 'Darwin', arch: 'arm64' }, 1, ''],
      [{ os: 'FreeBSD', arch: 'amd64' }, 1, ''],
    ];
    for (const [i, [opts, status, out]] of cases.entries()) {
      const bin = makeBin(join(root, String(i)), opts);
      const r = piece(shell, bin, 'bb_target', [join(root, 'no-such-alpine-release')]);
      assert.deepEqual([r.status, r.out], [status, out], JSON.stringify(opts));
    }
    // /etc/alpine-release alone (glibc-looking ldd) still means musl.
    const alpine = join(root, 'alpine-release');
    writeFileSync(alpine, '3.20.0\n');
    const r = piece(shell, makeBin(join(root, 'alp')), 'bb_target', [alpine]);
    assert.deepEqual([r.status, r.out], [0, 'linux-x64-musl']);
  });

  test(`setup pieces (${shell}): integrity decodes to the 128-hex SHA-512, via base64 or openssl; malformed is refused`, () => {
    const root = tmpRoot('bb-piece-');
    const digest = createHash('sha512').update('browse-bridge BBR-54').digest();
    const integrity = `sha512-${digest.toString('base64')}`;
    assert.equal(integrity.length, 7 + 88);
    const withBase64 = makeBin(join(root, 'a'));
    const withOpenssl = makeBin(join(root, 'b'), { omit: ['base64'], extra: ['openssl'] });
    for (const bin of [withBase64, withOpenssl]) {
      const r = piece(shell, bin, 'bb_integrity_hex', [integrity]);
      assert.deepEqual([r.status, r.out], [0, digest.toString('hex')], bin);
    }
    const sha256 = `sha256-${createHash('sha256').update('x').digest('base64')}`;
    for (const bad of [sha256, integrity.slice(0, -1), `${integrity}A`, integrity.replace(/.$/, '!'), 'sha512-', '']) {
      const r = piece(shell, withBase64, 'bb_integrity_hex', [bad]);
      assert.deepEqual([r.status, r.out], [1, ''], `refused: ${bad}`);
    }
  });

  test(`setup pieces (${shell}): only a registry.npmjs.org/@opencode/ tarball URL is accepted`, () => {
    const bin = makeBin(tmpRoot('bb-piece-'));
    assert.equal(piece(shell, bin, 'bb_tarball_ok', [tgzUrl('linux-x64')]).status, 0);
    for (const bad of [
      'http://registry.npmjs.org/@opencode/browse-linux-x64/-/browse-linux-x64-0.1.4.tgz',
      'https://registry.npmjs.org.evil.example/@opencode/browse-linux-x64/-/x.tgz',
      'https://registry.npmjs.org/@opencodex/browse-linux-x64/-/x.tgz',
      'https://registry.npmjs.org/@evil/browse-linux-x64/-/x.tgz',
      'https://registry.npmjs.org/@opencode/../@evil/x/-/x.tgz',
      'https://registry.npmjs.org/@opencode/%2e%2e/@evil/x/-/x.tgz',
      'https://registry.npmjs.org/@opencode/.%2e/@evil/x/-/x.tgz',
      'https://registry.npmjs.org/@opencode/x.tgz y',
      'https://registry.npmjs.org/@opencode/x.tgz"',
      '',
    ]) assert.equal(piece(shell, bin, 'bb_tarball_ok', [bad]).status, 1, `refused: ${bad}`);
  });

  test(`setup pieces (${shell}): missing tools are named; sha512 and json helpers`, () => {
    const root = tmpRoot('bb-piece-');
    const full = makeBin(join(root, 'full'));
    assert.deepEqual(piece(shell, full, 'bb_need_tools'), { status: 0, out: '', err: '' });
    const noCurl = makeBin(join(root, 'nocurl'), { omit: ['curl', 'tar', 'gzip'] });
    const r = piece(shell, noCurl, 'bb_need_tools');
    assert.equal(r.status, 1);
    assert.equal(r.out, 'curl tar gzip');
    const noHash = makeBin(join(root, 'nohash'), { omit: ['sha512sum', 'base64'] });
    assert.equal(piece(shell, noHash, 'bb_need_tools').out, 'sha512sum/shasum/openssl base64/openssl');

    const file = join(root, 'blob');
    writeFileSync(file, 'abc');
    const want = createHash('sha512').update('abc').digest('hex');
    assert.equal(piece(shell, full, 'bb_sha512', [file]).out, want);
    assert.equal(piece(shell, makeBin(join(root, 'ossl'), { omit: ['sha512sum'], extra: ['openssl'] }), 'bb_sha512', [file]).out, want);

    const meta = join(root, 'meta.json');
    writeFileSync(meta, metaJson('linux-x64', { integrity: 'sha512-AAAA', tarball: tgzUrl('linux-x64') }));
    assert.equal(piece(shell, full, 'bb_json_str', ['tarball', meta]).out, tgzUrl('linux-x64'));
    assert.equal(piece(shell, full, 'bb_json_str', ['integrity', meta]).out, 'sha512-AAAA');
    writeFileSync(meta, '{"dist":{"integrity":"sha512-A","integrity":"sha512-B"}}');
    assert.equal(piece(shell, full, 'bb_json_str', ['integrity', meta]).status, 1, 'two matches are refused, not guessed');
    assert.equal(piece(shell, full, 'bb_json_str', ['tarball', meta]).status, 1, 'no match is refused');
  });
}

test('setup script: native install fetches the pinned tarball, checks its SHA-512 and installs package/bin/browse', () => {
  const r = runSetup({ npm: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.requests, [metaUrl('linux-x64'), tgzUrl('linux-x64')]);
  assert.equal(r.parsed.steps.install, 'ok');
  assert.equal(r.parsed.installVia, 'native');
  assert.equal(r.parsed.installSha512, r.pkg.hex, 'the marker carries the hash computed from the local tarball');
  assert.deepEqual(verifySetup(r.parsed, { version: PIN }), []);
  assert.equal(readFileSync(r.installed, 'utf8'), r.pkg.browse);
  assert.equal(statSync(r.installed).mode & 0o777, 0o755);
  assert.equal(existsSync(`${r.installed}.new`), false);
  assert.equal(r.npmCalled, null, 'npm present but not used on Linux');
  assert.deepEqual(readdirSync(r.tmp), [], 'the temp dir is removed by the trap');
});

test('setup script: a tarball whose SHA-512 differs from dist.integrity installs nothing, exits 4, never falls through to npm', () => {
  // One nibble flipped in the served integrity: still a well-formed sha512, so it fails at the comparison.
  const probe = runSetup();
  const flipped = probe.pkg.hex.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const integrity = `sha512-${Buffer.from(flipped, 'hex').toString('base64')}`;
  const r = runSetup({ npm: true, meta: { integrity } });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.equal(r.parsed.steps.install, 'fail');
  assert.match(r.lastLine, new RegExp(`checksum mismatch .*expected sha512 ${flipped}, got ${r.pkg.hex}`));
  assert.equal(existsSync(r.installed), false);
  assert.equal(existsSync(`${r.installed}.new`), false);
  assert.equal(r.npmCalled, null, 'a native failure never falls through to npm');
  assert.equal(r.parsed.installSha512, null);
  assert.match(verifySetup(r.parsed, { version: PIN }).join('\n'), /step install: fail/);
});

test('setup script: a tarball URL outside registry.npmjs.org/@opencode/ is refused before it is fetched', () => {
  const evil = 'https://evil.example/@opencode/browse-linux-x64/-/browse-linux-x64-0.1.4.tgz';
  const r = runSetup({ npm: true, meta: { tarball: evil } });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.lastLine, /refusing tarball URL outside https:\/\/registry\.npmjs\.org\/@opencode\/: https:\/\/evil\.example/);
  assert.deepEqual(r.requests, [metaUrl('linux-x64')], 'the tarball was never requested');
  assert.equal(r.npmCalled, null);
});

test('setup script: a version the registry does not have exits 4 with the HTTP status', () => {
  const r = runSetup({ pin: '0.1.99' });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.lastLine, /registry answered HTTP 404 for @opencode\/browse-linux-x64@0\.1\.99/);
  assert.equal(existsSync(r.installed), false);
});

for (const curlExit of [6, 28]) {
  test(`setup script: a registry curl cannot reach (exit ${curlExit}, no status) says so, exits 4 and installs nothing`, () => {
    const r = runSetup({ npm: true, curlExit });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.equal(r.parsed.steps.install, 'fail');
    assert.equal(r.lastLine, `could not reach registry.npmjs.org from this host (curl exit ${curlExit}); check its DNS and outbound HTTPS`);
    assert.doesNotMatch(r.stdout, /HTTP 000/);
    assert.equal(r.requests.length, 1, 'only the metadata fetch was tried');
    assert.equal(existsSync(r.installed), false);
    assert.equal(existsSync(`${r.installed}.new`), false);
    assert.equal(r.npmCalled, null);
  });
}

test('setup script: a missing tool exits 3 and is named', () => {
  const r = runSetup({ omit: ['od'] });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(r.parsed.steps.install, 'fail');
  assert.match(r.lastLine, /cannot install browse 0\.1\.4: missing od$/);
  assert.deepEqual(r.requests, []);
});

test('setup script: npm only on a non-Linux remote; without npm there, and on an unsupported Linux arch, exit 6', () => {
  const mac = runSetup({ os: 'Darwin', arch: 'arm64', npm: true });
  assert.equal(mac.status, 0, mac.stdout + mac.stderr);
  assert.equal(mac.npmCalled, `i -g --prefix ${mac.home}/.local @opencode/browse@${PIN}`);
  assert.equal(mac.parsed.installVia, 'npm');
  assert.deepEqual(verifySetup(mac.parsed, { version: PIN }), [], 'npm checks the registry integrity itself');
  assert.deepEqual(mac.requests, []);

  const macNoNpm = runSetup({ os: 'Darwin', arch: 'arm64' });
  assert.equal(macNoNpm.status, 6);
  assert.equal(macNoNpm.lastLine, 'unsupported platform Darwin/arm64; install browse yourself and set remoteBrowse');

  const arm32 = runSetup({ arch: 'armv7l', npm: true });
  assert.equal(arm32.status, 6);
  assert.equal(arm32.npmCalled, null, 'Linux never uses npm: its launcher would need Node 22');
  assert.match(arm32.lastLine, /^unsupported platform Linux\/armv7l;/);
});

test('setup script: the install renames over an old npm launcher symlink; at the pin it skips; outside ~/.local it exits 5', () => {
  let launcher;
  const r = runSetup({
    preinstall(home) {
      const lib = join(home, '.local', 'lib', 'node_modules', '@opencode', 'browse', 'dist');
      mkdirSync(lib, { recursive: true });
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      launcher = join(lib, 'cli.mjs');
      exe(launcher, fakeBrowse('0.1.3'));
      symlinkSync('../lib/node_modules/@opencode/browse/dist/cli.mjs', join(home, '.local', 'bin', 'browse'));
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.parsed.steps.install, 'ok');
  assert.equal(lstatSync(r.installed).isFile(), true, 'a regular file now, not the symlink');
  assert.equal(readFileSync(launcher, 'utf8'), fakeBrowse('0.1.3'), 'the launcher it pointed at is left alone');

  const skip = runSetup({
    preinstall(home) {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      exe(join(home, '.local', 'bin', 'browse'), fakeBrowse(PIN));
    },
  });
  assert.equal(skip.status, 0);
  assert.equal(skip.parsed.steps.install, 'skip');
  assert.deepEqual(skip.requests, []);
  assert.deepEqual(verifySetup(skip.parsed, { version: PIN }), []);

  const elsewhere = runSetup({ browsePath: '/opt/browse/bin/browse' });
  assert.equal(elsewhere.status, 5);
  assert.deepEqual(elsewhere.requests, []);
});
