/**
 * Helpers for ParseWorkerPool: message type-guards and the grammar-load
 * handshake. Split out of parse-worker-pool.ts to stay within the file-size
 * gate.
 */

import type { Worker } from 'worker_threads';
import type { ExtractionResult, Language } from '../types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isExtractionResult(value: unknown): value is ExtractionResult {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    Array.isArray(value.unresolvedReferences) &&
    Array.isArray(value.errors) &&
    typeof value.durationMs === 'number'
  );
}

/**
 * Load grammars in a freshly spawned worker. Resolves on `grammars-loaded`,
 * rejects on any other message / error / early exit. Detaches its listeners
 * once settled.
 */
export function loadGrammarsInWorker(worker: Worker, languages: Language[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onMessage = (msg: unknown): void => {
      if (isRecord(msg) && msg.type === 'grammars-loaded') {
        settle(resolve);
      } else {
        settle(() => reject(new Error('Unexpected worker message during grammar load')));
      }
    };
    const onError = (err: Error): void => {
      settle(() => reject(err));
    };
    const onExit = (code: number): void => {
      settle(() => reject(new Error(`Worker exited during grammar load with code ${code}`)));
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.postMessage({ type: 'load-grammars', languages });
  });
}
