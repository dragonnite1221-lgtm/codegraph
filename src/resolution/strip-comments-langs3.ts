/**
 * Go/Rust comment stripping split out of strip-comments.ts to keep it within the 200-line
 * limit. No behavior change.
 */

import { blankRange } from './strip-comments';

export function stripGo(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // Block comment
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // Line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // Raw string with backticks (no escapes, can span lines)
    if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') i++;
      if (i < n) i++;
      continue;
    }

    // Interpreted string with double quotes
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === '"') i++;
      continue;
    }

    // Rune literal with single quotes (handle as a tiny string)
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === "'") i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Rust ----------

export function stripRust(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // Nested block comment /* ... /* ... */ ... */
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blankRange(out, start, i, src);
      continue;
    }

    // Line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // String literals
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < n && src[i] === '"') i++;
      continue;
    }

    // Char literal — keep simple: skip 'x' or '\x'
    if (c === "'") {
      // Could be a lifetime, e.g. 'a, but those don't contain routing text
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === "'") i++;
      continue;
    }

    i++;
  }

  return out.join('');
}
