/**
 * Named-parameter translation for the WASM SQLite backend. better-sqlite3 uses
 * @named params; node-sqlite3-wasm only supports positional `?`. Split out of
 * sqlite-adapter.ts to stay within the file-size gate.
 */

/**
 * Translate @named parameters (better-sqlite3 style) to positional ? params
 * for node-sqlite3-wasm, which only supports positional binding.
 *
 * Returns the rewritten SQL and an ordered list of parameter names.
 * If no named params are found, returns null for paramOrder (positional mode).
 */
export function translateNamedParams(sql: string): { sql: string; paramOrder: string[] | null } {
  const paramOrder: string[] = [];
  let rewritten = '';
  let i = 0;
  let state:
    | 'code'
    | 'single'
    | 'double'
    | 'backtick'
    | 'bracket'
    | 'line-comment'
    | 'block-comment' = 'code';

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === 'line-comment') {
      rewritten += ch;
      if (ch === '\n') state = 'code';
      i += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        rewritten += '*/';
        state = 'code';
        i += 2;
      } else {
        rewritten += ch;
        i += 1;
      }
      continue;
    }

    if (state === 'single') {
      rewritten += ch;
      if (ch === "'" && next === "'") {
        rewritten += next;
        i += 2;
      } else {
        if (ch === "'") state = 'code';
        i += 1;
      }
      continue;
    }

    if (state === 'double') {
      rewritten += ch;
      if (ch === '"' && next === '"') {
        rewritten += next;
        i += 2;
      } else {
        if (ch === '"') state = 'code';
        i += 1;
      }
      continue;
    }

    if (state === 'backtick') {
      rewritten += ch;
      if (ch === '`' && next === '`') {
        rewritten += next;
        i += 2;
      } else {
        if (ch === '`') state = 'code';
        i += 1;
      }
      continue;
    }

    if (state === 'bracket') {
      rewritten += ch;
      if (ch === ']' && next === ']') {
        rewritten += next;
        i += 2;
      } else {
        if (ch === ']') state = 'code';
        i += 1;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      rewritten += '--';
      state = 'line-comment';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      rewritten += '/*';
      state = 'block-comment';
      i += 2;
      continue;
    }

    if (ch === "'") {
      rewritten += ch;
      state = 'single';
      i += 1;
      continue;
    }

    if (ch === '"') {
      rewritten += ch;
      state = 'double';
      i += 1;
      continue;
    }

    if (ch === '`') {
      rewritten += ch;
      state = 'backtick';
      i += 1;
      continue;
    }

    if (ch === '[') {
      rewritten += ch;
      state = 'bracket';
      i += 1;
      continue;
    }

    if (ch === '@' && next && /\w/.test(next)) {
      let end = i + 1;
      while (end < sql.length) {
        const paramChar = sql[end];
        if (!paramChar || !/\w/.test(paramChar)) break;
        end += 1;
      }
      paramOrder.push(sql.slice(i + 1, end));
      rewritten += '?';
      i = end;
      continue;
    }

    rewritten += ch;
    i += 1;
  }

  if (paramOrder.length === 0) {
    return { sql, paramOrder: null };
  }
  return { sql: rewritten, paramOrder };
}

/**
 * Convert better-sqlite3-style params to a positional array for node-sqlite3-wasm.
 *
 * Handles three calling conventions:
 * - Named object: run({ id: '1', name: 'a' }) → positional array via paramOrder
 * - Positional args: run('a', 'b') → ['a', 'b']
 * - No args: run() → undefined
 */
export function resolveParams(params: any[], paramOrder: string[] | null): any {
  if (params.length === 0) return undefined;

  // If paramOrder exists and first arg is a plain object, do named→positional translation
  if (paramOrder && params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0]) && !(params[0] instanceof Buffer) && !(params[0] instanceof Uint8Array)) {
    const obj = params[0];
    return paramOrder.map(name => obj[name]);
  }

  // Positional: single value or already an array
  if (params.length === 1) return params[0];
  return params;
}
