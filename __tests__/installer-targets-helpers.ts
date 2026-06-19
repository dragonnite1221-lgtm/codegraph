/**
 * Shared helpers for the installer-targets test suite. Not a *.test.ts file
 * so vitest does not execute it directly. Split out of installer-targets.test.ts
 * to stay within the file-size gate.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

// `os.homedir` is non-configurable on Node, so we redirect it via the
// `$HOME` (POSIX) / `$USERPROFILE` (Windows) env vars that
// `os.homedir()` reads first. Same trick the rest of the suite uses
// when it needs a mock home.
export function setHome(dir: string): { restore: () => void } {
  // Capture HOME/USERPROFILE *and* the config-dir overrides the opencode target
  // honours (XDG_CONFIG_HOME on POSIX, APPDATA on Windows). If a CI runner has
  // XDG_CONFIG_HOME set, the installer would write outside the mock home and the
  // global-install assertions would fail — so clear them for the duration.
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.APPDATA;
  const restoreVar = (k: 'HOME' | 'USERPROFILE' | 'XDG_CONFIG_HOME' | 'APPDATA') => {
    if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  };
  return {
    restore() {
      restoreVar('HOME');
      restoreVar('USERPROFILE');
      restoreVar('XDG_CONFIG_HOME');
      restoreVar('APPDATA');
    },
  };
}

export function listAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}
