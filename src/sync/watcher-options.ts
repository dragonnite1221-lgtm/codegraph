export interface WatchOptions {
  /** Debounce after the last event before syncing. Default 2000ms. */
  debounceMs?: number;
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;
  onSyncError?: (error: Error) => void;
  /** Reconciliation interval for missed native events. 0 disables it. Default 30000ms. */
  pollIntervalMs?: number;
}
