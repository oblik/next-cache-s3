/**
 * Size-bounded LRU cache. Vendored to avoid a runtime import from
 * `next/dist/...`, whose internals can change in any release. Next's own
 * `LRUCache` (`next/dist/server/lib/lru-cache`) has the same API and is a
 * drop-in alternative.
 * @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/lru-cache.ts
 */
export class LRUCache<T> {
  // A `Map` iterates in insertion order, so re-inserting a key on access makes
  // the first key the least recently used one.
  protected cache = new Map<string, { data: T; size: number }>()
  protected totalSize = 0

  constructor(
    protected maxSize: number,
    protected calculateSize: (value: T, key: string) => number,
    protected onEvict?: (key: string, value: T) => void
  ) {}

  /** Returns `false` when the item alone is larger than the cache. */
  set(key: string, value: T): boolean {
    const size = this.calculateSize(value, key)

    // Items without a size would never be evicted.
    if (!(size > 0)) {
      throw new Error(`LRUCache: size must be > 0, got ${size}`)
    }

    if (size > this.maxSize) return false

    this.remove(key)
    this.cache.set(key, { data: value, size })
    this.totalSize += size

    for (const [oldestKey, oldest] of this.cache) {
      if (this.totalSize <= this.maxSize) break
      this.remove(oldestKey)
      this.onEvict?.(oldestKey, oldest.data)
    }

    return true
  }

  get(key: string): T | undefined {
    const node = this.cache.get(key)
    if (!node) return undefined
    this.cache.delete(key)
    this.cache.set(key, node)
    return node.data
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  /** Doesn't call `onEvict`, since it's not an eviction. */
  remove(key: string): void {
    const node = this.cache.get(key)
    if (!node) return
    this.cache.delete(key)
    this.totalSize -= node.size
  }

  get size(): number {
    return this.cache.size
  }

  get currentSize(): number {
    return this.totalSize
  }
}
