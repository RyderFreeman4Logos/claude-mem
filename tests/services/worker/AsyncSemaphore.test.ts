import { describe, expect, test } from 'bun:test';
import { AsyncSemaphore } from '../../../src/services/worker/AsyncSemaphore.js';

describe('AsyncSemaphore', () => {
  test('rejects non-positive limits', () => {
    expect(() => new AsyncSemaphore(0)).toThrow('AsyncSemaphore limit must be a positive integer');
    expect(() => new AsyncSemaphore(-1)).toThrow('AsyncSemaphore limit must be a positive integer');
  });

  test('resolves queued acquirers in FIFO order', async () => {
    const semaphore = new AsyncSemaphore(1);
    const firstRelease = await semaphore.acquire();
    const acquisitionOrder: number[] = [];

    const queuedReleases = Array.from({ length: 100 }, (_, index) => (
      semaphore.acquire().then((release) => {
        acquisitionOrder.push(index);
        return release;
      })
    ));

    expect(acquisitionOrder).toEqual([]);
    expect(semaphore.getQueueLength()).toBe(100);

    let release = firstRelease;

    for (let index = 0; index < queuedReleases.length; index += 1) {
      release();
      release = await queuedReleases[index];
      expect(acquisitionOrder).toEqual(Array.from({ length: index + 1 }, (_, order) => order));
    }

    release();
    expect(semaphore.getInUseCount()).toBe(0);
    expect(semaphore.getQueueLength()).toBe(0);
  });
});
