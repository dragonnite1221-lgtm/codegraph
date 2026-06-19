/**
 * Context Builder tests: getCode + findRelevantContext.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import CodeGraph from '../src/index';
import { createContextProject, cleanupContextProject } from './context-test-fixture';

describe('Context Builder', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    ({ testDir, cg } = await createContextProject());
  });

  afterEach(() => {
    cleanupContextProject(testDir, cg);
  });

  describe('getCode()', () => {
    it('should extract code for a node', async () => {
      // Find the PaymentService class
      const nodes = cg.getNodesByKind('class');
      const paymentService = nodes.find((n) => n.name === 'PaymentService');

      expect(paymentService).toBeDefined();

      const code = await cg.getCode(paymentService!.id);

      expect(code).not.toBeNull();
      expect(code).toContain('class PaymentService');
      expect(code).toContain('processPayment');
    });

    it('should return null for non-existent node', async () => {
      const code = await cg.getCode('non-existent-id');
      expect(code).toBeNull();
    });
  });

  describe('findRelevantContext()', () => {
    it('should find relevant nodes for a query', async () => {
      // Use simple query that matches symbol names (FTS5 treats spaces as AND)
      const result = await cg.findRelevantContext('PaymentService');

      expect(result.nodes.size).toBeGreaterThan(0);
      // Should find payment-related nodes
      const nodeNames = Array.from(result.nodes.values()).map((n) => n.name);
      expect(
        nodeNames.some(
          (name) =>
            name.toLowerCase().includes('payment') ||
            name.toLowerCase().includes('checkout')
        )
      ).toBe(true);
    });

    it('should include edges in the result', async () => {
      const result = await cg.findRelevantContext('checkout', {
        traversalDepth: 2,
      });

      // Should have some edges from traversal
      expect(result.edges).toBeDefined();
    });

    it('should respect maxNodes option', async () => {
      const result = await cg.findRelevantContext('function', {
        maxNodes: 5,
      });

      expect(result.nodes.size).toBeLessThanOrEqual(5);
    });
  });

});
