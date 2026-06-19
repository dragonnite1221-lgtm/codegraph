import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { extractFromSource, scanDirectory, shouldIncludeFile } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { normalizePath } from '../src/utils';
import { DEFAULT_CONFIG } from '../src/types';
import { createTempDir, cleanupTempDir } from './extraction-helpers';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Vue Extraction', () => {
  it('should detect Vue files', () => {
    expect(detectLanguage('App.vue')).toBe('vue');
    expect(detectLanguage('components/Button.vue')).toBe('vue');
    expect(isLanguageSupported('vue')).toBe(true);
  });

  it('should extract component node from a Vue SFC', () => {
    const code = `<template>
  <div>{{ message }}</div>
</template>

<script>
export default {
  data() {
    return { message: 'Hello' };
  }
}
</script>
`;
    const result = extractFromSource('HelloWorld.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('HelloWorld');
    expect(componentNode?.language).toBe('vue');
    expect(componentNode?.isExported).toBe(true);
  });

  it('should extract functions from <script> block', () => {
    const code = `<template>
  <button @click="handleClick">Click</button>
</template>

<script>
function handleClick() {
  console.log('clicked');
}

const count = 0;
</script>
`;
    const result = extractFromSource('Button.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Button');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'handleClick');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');
  });

  it('should extract from <script setup lang="ts"> block', () => {
    const code = `<template>
  <div>{{ count }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

function increment(): void {
  count.value++;
}
</script>
`;
    const result = extractFromSource('Counter.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Counter');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'increment');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');

    // All nodes should be marked as vue language
    for (const node of result.nodes) {
      expect(node.language).toBe('vue');
    }
  });

  it('should extract from both <script> and <script setup> blocks', () => {
    const code = `<template>
  <div>{{ msg }}</div>
</template>

<script>
export default {
  name: 'DualScript'
}
</script>

<script setup>
const msg = 'hello';

function greet() {
  return msg;
}
</script>
`;
    const result = extractFromSource('DualScript.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    const greetFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
    expect(greetFunc).toBeDefined();
  });

  it('should create component node for template-only Vue file', () => {
    const code = `<template>
  <div>Static content</div>
</template>
`;
    const result = extractFromSource('Static.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Static');
    expect(componentNode?.language).toBe('vue');

    // Only the component node should exist (no script nodes)
    expect(result.nodes.length).toBe(1);
  });

  it('should create containment edges from component to script nodes', () => {
    const code = `<template>
  <div>{{ value }}</div>
</template>

<script setup lang="ts">
const value = 42;
</script>
`;
    const result = extractFromSource('Contained.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    // Should have containment edges from component to child nodes
    const containEdges = result.edges.filter(
      (e) => e.source === componentNode!.id && e.kind === 'contains'
    );
    expect(containEdges.length).toBeGreaterThan(0);
  });
});
