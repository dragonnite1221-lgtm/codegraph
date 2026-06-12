import type { Node, SearchResult } from '../types';

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

type SearchableGraph = {
  searchNodes(query: string, options: { limit: number }): SearchResult[];
};

export type SymbolMatch = {
  node: Node;
  note: string;
};

export type SymbolMatches = {
  nodes: Node[];
  note: string;
};

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
export function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Check if a node matches a symbol query.
 *
 * Accepts simple names (`run`) and three flavors of qualifier:
 *   - dotted     `Session.request`         (TS/JS/Python)
 *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
 *   - slash      `configurator/stage_apply` (path-ish)
 *
 * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
 * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
 * the canonical `crate::module::symbol` form resolves.
 *
 * Resolution order, last part must always equal `node.name`:
 *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
 *      where the extractor builds the qualified name from the AST stack)
 *   2. File-path containment (handles file-derived modules in Rust/
 *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  if (node.name === symbol) return true;
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  if (!/[.\/]|::/.test(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  const colonSuffix = parts.join('::');
  if (node.qualifiedName.includes(colonSuffix)) return true;

  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

export function findSymbol(cg: SearchableGraph, symbol: string): SymbolMatch | null {
  const isQualified = /[.\/]|::/.test(symbol);
  const limit = isQualified ? 50 : 10;
  let results = cg.searchNodes(symbol, { limit });

  if (isQualified && results.length === 0) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
  }

  if (results.length === 0 || !results[0]) {
    return null;
  }

  const exactMatches = results.filter(r => matchesSymbol(r.node, symbol));

  if (exactMatches.length === 1) {
    return { node: exactMatches[0]!.node, note: '' };
  }

  if (exactMatches.length > 1) {
    const picked = exactMatches[0]!.node;
    const others = exactMatches.slice(1).map(r =>
      `${r.node.name} (${r.node.kind}) at ${r.node.filePath}:${r.node.startLine}`
    );
    const note = `\n\n> **Note:** ${exactMatches.length} symbols named "${symbol}". Showing results for \`${picked.filePath}:${picked.startLine}\`. Others: ${others.join(', ')}`;
    return { node: picked, note };
  }

  if (isQualified) return null;
  return { node: results[0]!.node, note: '' };
}

/**
 * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
 * results across all matching symbols (e.g., multiple classes with an `execute` method).
 */
export function findAllSymbols(cg: SearchableGraph, symbol: string): SymbolMatches {
  const isQualified = /[.\/]|::/.test(symbol);
  let results = cg.searchNodes(symbol, { limit: 50 });

  if (results.length === 0 && isQualified) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }

  if (results.length === 0) {
    return { nodes: [], note: '' };
  }

  const exactMatches = results.filter(r => matchesSymbol(r.node, symbol));

  if (isQualified && exactMatches.length === 0) {
    return { nodes: [], note: '' };
  }

  if (exactMatches.length <= 1) {
    const node = exactMatches[0]?.node ?? results[0]!.node;
    return { nodes: [node], note: '' };
  }

  const locations = exactMatches.map(r =>
    `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`
  );
  const note = `\n\n> **Note:** Aggregated results across ${exactMatches.length} symbols named "${symbol}": ${locations.join(', ')}`;
  return { nodes: exactMatches.map(r => r.node), note };
}
