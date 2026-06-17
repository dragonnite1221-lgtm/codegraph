/**
 * C-style/PHP comment stripping split out of strip-comments.ts to keep it within the 200-line
 * limit. No behavior change.
 */

import { blankRange } from './strip-comments';

export function stripCStyle(src: string, allowSingleQuoteStrings: boolean): string {
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

    // String literals
    if (c === '"' || (allowSingleQuoteStrings && c === "'") || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        // Template literal can span lines; regular strings break on newline (treat as unterminated)
        if (quote !== '`' && src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- PHP ----------

export function stripPhp(src: string): string {
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

    // // line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // # line comment (PHP supports both)
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // String literals: ', ", ` (PHP doesn't really use backticks for strings,
    // but it does have shell-exec backticks; treating as a string is fine here)
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Go ----------

