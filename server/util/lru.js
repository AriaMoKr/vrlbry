/**
 * Small LRU cache with an optional byte budget (§3, shared helper).
 *
 * Built on Map's insertion order: the first key is the least recently used, and a hit is
 * re-inserted at the end. All operations are O(1) (amortised for eviction).
 */
export class LRUCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxBytes=Infinity]   total size budget, as measured by sizeOf
   * @param {number} [opts.maxEntries=Infinity] maximum number of entries
   * @param {(value: any) => number} [opts.sizeOf] size of one value (default: `.length`, else 1)
   */
  constructor({ maxBytes = Infinity, maxEntries = Infinity, sizeOf = (v) => v?.length ?? 1 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.sizeOf = sizeOf;
    /** @type {Map<any, { value: any, size: number }>} */
    this._map = new Map();
    this._bytes = 0;
  }

  /**
   * Returns the cached value (marking it most recently used), or undefined.
   * @param {any} key
   */
  get(key) {
    const item = this._map.get(key);
    if (item === undefined) return undefined;
    this._map.delete(key);
    this._map.set(key, item);
    return item.value;
  }

  /**
   * Returns the cached value without touching its recency.
   * @param {any} key
   */
  peek(key) {
    return this._map.get(key)?.value;
  }

  /**
   * Stores a value. A value larger than the whole byte budget is not cached at all (caching it
   * would only flush everything else and then evict it immediately).
   * @param {any} key
   * @param {any} value
   * @returns {this}
   */
  set(key, value) {
    const size = Number(this.sizeOf(value)) || 0;
    this.delete(key);
    if (size > this.maxBytes || this.maxEntries < 1) return this;
    this._map.set(key, { value, size });
    this._bytes += size;
    this._evict();
    return this;
  }

  /**
   * @param {any} key
   * @returns {boolean}
   */
  has(key) {
    return this._map.has(key);
  }

  /**
   * @param {any} key
   * @returns {boolean} whether the key was present
   */
  delete(key) {
    const item = this._map.get(key);
    if (item === undefined) return false;
    this._map.delete(key);
    this._bytes -= item.size;
    return true;
  }

  /** Removes every entry. */
  clear() {
    this._map.clear();
    this._bytes = 0;
  }

  /** Number of cached entries. */
  get size() {
    return this._map.size;
  }

  /** Sum of sizeOf() over the cached entries. */
  get bytes() {
    return this._bytes;
  }

  /** Keys from least to most recently used. */
  keys() {
    return this._map.keys();
  }

  _evict() {
    while (this._map.size > 0 && (this._bytes > this.maxBytes || this._map.size > this.maxEntries)) {
      const oldest = this._map.keys().next().value;
      this.delete(oldest);
    }
  }
}
