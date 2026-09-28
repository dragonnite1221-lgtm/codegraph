import { describe, expect, it } from 'vitest';
import { extractVueRoutes } from '../src/resolution/frameworks/vue-resolve';

describe('Nuxt page extraction', () => {
  it('includes root and nested pages without matching otherpages', () => {
    expect(extractVueRoutes('pages/about.vue').nodes.map(node => node.name)).toEqual(['/about']);
    expect(extractVueRoutes('src/pages/about.vue').nodes.map(node => node.name)).toEqual(['/about']);
    expect(extractVueRoutes('otherpages/about.vue').nodes).toEqual([]);
  });
});
