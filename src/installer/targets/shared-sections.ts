/**
 * Marker-delimited section helpers for markdown-ish instruction files
 * (`<!-- CODEGRAPH_START --> ... <!-- CODEGRAPH_END -->`). Split out of
 * shared.ts to stay within the file-size gate; re-exported from shared.ts.
 */

import * as fs from 'fs';
import { atomicWriteFileSync } from './shared';

/**
 * Replace or append a marker-delimited section in a markdown-ish file.
 *
 * Used by Claude / Codex for the `<!-- CODEGRAPH_START --> ... <!--
 * CODEGRAPH_END -->` block. Preserves all content outside the
 * markers verbatim.
 *
 * Returns `created` when the file didn't exist; `updated` when
 * markers were found and content swapped; `appended` when markers
 * weren't found and section was added at end. `unchanged` when the
 * existing block already matches `body`.
 */
export function replaceOrAppendMarkedSection(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'appended' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    atomicWriteFileSync(filePath, body + '\n');
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx > startIdx) {
    const existingBlock = content.substring(startIdx, endIdx + endMarker.length);
    if (existingBlock === body) {
      return 'unchanged';
    }
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    atomicWriteFileSync(filePath, before + body + after);
    return 'updated';
  }

  // No markers — append. Preserve existing content with a separating
  // blank line.
  const trimmed = content.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  atomicWriteFileSync(filePath, trimmed + sep + body + '\n');
  return 'appended';
}

/**
 * Inverse of `replaceOrAppendMarkedSection`. Strips the marker
 * block from `filePath` if present. If the file becomes empty after
 * removal, deletes the file entirely (matches the existing Claude
 * uninstall behavior).
 *
 * Returns `removed` when content was stripped, `not-found` when
 * the markers weren't present, `kept` when the file didn't exist.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'not-found' | 'kept' {
  if (!fs.existsSync(filePath)) return 'kept';

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'kept';
  }

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx <= startIdx) return 'not-found';

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + endMarker.length).trimStart();
  const joined = before + (before && after ? '\n\n' : '') + after;

  if (joined.trim() === '') {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    atomicWriteFileSync(filePath, joined.trim() + '\n');
  }
  return 'removed';
}
