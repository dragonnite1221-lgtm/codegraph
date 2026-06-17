/**
 * Python/Ruby comment stripping split out of strip-comments.ts to keep it within the 200-line
 * limit. No behavior change.
 */

import { blankRange } from './strip-comments';

export function stripPython(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';
    const c3 = src[i + 2] ?? '';

    // Triple-quoted string: """...""" or '''...'''
    if ((c === '"' || c === "'") && c2 === c && c3 === c) {
      const quote = c;
      const start = i;
      i += 3;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === quote && src[i + 1] === quote && src[i + 2] === quote) {
          i += 3;
          break;
        }
        i++;
      }
      blankRange(out, start, i, src);
      continue;
    }

    // Single-line string: '...' or "..."
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break; // unterminated
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    // Line comment
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Ruby ----------

export function stripRuby(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let atLineStart = true;

  while (i < n) {
    const c = src[i]!;

    // =begin / =end block comments must be at start of line (after optional whitespace)
    if (atLineStart && c === '=' && src.startsWith('=begin', i)) {
      const start = i;
      // consume to matching =end at line start
      i += '=begin'.length;
      while (i < n) {
        if (src[i] === '\n') {
          // check next line for =end
          let j = i + 1;
          while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
          if (src.startsWith('=end', j)) {
            i = j + '=end'.length;
            // consume rest of that line
            while (i < n && src[i] !== '\n') i++;
            break;
          }
        }
        i++;
      }
      blankRange(out, start, i, src);
      atLineStart = i > 0 && src[i - 1] === '\n';
      continue;
    }

    // String literals
    if (c === '"' || c === "'") {
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
      atLineStart = false;
      continue;
    }

    // Line comment
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      atLineStart = false;
      continue;
    }

    if (c === '\n') {
      atLineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      // whitespace doesn't change atLineStart
      i++;
      continue;
    }
    atLineStart = false;
    i++;
  }

  return out.join('');
}

// ---------- C-style (JS/TS/Java/C#/Swift) ----------

