/**
 * Coalesces many `schedule()` calls into one `flush()` per animation frame. The playground
 * uses it so a flood of console or error messages from a build causes at most one store
 * update (one React render) per frame.
 */
export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

export const animationFrameScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => {
    cancelAnimationFrame(handle);
  },
};

export class FrameBatcher {
  private handle: number | null = null;

  constructor(
    private readonly flush: () => void,
    private readonly scheduler: FrameScheduler = animationFrameScheduler,
  ) {}

  /** Requests a flush on the next frame (no-op if one is already pending). */
  schedule(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.request(() => {
      this.handle = null;
      this.flush();
    });
  }

  /** Drops a pending flush. */
  cancel(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
  }

  get pending(): boolean {
    return this.handle !== null;
  }
}
