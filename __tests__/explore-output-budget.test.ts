/**
 * Adaptive output budget for codegraph_explore (#185).
 *
 * The explore tool used to apply a fixed 35KB output cap regardless of
 * project size, which on small codebases was a net loss vs. native
 * grep+Read. These tests pin the per-tier budget shape so future tuning
 * doesn't silently drift the small-project case back into bloat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getExploreOutputBudget, getExploreBudget, ToolHandler } from '../src/mcp/tools';
import CodeGraph from '../src/index';

describe('getExploreOutputBudget', () => {
  it('returns a strictly smaller total cap for small projects than for huge ones', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxOutputChars).toBeLessThan(huge.maxOutputChars);
    expect(small.defaultMaxFiles).toBeLessThan(huge.defaultMaxFiles);
    expect(small.maxCharsPerFile).toBeLessThan(huge.maxCharsPerFile);
  });

  it('caps total output well under 8000 tokens (~32k chars) on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.maxOutputChars).toBeLessThanOrEqual(20000);
  });

  it('keeps the historical 35k+ ceiling for medium-large projects so existing benchmarks do not regress', () => {
    const large = getExploreOutputBudget(10000);
    expect(large.maxOutputChars).toBeGreaterThanOrEqual(35000);
  });

  it('uses tier breakpoints matching getExploreBudget so call-count and output-budget agree on a project', () => {
    // Anything in the same tier should pick the same total-output cap.
    const tier1a = getExploreOutputBudget(50);
    const tier1b = getExploreOutputBudget(499);
    expect(tier1a.maxOutputChars).toBe(tier1b.maxOutputChars);
    expect(getExploreBudget(50)).toBe(getExploreBudget(499));

    const tier2a = getExploreOutputBudget(500);
    const tier2b = getExploreOutputBudget(4999);
    expect(tier2a.maxOutputChars).toBe(tier2b.maxOutputChars);
    expect(getExploreBudget(500)).toBe(getExploreBudget(4999));

    const tier3a = getExploreOutputBudget(5000);
    const tier3b = getExploreOutputBudget(14999);
    expect(tier3a.maxOutputChars).toBe(tier3b.maxOutputChars);

    // And crossing a breakpoint changes the cap.
    expect(tier1a.maxOutputChars).not.toBe(tier2a.maxOutputChars);
    expect(tier2a.maxOutputChars).not.toBe(tier3a.maxOutputChars);
  });

  it('gates off "Additional relevant files", completeness signal, and budget note on small projects', () => {
    const small = getExploreOutputBudget(100);
    expect(small.includeAdditionalFiles).toBe(false);
    expect(small.includeCompletenessSignal).toBe(false);
    expect(small.includeBudgetNote).toBe(false);
  });

  it('keeps all meta-text on for projects that earn the breadth signal (>=500 files)', () => {
    const medium = getExploreOutputBudget(1000);
    expect(medium.includeAdditionalFiles).toBe(true);
    expect(medium.includeCompletenessSignal).toBe(true);
    expect(medium.includeBudgetNote).toBe(true);
  });

  it('keeps the Relationships section on for every tier — it is the cheapest structural signal', () => {
    expect(getExploreOutputBudget(50).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(1000).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(10000).includeRelationships).toBe(true);
    expect(getExploreOutputBudget(30000).includeRelationships).toBe(true);
  });

  it('caps the per-file header symbol list more tightly on small projects', () => {
    // Without this cap, a file like Alamofire's Session.swift produced
    // a 3.4KB symbol list in the `#### path — sym, sym, ...` header,
    // dwarfing the per-file body cap.
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.maxSymbolsInFileHeader).toBeLessThan(huge.maxSymbolsInFileHeader);
    expect(small.maxSymbolsInFileHeader).toBeGreaterThan(0);
  });

  it('uses a tighter clustering gap threshold on small projects to break runaway single clusters', () => {
    const small = getExploreOutputBudget(100);
    const huge = getExploreOutputBudget(30000);
    expect(small.gapThreshold).toBeLessThanOrEqual(huge.gapThreshold);
  });

  it('handles the boundary file counts exactly (off-by-one regression guard)', () => {
    // 499 -> small tier, 500 -> medium tier
    expect(getExploreOutputBudget(499).maxOutputChars).toBe(getExploreOutputBudget(100).maxOutputChars);
    expect(getExploreOutputBudget(500).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    // 4999 -> medium, 5000 -> large
    expect(getExploreOutputBudget(4999).maxOutputChars).toBe(getExploreOutputBudget(1000).maxOutputChars);
    expect(getExploreOutputBudget(5000).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    // 14999 -> large, 15000 -> xlarge
    expect(getExploreOutputBudget(14999).maxOutputChars).toBe(getExploreOutputBudget(10000).maxOutputChars);
    expect(getExploreOutputBudget(15000).maxOutputChars).toBe(getExploreOutputBudget(30000).maxOutputChars);
  });
});

/**
 * End-to-end check that the budget is actually applied by handleExplore.
 *
 * Builds a tiny synthetic project (<500 files, so the small tier), indexes
 * it, and confirms the output:
 *   - stays under the small-tier maxOutputChars cap
 *   - omits the meta-text the small tier gates off (completeness signal,
 *     budget note, "Additional relevant files")
 *
 * Regression guard for #185 — protects against future edits to handleExplore
 * silently re-introducing the fixed 35KB cap on small projects.
 */
