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

describe('Import Extraction', () => {
  describe('Dart imports', () => {
    it('should extract dart: import', () => {
      const code = `import 'dart:async';`;
      const result = extractFromSource('main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('dart:async');
      expect(importNode?.signature).toBe("import 'dart:async';");
    });

    it('should extract package import', () => {
      const code = `import 'package:flutter/material.dart';`;
      const result = extractFromSource('app.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:flutter/material.dart');
    });

    it('should extract aliased import', () => {
      const code = `import 'package:http/http.dart' as http;`;
      const result = extractFromSource('api.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:http/http.dart');
      expect(importNode?.signature).toContain('as http');
    });

    it('should extract multiple imports', () => {
      const code = `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
`;
      const result = extractFromSource('main.dart', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('dart:async');
      expect(names).toContain('dart:convert');
      expect(names).toContain('package:flutter/material.dart');
    });

    it('should extract relative import', () => {
      const code = `import '../utils/helpers.dart';`;
      const result = extractFromSource('lib/main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helpers.dart');
    });
  });

  describe('Liquid imports', () => {
    it('should extract render tag', () => {
      const code = `{% render 'loading-spinner' %}`;
      const result = extractFromSource('template.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('loading-spinner');
      expect(importNode?.signature).toContain('render');
    });

    it('should extract section tag', () => {
      const code = `{% section 'header' %}`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('header');
      expect(importNode?.signature).toContain('section');
    });

    it('should extract include tag', () => {
      const code = `{% include 'icon-cart' %}`;
      const result = extractFromSource('snippets/header.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('icon-cart');
      expect(importNode?.signature).toContain('include');
    });

    it('should extract render with whitespace control', () => {
      const code = `{%- render 'price' -%}`;
      const result = extractFromSource('snippets/product.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('price');
    });

    it('should extract multiple imports', () => {
      const code = `
{% section 'header' %}
{% render 'loading-spinner' %}
{% render 'cart-drawer' %}
`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('header');
      expect(names).toContain('loading-spinner');
      expect(names).toContain('cart-drawer');
    });
  });
});
