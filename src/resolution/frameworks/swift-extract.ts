/**
 * Swift (SwiftUI/UIKit/Vapor) route extraction split out of swift.ts to keep
 * it within the 200-line limit. No behavior change.
 */

import { Node } from '../../types';
import { FrameworkExtractionResult, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export function extractSwiftUIRoutes(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // Extract SwiftUI View structs
    // struct ContentView: View { ... }
    const viewPattern = /struct\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*View/g;

    let match: RegExpExecArray | null;
    while ((match = viewPattern.exec(safe)) !== null) {
      const [, viewName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `view:${filePath}:${viewName}:${line}`,
        kind: 'component',
        name: viewName!,
        qualifiedName: `${filePath}::${viewName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    // Extract @main App entry point
    const appPattern = /@main\s+struct\s+(\w+)\s*:\s*App/g;

    while ((match = appPattern.exec(safe)) !== null) {
      const [, appName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `app:${filePath}:${appName}:${line}`,
        kind: 'class',
        name: appName!,
        qualifiedName: `${filePath}::${appName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return { nodes, references: [] };
}

export function extractUIKitRoutes(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // Extract UIViewController subclasses
    const vcPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIViewController/g;

    let match: RegExpExecArray | null;
    while ((match = vcPattern.exec(safe)) !== null) {
      const [, vcName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `viewcontroller:${filePath}:${vcName}:${line}`,
        kind: 'class',
        name: vcName!,
        qualifiedName: `${filePath}::${vcName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    // Extract UIView subclasses
    const viewPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIView[^C]/g;

    while ((match = viewPattern.exec(safe)) !== null) {
      const [, viewName] = match;
      const line = safe.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `uiview:${filePath}:${viewName}:${line}`,
        kind: 'class',
        name: viewName!,
        qualifiedName: `${filePath}::${viewName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return { nodes, references: [] };
}

export function extractVaporRoutes(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'swift');

    // Vapor: (app|router|routes).METHOD("path", use: handler)
    const routeRegex = /\b(?:app|router|routes)\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*,\s*use:\s*([A-Za-z_][A-Za-z0-9_.]*)/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const upper = method!.toUpperCase();

      const routeNode: Node = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      };
      nodes.push(routeNode);

      // Last segment of dotted path (e.g. UserController.list -> list)
      const parts = handlerExpr!.split('.');
      const handlerName = parts[parts.length - 1];
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'swift',
        });
      }
    }

    return { nodes, references };
}
