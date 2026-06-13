/**
 * Parse-result predicates
 *
 * Small shared helpers for deciding what to do with an ExtractionResult,
 * used by both the bulk index loop and the WASM-failure retry pass.
 */

import type { ExtractionResult } from '../types';

export function shouldStoreParseResult(result: ExtractionResult): boolean {
  return result.nodes.length > 0 || result.errors.length === 0;
}

export function hasFatalExtractionError(result: ExtractionResult): boolean {
  return result.errors.some((error) => error.severity === 'error');
}
