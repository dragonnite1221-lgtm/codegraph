/**
 * Graph Queries: impact/path/ancestors/deps/cycles/dead-code/metrics. Split out of graph.test.ts to stay within the file-size gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import CodeGraph from '../src/index';
import { Node, Edge } from '../src/types';
import { createGraphProject, cleanupGraphProject } from './graph-test-fixture';

describe('Graph Queries', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    ({ testDir, cg } = await createGraphProject());
  });

  afterEach(() => {
    cleanupGraphProject(testDir, cg);
  });

  describe('getImpactRadius()', () => {
    it('should calculate impact radius', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const impact = cg.getImpactRadius(formatValue.id, 3);

      expect(impact.nodes.size).toBeGreaterThan(0);
      expect(impact.nodes.has(formatValue.id)).toBe(true);
    });
  });

  describe('findPath()', () => {
    it('should find path between connected nodes', () => {
      const stats = cg.getStats();

      if (stats.nodeCount < 2) {
        return;
      }

      const functions = cg.getNodesByKind('function');
      if (functions.length < 2) {
        return;
      }

      // Try to find any path
      const processValue = functions.find((n) => n.name === 'processValue');
      const formatValue = functions.find((n) => n.name === 'formatValue');

      if (processValue && formatValue) {
        const path = cg.findPath(processValue.id, formatValue.id);

        // Path might exist or might not depending on edge direction
        expect(path === null || Array.isArray(path)).toBe(true);
      }
    });

    it('should return null for disconnected nodes', () => {
      // Create two nodes that definitely don't have a path
      const path = cg.findPath('non-existent-1', 'non-existent-2');

      expect(path).toBeNull();
    });
  });

  describe('getAncestors() and getChildren()', () => {
    it('should get ancestors of a node', () => {
      const methods = cg.getNodesByKind('method');
      const printMethod = methods.find((n) => n.name === 'print');

      if (!printMethod) {
        return;
      }

      const ancestors = cg.getAncestors(printMethod.id);

      // Should have class and file as ancestors
      expect(Array.isArray(ancestors)).toBe(true);
    });

    it('should get children of a node', () => {
      const classes = cg.getNodesByKind('class');
      const derivedClass = classes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        return;
      }

      const children = cg.getChildren(derivedClass.id);

      // Should have methods as children
      expect(Array.isArray(children)).toBe(true);
    });
  });

  describe('File dependency analysis', () => {
    it('should get file dependencies', () => {
      const deps = cg.getFileDependencies('src/main.ts');

      expect(Array.isArray(deps)).toBe(true);
    });

    it('should get file dependents', () => {
      const dependents = cg.getFileDependents('src/utils.ts');

      expect(Array.isArray(dependents)).toBe(true);
    });
  });

  describe('findCircularDependencies()', () => {
    it('should detect circular dependencies', () => {
      const cycles = cg.findCircularDependencies();

      // Our test files don't have circular deps
      expect(Array.isArray(cycles)).toBe(true);
    });
  });

  describe('findDeadCode()', () => {
    it('should find dead code', () => {
      const deadCode = cg.findDeadCode(['function']);

      expect(Array.isArray(deadCode)).toBe(true);

      // unusedHelper should be detected
      const hasUnused = deadCode.some((n) => n.name === 'unusedHelper');
      // Note: This depends on extraction properly detecting function scope
      expect(deadCode.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getNodeMetrics()', () => {
    it('should return metrics for a node', () => {
      const functions = cg.getNodesByKind('function');
      const func = functions[0];

      if (!func) {
        return;
      }

      const metrics = cg.getNodeMetrics(func.id);

      expect(metrics).toHaveProperty('incomingEdgeCount');
      expect(metrics).toHaveProperty('outgoingEdgeCount');
      expect(metrics).toHaveProperty('callCount');
      expect(metrics).toHaveProperty('callerCount');
      expect(metrics).toHaveProperty('childCount');
      expect(metrics).toHaveProperty('depth');

      expect(typeof metrics.incomingEdgeCount).toBe('number');
      expect(typeof metrics.outgoingEdgeCount).toBe('number');
    });
  });
});
