export class RuntimeState {
  readonly readers = new Set<AbortController>();
  readonly active = new Map<string, AbortController>();
  readonly inflight = new Set<Promise<unknown>>();
  restoreTask: Promise<unknown> | undefined;
  readonly transport = { streams: 0, peakBuffered: 0, slowDisconnects: 0 };
  timer: ReturnType<typeof setInterval> | undefined;
  ticking = false;
  maintaining = false;
  shuttingDown = false;
  backupRunning = false;
  nextCleanup = 0;
}
