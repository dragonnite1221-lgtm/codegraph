/**
 * Language detection from file extension + C/C++ disambiguation heuristic.
 * Split out of grammars.ts to keep it within the file-size gate; re-exported
 * from grammars.ts for stable import paths.
 */

import { Language } from '../types';
import { EXTENSION_MAP } from './grammar-tables';

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string, source?: string): Language {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  const lang = EXTENSION_MAP[ext] || 'unknown';

  // .h files could be C or C++ — check source content for C++ features
  if (lang === 'c' && ext === '.h' && source) {
    if (looksLikeCpp(source)) return 'cpp';
  }

  return lang;
}

/**
 * Heuristic: does a .h file contain C++ constructs?
 * Checks the first ~8KB for patterns that are unique to C++ and never valid C.
 */
function looksLikeCpp(source: string): boolean {
  const sample = source.substring(0, 8192);
  return /\bnamespace\b|\bclass\s+\w+\s*[:{]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=)/.test(sample);
}
