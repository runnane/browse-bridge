import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const PAIR_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;

/** Pairing codes are one-time secrets: they never reach the log file or the ring buffer. */
export function redact(text) {
  return String(text);
}

/**
 * File logger with a single rotation (log → log.1 at maxBytes) and an
 * in-memory ring buffer the UI reads from.
 */
export class Logger {
  constructor({ file = null, maxBytes = 1_000_000, ringSize = 500, echo = false } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.ringSize = ringSize;
    this.echo = echo;
    this.ring = [];
    this.listeners = new Set();
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  onEntry(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** `host` tags the line with the host it is about (null for app-wide lines). */
  log(level, source, message, host = null) {
    const entry = { ts: new Date().toISOString(), level, source, message: redact(message) };
    if (host != null) entry.host = redact(host);
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    const tag = entry.host != null ? `${entry.host}/${source}` : source;
    const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} [${tag}] ${entry.message}\n`;
    if (this.echo) process.stderr.write(line);
    if (this.file) {
      try {
        if (statSync(this.file, { throwIfNoEntry: false })?.size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
        appendFileSync(this.file, line);
      } catch {
        // A full or read-only disk must not take the tunnel down with it.
      }
    }
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  info(source, message) { return this.log('info', source, message); }
  warn(source, message) { return this.log('warn', source, message); }
  error(source, message) { return this.log('error', source, message); }

  /** A logger with the same interface whose every line is tagged with one host id. */
  forHost(host) {
    const log = (level, source, message) => this.log(level, source, message, host);
    return {
      host,
      log,
      info: (source, message) => log('info', source, message),
      warn: (source, message) => log('warn', source, message),
      error: (source, message) => log('error', source, message),
    };
  }
}
