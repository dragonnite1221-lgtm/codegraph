/**
 * Svelte template extractors: function calls in `{expr}` blocks and PascalCase
 * component usages. Split out of svelte-extractor.ts to stay within the
 * file-size gate.
 */

import { type SvelteContext, SVELTE_RUNES } from './svelte-script';

/** Ranges (0-indexed line spans) covered by <script>/<style> blocks. */
function coveredScriptStyleRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(source)) !== null) {
    const startLine = (source.substring(0, tagMatch.index).match(/\n/g) || []).length;
    const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
    ranges.push([startLine, endLine]);
  }
  return ranges;
}

/**
 * Extract function calls from Svelte template expressions.
 *
 * In Svelte, many calls happen in markup (e.g. `class={cn(...)}`), not inside
 * `<script>`. Scan template `{expression}` blocks (skipping script/style) for
 * call patterns.
 */
export function extractTemplateCalls(ctx: SvelteContext, componentNodeId: string): void {
  const { source, filePath } = ctx;
  const coveredRanges = coveredScriptStyleRanges(source);

  // Find template expressions: {...} outside of script/style blocks. Excludes
  // Svelte block syntax ({#if}, {:else}, {/if}, {@html}, {@render}).
  const lines = source.split('\n');
  const exprRegex = /\{([^}#/:@][^}]*)\}/g;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    // Skip lines inside script/style blocks
    if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

    const line = lines[lineIdx]!;
    let exprMatch;
    while ((exprMatch = exprRegex.exec(line)) !== null) {
      const expr = exprMatch[1]!;
      // Extract function calls: identifiers followed by ( — cn(...), obj.method(...)
      const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
      let callMatch;
      while ((callMatch = callRegex.exec(expr)) !== null) {
        const calleeName = callMatch[1]!;
        // Skip Svelte runes, control flow keywords, and common non-function patterns
        if (SVELTE_RUNES.has(calleeName)) continue;
        if (calleeName === 'if' || calleeName === 'else' || calleeName === 'each' || calleeName === 'await') continue;

        ctx.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: calleeName,
          referenceKind: 'calls',
          line: lineIdx + 1, // 1-indexed
          column: exprMatch.index + callMatch.index,
          filePath,
          language: 'svelte',
        });
      }
    }
  }
}

/**
 * Extract component usages from the Svelte template.
 *
 * PascalCase tags like <Modal>, <Button /> represent component instantiations —
 * analogous to function calls. Capturing them creates parent→child component
 * edges and anchor points in markup.
 */
export function extractTemplateComponents(ctx: SvelteContext, componentNodeId: string): void {
  const { source, filePath } = ctx;
  const coveredRanges = coveredScriptStyleRanges(source);

  const lines = source.split('\n');
  // Match PascalCase opening/self-closing tags (closing tags </Foo> won't match)
  const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

    const line = lines[lineIdx]!;
    let match;
    while ((match = componentTagRegex.exec(line)) !== null) {
      const componentName = match[1]!;

      ctx.unresolvedReferences.push({
        fromNodeId: componentNodeId,
        referenceName: componentName,
        referenceKind: 'references',
        line: lineIdx + 1, // 1-indexed
        column: match.index + 1,
        filePath,
        language: 'svelte',
      });
    }
  }
}
