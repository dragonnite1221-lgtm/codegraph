/**
 * Cross-file incoming-edge replay for a reindexed file. Split out of
 * result-storage.ts to stay within the file-size gate.
 */
import type { Edge, Node } from '../types';

export interface EdgeReplayQueries {
  getNodesByFile(filePath: string): Node[];
  getIncomingEdgesForTargets(targetIds: string[]): Edge[];
}

/**
 * Whether a surviving node is still a plausible target for a cross-file
 * edge, given what the fresh extraction says about it now:
 *
 * - `file` nodes have no "exported" concept at all -- extractors always
 *   stamp them `isExported: false` (see tree-sitter-extract.ts) even though
 *   they're the standard target of `imports` edges. Always preservable.
 * - `isExported` is populated by a per-language extractor hook that only a
 *   subset of languages (JS/TS and friends) implement; `false` there is a
 *   real, deliberate "no longer exported" signal.
 * - Languages that track access via `visibility` instead (Java, C#, Rust,
 *   Kotlin, Swift, ...) never set `isExported`, so `false` alone would miss
 *   a public-to-private change there. Explicit `visibility === 'private'`
 *   is the other disqualifying signal.
 * - Anything else (`isExported` true/undefined, `visibility` public/
 *   protected/internal/undefined) is treated as still reachable -- this is
 *   a filter for the common, clear-cut disqualifying cases, not a full
 *   language-aware access-control model.
 *
 * ponytail: this is node-local, not ancestor-aware. A method never gets its
 * own `isExported` (only extractFunction sets it; extractMethod doesn't --
 * see extractors-callable.ts), so `export class Foo { m() {} }` losing its
 * `export` doesn't disqualify calls into `Foo.m` even though `Foo` itself
 * now correctly reports isExported: false. Likewise Java/Kotlin/etc.
 * package-private (no modifier) is indistinguishable from "visibility not
 * tracked" here, since both are `undefined`. Closing this needs the same
 * containment-chain + language-aware access-control modeling the resolution
 * engine itself doesn't have either (its own isExported use, in
 * name-match-helpers.ts, is a scoring bonus, not a hard reachability
 * check) -- out of scope for this fix. The failure direction here is
 * "preserves an edge that's no longer valid" (stale-but-harmless), not
 * "drops a valid one" (the bug this file exists to fix), so it's a
 * narrower miss than the pre-fix behavior of replaying unconditionally.
 *
 * The reverse also isn't universal: `visibility === 'private'` doesn't mean
 * "unreachable from every other file" in every language (a Rust child
 * module can call a `private` item in its parent; C# labels unqualified
 * top-level types `private` even though they're assembly-internal). Treating
 * `private` as disqualifying is a deliberate simplification for the common
 * case (most languages' `private` genuinely blocks cross-file access), not a
 * scope-aware access-control model -- the same limitation as above, just in
 * the other direction (a small false-positive rate here means occasionally
 * dropping an edge that a full scope model would have kept, which is exactly
 * the class of bug this file exists to prevent; but it's bounded to the
 * narrow `private`-across-module-boundary carve-outs a few languages allow,
 * not the general case).
 */
export function isStillReferenceable(node: Node): boolean {
  if (node.kind === 'file') return true;
  if (node.isExported === false) return false;
  if (node.visibility === 'private') return false;
  return true;
}

/** `kind|qualifiedName` — an identity that, unlike `id`, doesn't change when
 * a declaration's line shifts (e.g. adding an import above it). */
function stableKey(node: Node): string {
  return `${node.kind}|${node.qualifiedName}`;
}

/**
 * Index `nodes` by stableKey(), keeping only keys that identify exactly one
 * node. A qualifiedName shared by more than one node in the same set (e.g.
 * overloads a language's extractor can't tell apart by qualifiedName alone)
 * is ambiguous for remapping purposes — drop it rather than guess.
 */
export function indexByUniqueStableKey(nodes: Node[]): Map<string, Node> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = stableKey(node);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const index = new Map<string, Node>();
  for (const node of nodes) {
    const key = stableKey(node);
    if (counts.get(key) === 1) index.set(key, node);
  }
  return index;
}

/**
 * `deleteFile` cascades to every edge touching this file's old nodes,
 * including edges from OTHER files that call/reference into it (edges.target
 * has ON DELETE CASCADE too). Re-extracting this file only recreates edges
 * whose both ends are in the fresh result, so a caller in an untouched file
 * loses its edge into this one on every reindex of the callee.
 *
 * Capture those incoming cross-file edges before the delete, and replay the
 * ones whose target symbol survives into the fresh extraction AND is still a
 * valid reference target there (see isStillReferenceable()). "Survives" is
 * checked two ways:
 *  - same `id` (a hash of file+kind+name+declaration line) — the common
 *    case, a body-only edit that doesn't move the declaration's line.
 *  - same `stableKey()` (kind + qualifiedName, which excludes the line) when
 *    the id changed — e.g. an added import/comment shifted the declaration
 *    down a line. The edge is replayed with its target rewritten to the new
 *    id, since the old one no longer exists after deleteFile().
 * An actual rename/removal matches neither and is correctly dropped.
 */
export function findPreservableIncomingEdges(
  queries: EdgeReplayQueries,
  filePath: string,
  survivingNodes: Map<string, Node>,
  survivingByStableKey: Map<string, Node>
): Edge[] {
  const oldNodes = queries.getNodesByFile(filePath);
  const oldNodeIds = new Set(oldNodes.map((node) => node.id));
  const oldByStableKey = indexByUniqueStableKey(oldNodes);

  // old id -> the node that now represents it (same id, or a stableKey
  // match after a line shift), for old nodes that are still referenceable.
  const remapped = new Map<string, Node>();
  for (const oldNode of oldNodes) {
    // id hashes file+kind+simple-name+line -- it does NOT include ancestor
    // names, so renaming an enclosing container (class A -> B) leaves a
    // method's id unchanged while its qualifiedName (A::m -> B::m) changes.
    // Require both to agree before trusting the id match; otherwise fall
    // through to the stableKey path, which correctly won't match either
    // (the qualifiedName really did change) and the edge is dropped like
    // any other genuine identity change.
    const byId = survivingNodes.get(oldNode.id);
    const exact = byId && byId.qualifiedName === oldNode.qualifiedName ? byId : undefined;
    const survivor =
      exact ??
      (oldByStableKey.get(stableKey(oldNode)) === oldNode
        ? survivingByStableKey.get(stableKey(oldNode))
        : undefined);
    if (survivor && isStillReferenceable(survivor)) {
      remapped.set(oldNode.id, survivor);
    }
  }

  const preserved: Edge[] = [];
  const seen = new Set<string>();

  for (const edge of queries.getIncomingEdgesForTargets([...remapped.keys()])) {
    if (oldNodeIds.has(edge.source)) continue; // same-file edge — the fresh extraction recreates it
    const survivor = remapped.get(edge.target);
    if (!survivor) continue; // getIncomingEdgesForTargets can return edges for other targets too
    const rewritten = survivor.id === edge.target ? edge : { ...edge, target: survivor.id };
    const key = [
      rewritten.source,
      rewritten.target,
      rewritten.kind,
      rewritten.line ?? '',
      rewritten.column ?? '',
      rewritten.provenance ?? '',
      JSON.stringify(rewritten.metadata ?? null),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    preserved.push(rewritten);
  }

  return preserved;
}
