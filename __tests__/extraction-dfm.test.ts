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

describe('DFM/FMX Extraction', () => {
  it('should extract components from DFM', () => {
    const code = `object Form1: TForm1
  Left = 0
  Top = 0
  Caption = 'My Form'
  object Button1: TButton
    Left = 10
    Top = 10
    Caption = 'Click Me'
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
    expect(components.map((c) => c.name)).toContain('Button1');

    const button = components.find((c) => c.name === 'Button1');
    expect(button?.signature).toBe('TButton');
  });

  it('should extract nested component hierarchy', () => {
    const code = `object Form1: TForm1
  object Panel1: TPanel
    object Label1: TLabel
      Caption = 'Hello'
    end
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(3);

    // Check nesting: Panel1 contains Label1
    const panel = components.find((c) => c.name === 'Panel1');
    const label = components.find((c) => c.name === 'Label1');
    const containsEdge = result.edges.find(
      (e) => e.source === panel?.id && e.target === label?.id && e.kind === 'contains'
    );
    expect(containsEdge).toBeDefined();
  });

  it('should extract event handler references', () => {
    const code = `object Form1: TForm1
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(3);
    expect(refs.map((r) => r.referenceName)).toContain('FormCreate');
    expect(refs.map((r) => r.referenceName)).toContain('FormDestroy');
    expect(refs.map((r) => r.referenceName)).toContain('Button1Click');
    expect(refs.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('should handle multi-line properties', () => {
    const code = `object Form1: TForm1
  SQL.Strings = (
    'SELECT * FROM users'
    'WHERE active = 1')
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.referenceName).toBe('Button1Click');
  });

  it('should handle inherited keyword', () => {
    const code = `inherited Form1: TForm1
  Caption = 'Inherited Form'
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
  });

  it('should handle item collection properties', () => {
    const code = `object Form1: TForm1
  object StatusBar1: TStatusBar
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
  });

});
