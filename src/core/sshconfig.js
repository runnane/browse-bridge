/**
 * The Host aliases in ~/.ssh/config, for the host form's suggestions
 * (BBR-46). `parseSshAliases` is pure: it takes the file's text and a reader
 * for the files an `Include` names, so the tests use fixture text and a fake
 * reader and never touch a real ~/.ssh. `fsReader` is the real reader main
 * passes in.
 *
 * Read the way ssh_config(5) reads it: keywords are case-insensitive and take
 * `Key value` or `Key=value`; `Host` carries several patterns; a `Match`
 * line ends the Host block; an `Include` path that is not absolute (or ~/)
 * is relative to ~/.ssh, may be a glob, and may name several files. Wildcard
 * (`*`, `?`) and negated (`!`) patterns are not aliases a person can pick, so
 * they are skipped, but a `LocalForward` under one (e.g. `Host *`) still
 * flags every alias it matches, as ssh would apply it there.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** ssh's own include depth limit (READCONF_MAX_DEPTH); also what stops an Include cycle. */
export const MAX_INCLUDE_DEPTH = 16;

/** Split a line's arguments on whitespace, keeping "double quoted" ones whole. */
function args(rest) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(rest))) out.push(m[1] ?? m[2]);
  return out;
}

/** An ssh host pattern (`*`, `?`) as a whole-string, case-insensitive RegExp. */
function patternRe(p) {
  const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

/** Whether a Host line's patterns match `name`, as ssh decides it: any negated match rules the block out. */
function blockMatches(patterns, name) {
  let hit = false;
  for (const p of patterns) {
    const neg = p.startsWith('!');
    if (patternRe(neg ? p.slice(1) : p).test(name)) {
      if (neg) return false;
      hit = true;
    }
  }
  return hit;
}

/** Where an Include argument points: ~/ is the home, a relative path is under ~/.ssh. */
export function includePath(arg, home) {
  if (arg.startsWith('~/')) return `${home}/${arg.slice(2)}`;
  if (arg.startsWith('/')) return arg;
  return `${home}/.ssh/${arg}`;
}

/**
 * The aliases in an ssh config text: [{ alias, localForward }], in the order
 * first seen, each once. `reader.glob(pattern)` lists the files an Include
 * pattern names (sorted), `reader.read(path)` returns a file's text or null.
 */
export function parseSshAliases(text, { reader = { glob: () => [], read: () => null }, home = '~' } = {}) {
  const blocks = [];
  const order = [];
  const walk = (src, depth, enclosing) => {
    let block = enclosing;
    for (const rawLine of String(src ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const values = args(m[2]);
      if (key === 'host') {
        block = { patterns: values, localForward: false };
        blocks.push(block);
        for (const p of values) if (!/[*?!]/.test(p) && !order.some((a) => a.toLowerCase() === p.toLowerCase())) order.push(p);
      } else if (key === 'match') {
        // A Match block's options are not any Host block's.
        block = null;
      } else if (key === 'localforward') {
        if (block) block.localForward = true;
      } else if (key === 'include' && depth < MAX_INCLUDE_DEPTH) {
        for (const arg of values) {
          for (const file of reader.glob(includePath(arg, home))) walk(reader.read(file), depth + 1, block);
        }
        // ssh restores the enclosing block once the included file ends.
      }
    }
  };
  walk(text, 0, null);
  return order.map((alias) => ({
    alias,
    localForward: blocks.some((b) => b.localForward && blockMatches(b.patterns, alias)),
  }));
}

/** glob(3) for one path component: `*` and `?`, never matching a leading dot. */
function componentRe(c) {
  return new RegExp(`^(?!\\.)${c.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** The real reader: files on disk; anything unreadable is null or no match, never a throw. */
export const fsReader = Object.freeze({
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  glob(pattern) {
    if (!/[*?]/.test(pattern)) return [pattern];
    const parts = pattern.split('/');
    let bases = [parts[0] === '' ? '/' : parts[0]];
    for (const part of parts.slice(1)) {
      if (!part) continue;
      if (!/[*?]/.test(part)) {
        bases = bases.map((b) => join(b, part));
        continue;
      }
      const re = componentRe(part);
      bases = bases.flatMap((b) => {
        try {
          return readdirSync(b).filter((n) => re.test(n)).sort().map((n) => join(b, n));
        } catch {
          return [];
        }
      });
    }
    return bases;
  },
});

/** The aliases in `<home>/.ssh/config` and what it includes; [] when there is no such file. */
export function readSshAliases(home, reader = fsReader) {
  const text = reader.read(`${home}/.ssh/config`);
  return text == null ? [] : parseSshAliases(text, { reader, home });
}
