export class AsyncSemaphore {
  private readonly waiters: Array<() => void> = [];
  private inUse = 0;

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`AsyncSemaphore limit must be a positive integer, received ${limit}`);
    }
  }

  getLimit(): number {
    return this.limit;
  }

  getInUseCount(): number {
    return this.inUse;
  }

  getQueueLength(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.inUse < this.limit && this.waiters.length === 0) {
      this.inUse += 1;
      return this.createRelease();
    }

    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.createRelease()));
    });
  }

  async run<T>(_: string, task: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;

      const next = this.waiters.shift();
      if (next) {
        queueMicrotask(next);
        return;
      }

      this.inUse -= 1;
    };
  }
}
