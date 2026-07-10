/** Low-frequency reconciliation for platforms that silently drop fs.watch events. */

import * as fs from 'fs';
import * as path from 'path';
import type { CodeGraphConfig } from '../types';
import { scanDirectory } from '../extraction';

export class FilePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fingerprint = '';
  private scanning = false;

  constructor(
    private readonly projectRoot: string,
    private readonly config: CodeGraphConfig,
    private readonly intervalMs: number,
    private readonly onChange: () => void,
    private readonly onError: (error: Error) => void,
  ) {}

  start(): boolean {
    if (this.intervalMs <= 0) return false;
    if (this.timer) return true;
    try {
      this.fingerprint = this.readFingerprint();
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isActive(): boolean {
    return this.timer !== null;
  }

  private async check(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const next = this.readFingerprint();
      if (next !== this.fingerprint) {
        this.fingerprint = next;
        this.onChange();
      }
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.scanning = false;
    }
  }

  private readFingerprint(): string {
    const entries: string[] = [];
    for (const relative of scanDirectory(this.projectRoot, this.config)) {
      try {
        const stat = fs.statSync(path.join(this.projectRoot, relative));
        entries.push(`${relative}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    entries.sort();
    return entries.join('\n');
  }
}
