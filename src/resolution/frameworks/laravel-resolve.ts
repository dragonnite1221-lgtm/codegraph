/**
 * Laravel resolver helpers split out of laravel.ts to keep it within the
 * 200-line limit. Pure helpers — no behavior change.
 */

import { ResolutionContext } from '../types';

/**
 * Parse a Laravel route handler expression and return the symbol to link.
 *  - `[Class::class, 'method']`  -> `method`
 *  - `'Controller@method'`       -> `method`
 *  - `Class::class`              -> `Class`
 *  - anything else (closure etc) -> null
 */
export function extractLaravelHandler(expr: string): string | null {
  const trimmed = expr.trim();

  // [Class::class, 'method'] — grab the string literal
  const tupleMatch = trimmed.match(/^\[\s*[^,]+,\s*['"]([^'"]+)['"]\s*\]/);
  if (tupleMatch) return tupleMatch[1]!;

  // 'Controller@method'
  const atMatch = trimmed.match(/^['"]([^'"@]+)@([^'"]+)['"]$/);
  if (atMatch) return atMatch[2]!;

  // Controller::class
  const classMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)::class/);
  if (classMatch) return classMatch[1]!;

  return null;
}

/**
 * Resolve a Model::method() call
 */
export function resolveModelCall(
  className: string,
  methodName: string,
  context: ResolutionContext
): string | null {
  // Try app/Models/ first (Laravel 8+)
  let modelPath = `app/Models/${className}.php`;
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath);
    // Look for the method in this class
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) {
      return methodNode.id;
    }
    // Return the class itself if method not found
    const classNode = nodes.find(
      (n) => n.kind === 'class' && n.name === className
    );
    if (classNode) {
      return classNode.id;
    }
  }

  // Try app/ (Laravel 7 and below)
  modelPath = `app/${className}.php`;
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath);
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === methodName
    );
    if (methodNode) {
      return methodNode.id;
    }
    const classNode = nodes.find(
      (n) => n.kind === 'class' && n.name === className
    );
    if (classNode) {
      return classNode.id;
    }
  }

  return null;
}

/**
 * Resolve a Controller@method reference
 */
export function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  // Try app/Http/Controllers/
  const controllerPath = `app/Http/Controllers/${controller}.php`;
  if (context.fileExists(controllerPath)) {
    const nodes = context.getNodesInFile(controllerPath);
    const methodNode = nodes.find(
      (n) => n.kind === 'method' && n.name === method
    );
    if (methodNode) {
      return methodNode.id;
    }
  }

  // Try name-based lookup for namespaced controllers
  const controllerCandidates = context.getNodesByName(controller);
  for (const ctrl of controllerCandidates) {
    if (ctrl.kind === 'class' && ctrl.filePath.includes('Controllers')) {
      const nodesInFile = context.getNodesInFile(ctrl.filePath);
      const methodNode = nodesInFile.find(
        (n) => n.kind === 'method' && n.name === method
      );
      if (methodNode) {
        return methodNode.id;
      }
    }
  }

  return null;
}
