// Background index builds (Wikipedia, Wikisource) one at a time, the smallest archive first.
// Builds share the server's main thread (the directory scan) and libuv's threads (decompression),
// so running them together only slows each one down: re-indexing 8 Wikipedias at once took
// 52 min on 2026-10-06, Simple English 20 min instead of 1, and the full English Wikipedia's scan
// ran at half speed.

/** Archives up to this size are indexed at once, outside the queue: seconds each. */
export const SMALL_INDEX_BYTES = 1024 ** 3;

export class IndexQueue {
  /** @param {{ smallBytes?: number }} [opts] */
  constructor({ smallBytes = SMALL_INDEX_BYTES } = {}) {
    this._small = smallBytes;
    this._waiting = [];
    this._running = false;
    this._holds = 0;
    this._seq = 0;
  }

  /**
   * Runs `task` when its turn comes, at once for a small archive, and settles with its result.
   * @template T
   * @param {number} bytes the archive's size: the smallest waiting archive goes next
   * @param {() => Promise<T>} task
   * @param {{ cancelled?: () => boolean }} [opts] cancelled: checked when its turn comes; a
   *   cancelled task is skipped (rejects)
   * @returns {Promise<T>}
   */
  run(bytes, task, { cancelled = () => false } = {}) {
    if (bytes <= this._small) return Promise.resolve().then(task);
    return new Promise((resolve, reject) => {
      this._waiting.push({ bytes, seq: this._seq++, task, cancelled, resolve, reject });
      this._next();
    });
  }

  /** True when an archive of `bytes` waits its turn (not small). */
  queues(bytes) {
    return bytes > this._small;
  }

  /** Builds waiting for their turn (not the one running). */
  get waiting() {
    return this._waiting.length;
  }

  /**
   * Starts no build until the matching release(): while a folder scan is still opening archives,
   * so that the smallest of them goes first rather than the first opened.
   */
  hold() {
    this._holds++;
  }

  release() {
    this._holds = Math.max(0, this._holds - 1);
    this._next();
  }

  _next() {
    if (this._running || this._holds) return;
    this._waiting.sort((a, b) => a.bytes - b.bytes || a.seq - b.seq);
    const job = this._waiting.shift();
    if (!job) return;
    if (job.cancelled()) {
      job.reject(new Error('cancelled'));
      this._next();
      return;
    }
    this._running = true;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      this._running = false;
      this._next();
    });
  }
}
