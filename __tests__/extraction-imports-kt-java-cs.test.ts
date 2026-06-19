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
  describe('Kotlin imports', () => {
    it('should extract simple import', () => {
      const code = `import java.io.IOException`;
      const result = extractFromSource('Main.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.io.IOException');
      expect(importNode?.signature).toBe('import java.io.IOException');
    });

    it('should extract aliased import', () => {
      const code = `import okhttp3.Request.Builder as RequestBuilder`;
      const result = extractFromSource('Utils.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('okhttp3.Request.Builder');
      expect(importNode?.signature).toContain('as RequestBuilder');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.concurrent.TimeUnit.*`;
      const result = extractFromSource('Time.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.concurrent.TimeUnit');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.io.IOException
import kotlin.test.assertFailsWith
import okhttp3.OkHttpClient
`;
      const result = extractFromSource('Test.kt', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.io.IOException');
      expect(names).toContain('kotlin.test.assertFailsWith');
      expect(names).toContain('okhttp3.OkHttpClient');
    });
  });

  describe('Java imports', () => {
    it('should extract simple import', () => {
      const code = `import java.util.List;`;
      const result = extractFromSource('Main.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.List');
      expect(importNode?.signature).toBe('import java.util.List;');
    });

    it('should extract static import', () => {
      const code = `import static java.util.Collections.emptyList;`;
      const result = extractFromSource('Utils.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Collections.emptyList');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.*;`;
      const result = extractFromSource('App.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract nested class import', () => {
      const code = `import java.util.Map.Entry;`;
      const result = extractFromSource('MapUtil.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Map.Entry');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.util.List;
import java.util.Map;
import java.io.IOException;
`;
      const result = extractFromSource('Service.java', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.util.List');
      expect(names).toContain('java.util.Map');
      expect(names).toContain('java.io.IOException');
    });
  });

  describe('C# imports', () => {
    it('should extract simple using', () => {
      const code = `using System;`;
      const result = extractFromSource('Program.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System');
      expect(importNode?.signature).toBe('using System;');
    });

    it('should extract qualified using', () => {
      const code = `using System.Collections.Generic;`;
      const result = extractFromSource('Utils.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic');
    });

    it('should extract static using', () => {
      const code = `using static System.Console;`;
      const result = extractFromSource('App.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Console');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract alias using', () => {
      const code = `using MyList = System.Collections.Generic.List<int>;`;
      const result = extractFromSource('Types.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic.List<int>');
      expect(importNode?.signature).toContain('MyList =');
    });

    it('should extract multiple usings', () => {
      const code = `
using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
`;
      const result = extractFromSource('Service.cs', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('System');
      expect(names).toContain('System.Threading.Tasks');
      expect(names).toContain('Microsoft.Extensions.DependencyInjection');
    });
  });

});
