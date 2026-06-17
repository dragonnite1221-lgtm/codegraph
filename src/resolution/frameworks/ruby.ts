/**
 * Ruby Framework Resolver
 *
 * Handles Ruby on Rails patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import {
  resolveModel,
  resolveController,
  resolveHelper,
  resolveService,
} from './ruby-resolve';

export const railsResolver: FrameworkResolver = {
  name: 'rails',
  languages: ['ruby'],

  detect(context: ResolutionContext): boolean {
    // Check for Gemfile with rails
    const gemfile = context.readFile('Gemfile');
    if (gemfile && gemfile.includes("'rails'")) {
      return true;
    }

    // Check for config/application.rb (Rails signature)
    if (context.fileExists('config/application.rb')) {
      return true;
    }

    // Check for typical Rails directory structure
    return (
      context.fileExists('app/controllers/application_controller.rb') ||
      context.fileExists('config/routes.rb')
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Model references (ActiveRecord)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveController(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Helper references
    if (ref.referenceName.endsWith('Helper')) {
      const result = resolveHelper(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Service/Job references
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Job')) {
      const result = resolveService(ref.referenceName, context);
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
    if (!filePath.endsWith('.rb')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'ruby');

    // get/post/put/patch/delete/match '/path', to: 'controller#action'
    // Also: get '/path' => 'controller#action'
    const routeRegex = /\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*|=>\s*)['"]([^#'"]+)#([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, _controller, action] = match;
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
        language: 'ruby',
        updatedAt: now,
      };
      nodes.push(routeNode);

      references.push({
        fromNodeId: routeNode.id,
        referenceName: action!,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'ruby',
      });
    }

    return { nodes, references };
  },
};
