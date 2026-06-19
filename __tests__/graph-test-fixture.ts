/**
 * Shared sample-codebase fixture for the Graph Queries tests (base/derived/
 * utils/main with inheritance, calls, and dead code). Split out of graph.test.ts
 * so both graph test files share one setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

export async function createGraphProject(): Promise<{ testDir: string; cg: CodeGraph }> {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-test-'));

  // Create test files with relationships
  const srcDir = path.join(testDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Create base class
  fs.writeFileSync(
    path.join(srcDir, 'base.ts'),
    `
export class BaseClass {
protected value: number;

constructor(value: number) {
  this.value = value;
}

getValue(): number {
  return this.value;
}
}

export interface Printable {
print(): void;
}
`
  );

  // Create derived class
  fs.writeFileSync(
    path.join(srcDir, 'derived.ts'),
    `
import { BaseClass, Printable } from './base';

export class DerivedClass extends BaseClass implements Printable {
private name: string;

constructor(value: number, name: string) {
  super(value);
  this.name = name;
}

print(): void {
  console.log(this.getName(), this.getValue());
}

getName(): string {
  return this.name;
}
}
`
  );

  // Create utility functions
  fs.writeFileSync(
    path.join(srcDir, 'utils.ts'),
    `
export function formatValue(value: number): string {
return value.toFixed(2);
}

export function processValue(value: number): number {
const formatted = formatValue(value);
return parseFloat(formatted);
}

export function doubleValue(value: number): number {
return value * 2;
}

// Unused function (dead code)
function unusedHelper(): void {
console.log('never called');
}
`
  );

  // Create main file that uses everything
  fs.writeFileSync(
    path.join(srcDir, 'main.ts'),
    `
import { DerivedClass } from './derived';
import { processValue, doubleValue } from './utils';

function main(): void {
const obj = new DerivedClass(10, 'test');
obj.print();

const result = processValue(doubleValue(obj.getValue()));
console.log(result);
}

export { main };
`
  );

  // Initialize and index
  const cg = CodeGraph.initSync(testDir, {
    config: {
      include: ['src/**/*.ts'],
      exclude: [],
    },
  });

  await cg.indexAll();
  cg.resolveReferences();

  return { testDir, cg };
}

export function cleanupGraphProject(testDir: string, cg: CodeGraph | undefined): void {
  if (cg) {
    cg.destroy();
  }
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}
