/**
 * Source extraction dispatcher.
 *
 * Selects custom extractors for mixed/template formats, then applies optional
 * framework-specific route extraction on top of the base tree-sitter result.
 */

import * as path from 'path';
import { Language, ExtractionResult } from '../types';
import { detectLanguage } from './grammars';
import { DfmExtractor } from './dfm-extractor';
import { LiquidExtractor } from './liquid-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { TreeSitterExtractor } from './tree-sitter';
import { VueExtractor } from './vue-extractor';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';

/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  }

  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((resolver) => frameworkNames.includes(resolver.name)),
      detectedLanguage
    );
    for (const framework of applicable) {
      if (!framework.extract) continue;
      try {
        const frameworkResult = framework.extract(filePath, source);
        result.nodes.push(...frameworkResult.nodes);
        result.unresolvedReferences.push(...frameworkResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${framework.name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
