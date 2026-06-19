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
  describe('PHP imports', () => {
    it('should extract simple use', () => {
      const code = `<?php use PHPUnit\\Framework\\TestCase;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('PHPUnit\\Framework\\TestCase');
    });

    it('should extract aliased use', () => {
      const code = `<?php use Mockery as m;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Mockery');
      expect(importNode?.signature).toContain('as m');
    });

    it('should extract function use', () => {
      const code = `<?php use function Illuminate\\Support\\env;`;
      const result = extractFromSource('helpers.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Illuminate\\Support\\env');
      expect(importNode?.signature).toContain('function');
    });

    it('should extract grouped use', () => {
      const code = `<?php use Illuminate\\Database\\{Model, Builder};`;
      const result = extractFromSource('Models.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Database\\Model');
      expect(names).toContain('Illuminate\\Database\\Builder');
    });

    it('should extract multiple uses', () => {
      const code = `<?php
use Illuminate\\Support\\Collection;
use Illuminate\\Support\\Str;
use Closure;
`;
      const result = extractFromSource('Service.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Illuminate\\Support\\Collection');
      expect(names).toContain('Illuminate\\Support\\Str');
      expect(names).toContain('Closure');
    });
  });

  describe('Ruby imports', () => {
    it('should extract require', () => {
      const code = `require 'json'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
      expect(importNode?.signature).toBe("require 'json'");
    });

    it('should extract require with path', () => {
      const code = `require 'active_support/core_ext/string'`;
      const result = extractFromSource('config.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('active_support/core_ext/string');
    });

    it('should extract require_relative', () => {
      const code = `require_relative '../test_helper'`;
      const result = extractFromSource('test/my_test.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../test_helper');
      expect(importNode?.signature).toContain('require_relative');
    });

    it('should not extract non-require calls', () => {
      const code = `puts 'hello'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeUndefined();
    });

    it('should extract multiple requires', () => {
      const code = `
require 'json'
require 'yaml'
require_relative 'helper'
`;
      const result = extractFromSource('lib.rb', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('json');
      expect(names).toContain('yaml');
      expect(names).toContain('helper');
    });
  });

});
