import type { FileCallContext } from "./common.js";
import type { CleanupInput, CleanupResult } from "./types.js";

/**
 * Enables the built-in cleanup timer. Omit the whole option to run `cleanupExpiredFiles` from the
 * application's own scheduler instead.
 * @public
 */
export interface FileCleanupOptions extends CleanupInput {
  /**
   * Defaults to 60 minutes. The first round runs after a random delay in `[intervalMs, 2 × intervalMs)`
   * so nodes started together by a rolling deploy stay desynchronized; later rounds are evenly spaced.
   */
  readonly intervalMs?: number;
  /** Identity the timer uses for adapter calls; the Service has no built-in system user. */
  readonly context: FileCallContext;
}

// Defaults match the Univer server.
export const CLEANUP_DEFAULTS = Object.freeze({
  intervalMs: 60 * 60 * 1000,
  retentionMs: 2 * 60 * 60 * 1000,
  batchSize: 100,
  maxPerRun: 500,
  batchGapMs: 1000,
});

// Only temporary sources are cleaned: HttpImport = 1, HttpExport = 2.
export const CLEANUP_SOURCES: readonly number[] = Object.freeze([1, 2]);

type CleanupRunner = (context: FileCallContext, input: CleanupInput) => Promise<CleanupResult>;

// The built-in timer only fires on the interval and waits for the previous round; the batch logic
// lives in Service.cleanupExpiredFiles. The first delay is random within [interval, 2 * interval) so
// nodes started together stay desynchronized; later rounds are evenly spaced.
export class FileCleanupScheduler {
  private _initialTimer: ReturnType<typeof setTimeout> | undefined;
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _inFlight: Promise<unknown> | undefined;
  private _started = false;

  constructor(
    private readonly _options: FileCleanupOptions,
    private readonly _run: CleanupRunner,
    private readonly _onError: (error: unknown) => void
  ) {}

  start(): void {
    if (this._started) return;
    this._started = true;
    const interval = this._options.intervalMs ?? CLEANUP_DEFAULTS.intervalMs;
    if (!Number.isSafeInteger(interval) || interval <= 0) throw new TypeError("cleanup.intervalMs must be a positive integer");
    if (typeof this._options.context?.userID !== "string" || this._options.context.userID.length === 0) {
      throw new TypeError("cleanup.context.userID is required");
    }
    const initialDelay = interval + Math.floor(Math.random() * interval);
    this._initialTimer = setTimeout(() => {
      this._initialTimer = undefined;
      this._tick();
      this._timer = setInterval(() => this._tick(), interval);
      this._timer.unref?.();
    }, initialDelay);
    this._initialTimer.unref?.();
  }

  // Stops the timer and waits for the round in progress; called from dispose.
  async stop(): Promise<void> {
    if (this._initialTimer) clearTimeout(this._initialTimer);
    if (this._timer) clearInterval(this._timer);
    this._initialTimer = undefined;
    this._timer = undefined;
    await this._inFlight?.catch(() => undefined);
  }

  private _tick(): void {
    if (this._inFlight) return;
    const { context, intervalMs: _ignored, ...input } = this._options;
    this._inFlight = this._run(context, input)
      .catch((error) => this._onError(error))
      .finally(() => {
        this._inFlight = undefined;
      });
  }
}
