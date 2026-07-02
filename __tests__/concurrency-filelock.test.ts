/**
 * FileLock staleness contract.
 *
 * Regression guard for the bug where a lock older than the stale
 * timeout was reclaimed even though its owning process was still
 * alive — letting a long indexing run (minutes on the wasm backend) be
 * overrun by a second writer. Liveness, not age, must decide when the
 * owner PID is known; age is only the fallback for an unreadable PID.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileLock } from '../src/concurrency';

describe('FileLock staleness', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lock-'));
    lockPath = path.join(tmpDir, 'db.lock');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const ageFile = (p: string, msAgo: number) => {
    const t = new Date(Date.now() - msAgo);
    fs.utimesSync(p, t, t);
  };

  it('does NOT steal a lock held by a live process, even when old', () => {
    // Our own PID is alive; backdate the lock well past the stale window.
    fs.writeFileSync(lockPath, String(process.pid));
    ageFile(lockPath, 10 * 60 * 1000); // 10 minutes old

    expect(() => new FileLock(lockPath).acquire()).toThrow(/locked by another process/);
    // Lock file must survive the failed acquire.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
  });

  it('reclaims a lock whose owning process is dead', () => {
    // A PID that is almost certainly not running.
    const deadPid = 2147483646;
    fs.writeFileSync(lockPath, String(deadPid));
    ageFile(lockPath, 1000); // recent, but owner is dead

    const lock = new FileLock(lockPath);
    expect(() => lock.acquire()).not.toThrow();
    // We now own it.
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('falls back to age for an unreadable PID: fresh unreadable lock is respected', () => {
    fs.writeFileSync(lockPath, 'not-a-pid');
    ageFile(lockPath, 1000); // fresh
    expect(() => new FileLock(lockPath).acquire()).toThrow(/locked by another process/);
  });

  it('falls back to age for an unreadable PID: stale unreadable lock is reclaimed', () => {
    fs.writeFileSync(lockPath, 'not-a-pid');
    ageFile(lockPath, 10 * 60 * 1000); // past the stale window
    const lock = new FileLock(lockPath);
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });
});
