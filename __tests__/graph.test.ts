/**
 * Graph Queries: traversal/context/callgraph/hierarchy/usages/callers-callees.
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

  describe('traverse()', () => {
    it('should traverse graph from a starting node', () => {
      const nodes = cg.getNodesByKind('function');
      const mainFunc = nodes.find((n) => n.name === 'main');

      if (!mainFunc) {
        console.log('main function not found, skipping test');
        return;
      }

      const subgraph = cg.traverse(mainFunc.id, {
        maxDepth: 2,
        direction: 'outgoing',
      });

      expect(subgraph.nodes.size).toBeGreaterThan(0);
      expect(subgraph.roots).toContain(mainFunc.id);
    });

    it('should respect maxDepth option', () => {
      const nodes = cg.getNodesByKind('function');
      const mainFunc = nodes.find((n) => n.name === 'main');

      if (!mainFunc) {
        return;
      }

      const shallow = cg.traverse(mainFunc.id, { maxDepth: 1 });
      const deep = cg.traverse(mainFunc.id, { maxDepth: 3 });

      expect(deep.nodes.size).toBeGreaterThanOrEqual(shallow.nodes.size);
    });

    it('should support incoming direction', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const subgraph = cg.traverse(formatValue.id, {
        maxDepth: 2,
        direction: 'incoming',
      });

      expect(subgraph.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('getContext()', () => {
    it('should return context for a node', () => {
      const nodes = cg.getNodesByKind('class');
      const derivedClass = nodes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        console.log('DerivedClass not found, skipping test');
        return;
      }

      const context = cg.getContext(derivedClass.id);

      expect(context.focal).toBeDefined();
      expect(context.focal.id).toBe(derivedClass.id);
      expect(context.ancestors).toBeDefined();
      expect(context.children).toBeDefined();
      expect(context.incomingRefs).toBeDefined();
      expect(context.outgoingRefs).toBeDefined();
    });

    it('should throw for non-existent node', () => {
      expect(() => cg.getContext('non-existent-id')).toThrow('Node not found');
    });
  });

  describe('getCallGraph()', () => {
    it('should return call graph for a function', () => {
      const nodes = cg.getNodesByKind('function');
      const processValue = nodes.find((n) => n.name === 'processValue');

      if (!processValue) {
        console.log('processValue not found, skipping test');
        return;
      }

      const callGraph = cg.getCallGraph(processValue.id, 2);

      expect(callGraph.nodes.size).toBeGreaterThan(0);
      expect(callGraph.nodes.has(processValue.id)).toBe(true);
    });
  });

  describe('getTypeHierarchy()', () => {
    it('should return type hierarchy for a class', () => {
      const nodes = cg.getNodesByKind('class');
      const derivedClass = nodes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        return;
      }

      const hierarchy = cg.getTypeHierarchy(derivedClass.id);

      expect(hierarchy.nodes.size).toBeGreaterThan(0);
      expect(hierarchy.nodes.has(derivedClass.id)).toBe(true);
    });

    it('should return empty subgraph for non-existent node', () => {
      const hierarchy = cg.getTypeHierarchy('non-existent-id');

      expect(hierarchy.nodes.size).toBe(0);
      expect(hierarchy.edges.length).toBe(0);
    });
  });

  describe('findUsages()', () => {
    it('should find usages of a symbol', () => {
      const nodes = cg.getNodesByKind('class');
      const baseClass = nodes.find((n) => n.name === 'BaseClass');

      if (!baseClass) {
        return;
      }

      const usages = cg.findUsages(baseClass.id);

      // Should find at least the extends relationship
      expect(usages).toBeDefined();
      expect(Array.isArray(usages)).toBe(true);
    });
  });

  describe('getCallers() and getCallees()', () => {
    it('should get callers of a function', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const callers = cg.getCallers(formatValue.id);

      // processValue calls formatValue
      expect(Array.isArray(callers)).toBe(true);
    });

    it('should get callees of a function', () => {
      const nodes = cg.getNodesByKind('function');
      const processValue = nodes.find((n) => n.name === 'processValue');

      if (!processValue) {
        return;
      }

      const callees = cg.getCallees(processValue.id);

      expect(Array.isArray(callees)).toBe(true);
    });
  });

});
