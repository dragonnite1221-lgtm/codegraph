/**
 * Per-reference matching: name pre-filtering, import escape, and the
 * strategy cascade (framework → import → name match). Split out of index.ts to
 * stay within the file-size gate.
 */

import {
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
  FrameworkResolver,
} from './types';
import { matchReference } from './name-matcher';
import { resolveViaImport } from './import-resolver';
import { isBuiltInOrExternal } from './builtin-symbols';

/**
 * Check if a reference name has any possible match in the codebase. Uses the
 * pre-built knownNames set to skip expensive resolution for names that
 * definitely don't exist as symbols.
 */
export function hasAnyPossibleMatch(knownNames: Set<string> | null, name: string): boolean {
  if (!knownNames) return true; // no pre-filter available

  // Direct name match
  if (knownNames.has(name)) return true;

  // For qualified names like "obj.method" or "Class::method", check the parts
  const dotIdx = name.indexOf('.');
  if (dotIdx > 0) {
    const receiver = name.substring(0, dotIdx);
    const member = name.substring(dotIdx + 1);
    if (knownNames.has(receiver) || knownNames.has(member)) return true;
    // Also check capitalized receiver (instance-method resolution)
    const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1);
    if (knownNames.has(capitalized)) return true;
  }
  const colonIdx = name.indexOf('::');
  if (colonIdx > 0) {
    const receiver = name.substring(0, colonIdx);
    const member = name.substring(colonIdx + 2);
    if (knownNames.has(receiver) || knownNames.has(member)) return true;
  }

  // For path-like references (e.g., "snippets/drawer-menu.liquid"), check the filename
  const slashIdx = name.lastIndexOf('/');
  if (slashIdx > 0) {
    const fileName = name.substring(slashIdx + 1);
    if (knownNames.has(fileName)) return true;
  }

  return false;
}

/**
 * Does `ref.referenceName` match an import declared in its containing file?
 * Used as a pre-filter escape so re-export chain resolution still gets a chance
 * when the name has no project-wide declaration.
 */
export function matchesAnyImport(context: ResolutionContext, ref: UnresolvedRef): boolean {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  if (imports.length === 0) return false;
  for (const imp of imports) {
    if (
      imp.localName === ref.referenceName ||
      ref.referenceName.startsWith(imp.localName + '.')
    ) {
      return true;
    }
  }
  return false;
}

export interface ResolveOneDeps {
  knownNames: Set<string> | null;
  frameworks: FrameworkResolver[];
  context: ResolutionContext;
}

/** Resolve a single reference via the framework → import → name-match cascade. */
export function resolveOne(deps: ResolveOneDeps, ref: UnresolvedRef): ResolvedRef | null {
  const { knownNames, frameworks, context } = deps;

  // Skip built-in/external references
  if (isBuiltInOrExternal(ref, knownNames)) {
    return null;
  }

  // Fast pre-filter: skip if no symbol with this name exists anywhere
  // AND the name doesn't match a local import. The import escape is
  // necessary because re-export rename chains (`import { login }
  // from './barrel'` where the barrel has `export { signIn as login }
  // from './auth'`) intentionally call a name that has no
  // declaration anywhere — only the renamed upstream symbol does.
  if (!hasAnyPossibleMatch(knownNames, ref.referenceName) && !matchesAnyImport(context, ref)) {
    return null;
  }

  const candidates: ResolvedRef[] = [];

  // Strategy 1: Try framework-specific resolution
  for (const framework of frameworks) {
    const result = framework.resolve(ref, context);
    if (result) {
      if (result.confidence >= 0.9) return result; // High confidence, return immediately
      candidates.push(result);
    }
  }

  // Strategy 2: Try import-based resolution
  const importResult = resolveViaImport(ref, context);
  if (importResult) {
    if (importResult.confidence >= 0.9) return importResult;
    candidates.push(importResult);
  }

  // Strategy 3: Try name matching
  const nameResult = matchReference(ref, context);
  if (nameResult) {
    candidates.push(nameResult);
  }

  if (candidates.length === 0) return null;

  // Return highest confidence candidate
  return candidates.reduce((best, curr) =>
    curr.confidence > best.confidence ? curr : best
  );
}
