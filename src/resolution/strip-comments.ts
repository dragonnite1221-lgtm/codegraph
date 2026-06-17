/**
 * Per-language comment stripper for framework route extractors.
 *
 * Replaces comment characters and string-literal contents that hide
 * routing-shaped text with spaces (NOT removal) so that source offsets
 * are preserved. This means `match.index` from a regex run on the
 * stripped output still maps to the same line in the original source.
 *
 * Example:
 *   Input:  "x = 1  # path('/fake/', V)\n real = 2"
 *   Output: "x = 1                       \n real = 2"
 *
 * Why strip strings/docstrings as well as comments? Python module/class
 * docstrings are a common source of false positives — they often contain
 * `path('/example/', View)` examples in usage docs. We treat triple-quoted
 * strings the same as comments. Single-line strings stay intact (a `#`
 * inside a Python string is NOT a comment).
 *
 * Scope: this is a pragmatic, regex-supporting helper, not a full parser.
 * It does NOT try to detect JS regex literals, Python f-string expressions,
 * or shell-style heredocs. Those edge cases are not load-bearing for the
 * `path(...)`, `Route::get(...)`, `app.get(...)` style patterns that
 * framework extractors scan for.
 */

import { stripPython, stripRuby } from './strip-comments-langs1';
import { stripCStyle, stripPhp } from './strip-comments-langs2';
import { stripGo, stripRust } from './strip-comments-langs3';

export type CommentLang =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'php'
  | 'ruby'
  | 'java'
  | 'csharp'
  | 'swift'
  | 'go'
  | 'rust';

export function stripCommentsForRegex(content: string, lang: CommentLang): string {
  switch (lang) {
    case 'python':
      return stripPython(content);
    case 'ruby':
      return stripRuby(content);
    case 'rust':
      return stripRust(content);
    case 'php':
      return stripPhp(content);
    case 'go':
      return stripGo(content);
    case 'javascript':
    case 'typescript':
    case 'java':
    case 'csharp':
    case 'swift':
      return stripCStyle(content, /* allowSingleQuoteStrings */ lang === 'javascript' || lang === 'typescript');
    default:
      return content;
  }
}

/**
 * Replace every char in a slice with spaces, but keep newlines so line
 * numbers computed downstream remain valid.
 */
export function blankRange(buf: string[], start: number, end: number, src: string): void {
  for (let i = start; i < end; i++) {
    buf[i] = src[i] === '\n' ? '\n' : ' ';
  }
}

// ---------- Python ----------
