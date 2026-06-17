/**
 * Cargo.toml parsing primitives split out of cargo-workspace.ts to keep it
 * within the 200-line limit. Pure helpers — no behavior change.
 */

export function getSection(content: string, sectionName: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === `[${sectionName}]`) {
        inSection = true;
      }
      continue;
    }

    if (/^\[[^\]]+\]$/.test(trimmed)) {
      break;
    }

    sectionLines.push(line);
  }

  if (!inSection) return null;
  return sectionLines.join('\n');
}

export function extractQuotedValues(valueList: string): string[] {
  const values: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let current = '';

  for (const ch of valueList) {
    if (!quote) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        current = '';
      }
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === quote) {
      values.push(current.trim());
      quote = null;
      current = '';
      continue;
    }

    current += ch;
  }

  return values.filter(Boolean);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getArrayValue(section: string, key: string): string | null {
  const keyRegex = new RegExp(`\\b${escapeRegExp(key)}\\b\\s*=`, 'm');
  const keyMatch = keyRegex.exec(section);
  if (!keyMatch) return null;

  let i = keyMatch.index + keyMatch[0].length;
  while (i < section.length && /\s/.test(section.charAt(i))) i++;
  if (section.charAt(i) !== '[') return null;
  i++;

  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 1;
  const start = i;

  while (i < section.length) {
    const ch = section.charAt(i);

    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }

    if (ch === '[') {
      depth++;
      i++;
      continue;
    }

    if (ch === ']') {
      depth--;
      if (depth === 0) {
        return section.slice(start, i);
      }
      i++;
      continue;
    }

    i++;
  }

  return null;
}

