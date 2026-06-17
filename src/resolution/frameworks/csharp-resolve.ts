/**
 * C# (ASP.NET) route extraction + name-resolution helpers split out of
 * csharp.ts to keep it within the 200-line limit. No behavior change.
 */

import { Node } from '../../types';
import { UnresolvedRef, ResolutionContext, FrameworkExtractionResult } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export function extractAspnetRoutes(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
    if (!filePath.endsWith('.cs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'csharp');

    // [HttpGet("path")], [HttpPost("path")], etc.
    const attrRegex = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\s*\(\s*"([^"]+)"\s*\)\]/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(safe)) !== null) {
      const [, verb, routePath] = match;
      const method = verb!.replace(/^Http/, '').toUpperCase();
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'csharp',
        updatedAt: now,
      };
      nodes.push(routeNode);

      // Capture the next method declaration
      const tail = safe.slice(match.index + match[0].length);
      const methodMatch = tail.match(/(?:public|private|protected|internal)\s+[\w<>,\s\[\]]+?\s+(\w+)\s*\(/);
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: methodMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    // Minimal APIs: app.MapGet("/path", handler)
    const minimalRegex = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*,\s*([^,)]+)/g;
    while ((match = minimalRegex.exec(safe)) !== null) {
      const [, verb, routePath, handlerExpr] = match;
      const method = verb!.toUpperCase();
      const line = safe.slice(0, match.index).split('\n').length;

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'csharp',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractCSharpTailIdent(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'csharp',
        });
      }
    }

    return { nodes, references };
}

/** Extract last identifier from an expression like `MyService.Handler` or `Handler`. */
export function extractCSharpTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

// Directory patterns
export const CONTROLLER_DIRS = ['/Controllers/'];
export const SERVICE_DIRS = ['/Services/', '/Service/', '/Application/'];
export const REPO_DIRS = ['/Repositories/', '/Repository/', '/Data/', '/Infrastructure/'];
export const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Entity/', '/Domain/'];
export const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/DTOs/', '/Dto/'];

export const CLASS_KINDS = new Set(['class']);
export const SERVICE_KINDS = new Set(['class', 'interface']);

/**
 * Resolve a symbol by name using indexed queries instead of scanning all files.
 */
export function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.filePath.includes(d))
  );

  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
