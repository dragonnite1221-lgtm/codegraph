import { describe, expect, it } from 'vitest';

import {
  isInstantiationNodeType,
  normalizeInstantiationClassName,
} from '../src/extraction/tree-sitter-node-helpers';

describe('tree-sitter node helpers', () => {
  it('recognizes constructor invocation node types', () => {
    expect(isInstantiationNodeType('new_expression')).toBe(true);
    expect(isInstantiationNodeType('object_creation_expression')).toBe(true);
    expect(isInstantiationNodeType('instance_creation_expression')).toBe(true);
    expect(isInstantiationNodeType('call_expression')).toBe(false);
  });

  it('normalizes constructor names for graph resolution', () => {
    expect(normalizeInstantiationClassName('Map<K, V>')).toBe('Map');
    expect(normalizeInstantiationClassName('ns.Foo')).toBe('Foo');
    expect(normalizeInstantiationClassName('crate::module::Service<T>')).toBe('Service');
    expect(normalizeInstantiationClassName('  Widget  ')).toBe('Widget');
  });
});
