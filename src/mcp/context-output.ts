import type { BuildContextOptions, TaskContext, TaskInput } from '../types';
import { formatTaskContext } from './format-output';

export type ContextGraph = {
  buildContext(input: TaskInput, options?: BuildContextOptions): Promise<TaskContext | string>;
};

const FEATURE_KEYWORDS = [
  'add', 'create', 'implement', 'build', 'enable', 'allow',
  'new feature', 'support for', 'ability to', 'want to',
  'should be able', 'need to add', 'swap', 'edit', 'modify',
];

const BUG_KEYWORDS = [
  'fix', 'bug', 'error', 'broken', 'crash', 'issue', 'problem',
  'not working', 'fails', 'undefined', 'null',
];

const EXPLORATION_KEYWORDS = [
  'how does', 'where is', 'what is', 'find', 'show me',
  'explain', 'understand', 'explore',
];

const FEATURE_REMINDER = '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria';

export function looksLikeFeatureRequest(task: string): boolean {
  const lowerTask = task.toLowerCase();

  if (BUG_KEYWORDS.some((keyword) => lowerTask.includes(keyword))) return false;
  if (EXPLORATION_KEYWORDS.some((keyword) => lowerTask.includes(keyword))) return false;

  return FEATURE_KEYWORDS.some((keyword) => lowerTask.includes(keyword));
}

export async function buildContextOutput(
  cg: ContextGraph,
  task: string,
  options: Pick<BuildContextOptions, 'maxNodes' | 'includeCode'>,
): Promise<string> {
  const context = await cg.buildContext(task, {
    ...options,
    format: 'markdown',
  });
  const reminder = looksLikeFeatureRequest(task) ? FEATURE_REMINDER : '';

  if (typeof context === 'string') {
    return context + reminder;
  }

  return formatTaskContext(context) + reminder;
}
