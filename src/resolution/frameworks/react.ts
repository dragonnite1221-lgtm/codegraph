/**
 * React Framework Resolver
 *
 * Handles React and Next.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import {
  isPascalCase,
  isBuiltInType,
  resolveComponent,
  resolveHook,
  resolveContext,
  filePathToRoute,
} from './react-resolve';

export const reactResolver: FrameworkResolver = {
  name: 'react',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // Check for React in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next || deps['react-native']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Component references (PascalCase)
    if (isPascalCase(ref.referenceName) && !isBuiltInType(ref.referenceName)) {
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Hook references (use*)
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = resolveHook(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Context references
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = resolveContext(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract component definitions
    // function Component() or const Component = () =>
    const componentPatterns = [
      // Function components
      /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
      // Arrow function components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
      // forwardRef components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
      // memo components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
    ];

    for (const pattern of componentPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, name] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Check if it returns JSX (rough heuristic)
        const afterMatch = content.slice(match.index + fullMatch.length, match.index + fullMatch.length + 500);
        const hasJSX = afterMatch.includes('<') && (afterMatch.includes('/>') || afterMatch.includes('</'));

        if (hasJSX) {
          nodes.push({
            id: `component:${filePath}:${name}:${line}`,
            kind: 'component',
            name: name!,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: fullMatch.length,
            language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
            isExported: fullMatch.includes('export'),
            updatedAt: now,
          });
        }
      }
    }

    // Extract custom hooks
    const hookPattern = /(?:export\s+)?(?:function|const|let)\s+(use[A-Z][a-zA-Z0-9]*)\s*[=(]/g;
    let hookMatch;
    while ((hookMatch = hookPattern.exec(content)) !== null) {
      const [fullMatch, name] = hookMatch;
      const line = content.slice(0, hookMatch.index).split('\n').length;

      nodes.push({
        id: `hook:${filePath}:${name}:${line}`,
        kind: 'function',
        name: name!,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: fullMatch.length,
        language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
        isExported: fullMatch.includes('export'),
        updatedAt: now,
      });
    }

    // Extract Next.js pages/routes (pages directory convention)
    if (filePath.includes('pages/') || filePath.includes('app/')) {
      // Default export in pages becomes a route
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath);
        if (routePath) {
          const line = content.indexOf('export default');
          const lineNum = content.slice(0, line).split('\n').length;

          nodes.push({
            id: `route:${filePath}:${routePath}:${lineNum}`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${filePath}::route:${routePath}`,
            filePath,
            startLine: lineNum,
            endLine: lineNum,
            startColumn: 0,
            endColumn: 0,
            language: filePath.endsWith('.tsx') ? 'tsx' : filePath.endsWith('.ts') ? 'typescript' : 'javascript',
            updatedAt: now,
          });
        }
      }
    }

    return { nodes, references: [] };
  },
};

