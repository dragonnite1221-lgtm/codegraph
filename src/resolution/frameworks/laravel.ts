/**
 * Laravel Framework Resolver
 *
 * Handles Laravel-specific patterns for reference resolution.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';
import {
  extractLaravelHandler,
  resolveModelCall,
  resolveControllerMethod,
} from './laravel-resolve';

/**
 * Laravel facade mappings to underlying classes
 * Exported for potential use in facade resolution
 */
export const FACADE_MAPPINGS: Record<string, string> = {
  Auth: 'Illuminate\\Auth\\AuthManager',
  Cache: 'Illuminate\\Cache\\CacheManager',
  Config: 'Illuminate\\Config\\Repository',
  DB: 'Illuminate\\Database\\DatabaseManager',
  Event: 'Illuminate\\Events\\Dispatcher',
  File: 'Illuminate\\Filesystem\\Filesystem',
  Gate: 'Illuminate\\Auth\\Access\\Gate',
  Hash: 'Illuminate\\Hashing\\HashManager',
  Log: 'Illuminate\\Log\\LogManager',
  Mail: 'Illuminate\\Mail\\Mailer',
  Queue: 'Illuminate\\Queue\\QueueManager',
  Redis: 'Illuminate\\Redis\\RedisManager',
  Request: 'Illuminate\\Http\\Request',
  Response: 'Illuminate\\Http\\Response',
  Route: 'Illuminate\\Routing\\Router',
  Session: 'Illuminate\\Session\\SessionManager',
  Storage: 'Illuminate\\Filesystem\\FilesystemManager',
  URL: 'Illuminate\\Routing\\UrlGenerator',
  Validator: 'Illuminate\\Validation\\Factory',
  View: 'Illuminate\\View\\Factory',
};

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    // Check for artisan file (Laravel signature)
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Model::method() - Eloquent static calls
    const modelMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+)::(\w+)$/);
    if (modelMatch) {
      const [, className, methodName] = modelMatch;
      const result = resolveModelCall(className!, methodName!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Facade calls - Auth::user(), Cache::get()
    const facadeMatch = ref.referenceName.match(/^(Auth|Cache|DB|Log|Mail|Queue|Session|Storage|Validator|Route|Request|Response)::(\w+)$/);
    if (facadeMatch) {
      // Facades typically resolve to external Laravel code
      // Mark as external but note the facade
      return null; // External, can't resolve to local node
    }

    // Pattern 3: Helper function calls - route(), view(), config()
    if (['route', 'view', 'config', 'env', 'app', 'abort', 'redirect', 'response', 'request', 'session', 'url', 'asset', 'mix'].includes(ref.referenceName)) {
      // These are Laravel helpers - external
      return null;
    }

    // Pattern 4: Controller method references
    const controllerMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+Controller)@(\w+)$/);
    if (controllerMatch) {
      const [, controller, method] = controllerMatch;
      const result = resolveControllerMethod(controller!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.php')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'php');

    // Route::METHOD('/path', handler-expr)
    // handler-expr can be: [Class::class, 'method'] | 'Controller@method' | Closure | Class::class
    const routeRegex = /Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
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
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      const handlerName = extractLaravelHandler(handlerExpr!);
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'php',
        });
      }
    }

    // Route::resource('name', Controller::class) / Route::apiResource('name', Controller::class)
    const resourceRegex = /Route::(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\)/g;
    while ((match = resourceRegex.exec(safe)) !== null) {
      const [, _fn, resourceName, handlerExpr] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:RESOURCE:${resourceName}`,
        kind: 'route',
        name: `resource:${resourceName}`,
        qualifiedName: `${filePath}::route:${resourceName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'php',
        updatedAt: now,
      };
      nodes.push(routeNode);

      if (handlerExpr) {
        const controllerName = extractLaravelHandler(handlerExpr);
        if (controllerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: controllerName,
            referenceKind: 'imports',
            line,
            column: 0,
            filePath,
            language: 'php',
          });
        }
      }
    }

    return { nodes, references };
  },
};

