/**
 * Argument coercion + session helpers and the handler context interface for
 * the MCP tool handlers. Split out of tools.ts to stay within the file-size
 * gate.
 */

import type CodeGraph from '../index';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clamp } from '../utils';
import type { ToolResult } from './tool-types';

/** Minimal surface the tool handlers need from ToolHandler. */
export interface ToolHandlerCtx {
  getCodeGraph(projectPath?: string): CodeGraph;
  validateString(value: unknown, name: string): string | ToolResult;
  textResult(text: string): ToolResult;
  truncateOutput(text: string): string;
}

export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || value === '') {
    return fallback;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

export function optionalBoundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : undefined;
}

/**
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 */
export function markSessionConsulted(sessionId: string): void {
  try {
    const hash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `codegraph-consulted-${hash}`);
    writeFileSync(markerPath, new Date().toISOString(), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    // Silently fail - don't break MCP on marker write failure
  }
}
