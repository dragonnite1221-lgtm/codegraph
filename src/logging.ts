/**
 * CodeGraph logging — split out of errors.ts to keep it within the 200-line
 * limit. Re-exported from errors for backward-compatible import paths.
 */

/**
 * Simple logger for CodeGraph operations
 *
 * By default, logs to console.warn for warnings and console.error for errors.
 * Can be configured to use custom logging.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default console-based logger
 */
export const defaultLogger: Logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (process.env.CODEGRAPH_DEBUG) {
      console.debug(`[CodeGraph] ${message}`, context ?? '');
    }
  },
  warn(message: string, context?: Record<string, unknown>): void {
    console.warn(`[CodeGraph] ${message}`, context ?? '');
  },
  error(message: string, context?: Record<string, unknown>): void {
    console.error(`[CodeGraph] ${message}`, context ?? '');
  },
};

/**
 * Silent logger (no output) - useful for tests
 */
export const silentLogger: Logger = {
  debug(): void {},
  warn(): void {},
  error(): void {},
};

/**
 * Current logger instance (can be replaced)
 */
let currentLogger: Logger = defaultLogger;

/**
 * Set the global logger
 */
export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

/**
 * Get the current logger
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * Log a debug message
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  currentLogger.debug(message, context);
}

/**
 * Log a warning message
 */
export function logWarn(message: string, context?: Record<string, unknown>): void {
  currentLogger.warn(message, context);
}

/**
 * Log an error message
 */
export function logError(message: string, context?: Record<string, unknown>): void {
  currentLogger.error(message, context);
}
