import * as fs from 'fs';

/** Skip only the unavailable Windows symlink privilege, never product errors. */
export function createTestSymlink(target: string, link: string, skip: (note?: string) => never): void {
  try {
    fs.symlinkSync(target, link);
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      skip('Windows file symlink privilege is unavailable');
    }
    throw error;
  }
}
