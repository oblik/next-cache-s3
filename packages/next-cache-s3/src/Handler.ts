import type {
  CacheEntry,
  CacheHandler,
  Timestamp,
} from 'next/dist/server/lib/cache-handlers/types.js'
import { createHash } from 'node:crypto'
import type { TagsManager, TagsManifest } from './TagsManager.js'
import type { HandlerStorage } from './types.js'
import { decode, encode } from './utils/compress.js'
import { createLogger, type Logger } from './utils/debug.js'
import { LRUCache } from './utils/LRUCache.js'
import { replaceBuffers, reviveBuffers } from './utils/reviveBuffers.js'
import { streamFromBuffer, streamToBuffer } from './utils/streams.js'

type LRUCacheEntry = {
  entry: Omit<CacheEntry, 'value'>
  value: Buffer
  size: number
}

export interface HandlerOptions {
  name: string
  lruSize: number
  sticky: boolean
  compress: boolean
  base64: boolean
}

export class Handler implements CacheHandler {
  log: Logger

  lruCache?: LRUCache<LRUCacheEntry>

  constructor(
    protected buildId: string,
    protected storage: HandlerStorage,
    protected tagsManager: TagsManager,
    protected options: HandlerOptions
  ) {
    this.log = createLogger(`Handler/${this.options.name}`)

    if (this.options.lruSize) {
      this.log?.(`creating LRU cache with size ${this.options.lruSize} bytes`)
      this.lruCache = new LRUCache(
        this.options.lruSize,
        // Like Next's built-in handler, which also keeps empty values from
        // having a size of 0.
        // @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
        (v, key) => v.size + key.length,
        this.log ? (k: string) => this.log?.(`LRU: ${k} evicted`) : undefined
      )
    }
  }

  tags?: Readonly<TagsManifest>

  async refreshTags() {
    this.tags = await this.tagsManager.getTags()
  }

  /**
   * Leaves out the `softTags` parameter, which Next passes for handlers whose
   * `getExpiration` returns `Infinity` to mean "I'll check soft tags in `get`".
   * Ours returns a timestamp instead, so Next checks them itself. Checking
   * them here like `entry.tags` would be the way to give soft tags
   * stale-while-revalidate, at no extra storage reads since the manifest is in
   * memory, but there's no point while `revalidatePath` never marks them stale.
   */
  async get(cacheKey: string): Promise<undefined | CacheEntry> {
    const filename = this.keyToFilename(cacheKey)

    const entry = await this.findEntry(filename)
    if (!entry) {
      this.log?.(`get(${filename}): not found anywhere`)
      return undefined
    }

    // Next marks entries as deleted this way, since the handler interface has
    // no `delete`.
    // @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
    if (entry.expire < 0) {
      this.log?.(`get(${filename}): marked as deleted`)
      return undefined
    }

    // Next's built-in handler treats an entry as missing once it's past
    // `revalidate`, because it keeps entries in memory, where a stale one isn't
    // worth holding on to. We wait until `expire` instead: our entries persist
    // in storage, and when the `use cache` wrapper gets an entry past its
    // `revalidate`, it serves it while regenerating it in the background. So
    // readers get slightly stale data instead of waiting on a render.
    if (Date.now() > entry.timestamp + entry.expire * 1000) {
      this.log?.(`get(${filename}): expired`)
      return undefined
    }

    // An entry this old may have had a tag expire that has since been evicted
    // from the manifest, so its tags can no longer tell whether it's valid.
    if (Date.now() - entry.timestamp > this.tagsManager.maxEntryAgeMs) {
      this.log?.(`get(${filename}): older than the tags retention`)
      return undefined
    }

    if (this.hasExpiredTags(entry.tags, entry.timestamp)) {
      this.log?.(`get(${filename}): had an expired tag`)
      return undefined
    }

    if (this.hasStaledTags(entry.tags, entry.timestamp)) {
      this.log?.(`get(${filename}): had a staled tag`)
      entry.revalidate = -1
    }

    return entry
  }

  /**
   * Inspired by the example custom cache handler implementation by Next.
   * @see https://github.com/vercel/next.js/blob/6ef6e29db5ec78704af1ea05a16b233bb7faac7c/packages/next/src/server/lib/cache-handlers/default.ts#L68
   */
  pendingSets = new Map<string, Promise<CacheEntry>>()

  async findEntry(filename: string): Promise<CacheEntry | undefined> {
    const pendingPromise = this.pendingSets.get(filename)
    if (pendingPromise) {
      const entry = await pendingPromise

      // Not stored by `set`, so it's a miss like it would be after the set.
      if (isDynamic(entry)) return undefined

      this.log?.(`findEntry(${filename}): copying from pending stream`)
      const [streamCopy, value] = entry.value.tee()
      entry.value = streamCopy

      return { ...entry, value }
    }

    if (this.lruCache) {
      const cachedEntry = this.lruCache.get(filename)
      if (cachedEntry) {
        this.log?.(`findEntry(${filename}): returned from LRU cache`)
        return {
          ...cachedEntry.entry,
          value: streamFromBuffer(cachedEntry.value),
        }
      }
    }

    const body = await this.storage.get(filename)
    if (!body) {
      this.log?.(`findEntry(${filename}): no file content`)
      return undefined
    }

    const jsonString = this.options.compress
      ? await decode(body)
      : body.toString('utf-8')
    const json = JSON.parse(jsonString) as unknown

    if (!json || typeof json !== 'object' || !('value' in json)) {
      this.log?.(`findEntry(${filename}): missing value in JSON`)
      return undefined
    }

    const typedJson = reviveBuffers(json) as Omit<CacheEntry, 'value'> & {
      value: Buffer
    }

    if (this.lruCache) {
      const { value, ...metadata } = typedJson
      const size = value.byteLength
      this.lruCache.set(filename, { entry: metadata, value, size })
      this.log?.(
        `get(${filename}): saved ${size} bytes in LRU cache (${this.lruCache.currentSize} bytes total)`
      )
    }

    return { ...typedJson, value: streamFromBuffer(typedJson.value) }
  }

  async set(
    cacheKey: string,
    pendingEntry: Promise<CacheEntry>
  ): Promise<void> {
    const filename = this.keyToFilename(cacheKey)

    this.pendingSets.set(filename, pendingEntry)

    try {
      const entry = await pendingEntry

      if (isDynamic(entry)) {
        this.log?.(`set(${filename}): skipped dynamic entry`)
        return
      }

      /**
       * Like the Next.js implementation.
       * @see https://github.com/vercel/next.js/blob/6ef6e29db5ec78704af1ea05a16b233bb7faac7c/packages/next/src/server/lib/cache-handlers/default.ts#L177
       */
      const { value: originalStream, ...metadata } = entry
      const [streamCopy, valueStream] = originalStream.tee()
      entry.value = streamCopy

      const value = await streamToBuffer(valueStream)
      const storedValue = { ...metadata, value }

      if (this.lruCache) {
        const size = value.byteLength
        this.lruCache.set(filename, { entry: metadata, value, size })
        this.log?.(
          `set(${filename}): saved ${size} bytes in LRU cache (${this.lruCache.currentSize} bytes total)`
        )
      }

      const replacer = this.options.base64 ? replaceBuffers : undefined
      const json = JSON.stringify(storedValue, replacer)
      const body = this.options.compress
        ? await encode(json)
        : Buffer.from(json, 'utf-8')

      await this.storage.put(filename, body)
    } finally {
      this.pendingSets.delete(filename)
      this.log?.(`set(${filename}): deleted pending promise`)
    }
  }

  /**
   * Called with a request's soft tags, which `revalidatePath` expires. Next
   * treats every entry created at or before the returned timestamp as a miss,
   * so soft tags don't need checking in `get`. Since a single timestamp can
   * only mean "expired" and not "stale", only `expiresAt` is returned, as in
   * Next's built-in handler. That's enough, because `revalidatePath` sets
   * `expiresAt` and never `stalesAt`.
   * @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
   */
  async getExpiration(tags: string[]): Promise<Timestamp> {
    const now = Date.now()
    let expiration = 0

    for (const tag of tags) {
      const expiredAt = this.tags?.[tag]?.expiresAt
      if (typeof expiredAt !== 'number') continue

      // Next's built-in handler returns a future expiry as is, which turns off
      // caching for the path until then: after `revalidateTag('_N_T_/blog', {
      // expire: 60 })`, Next discards every entry older than 60s from now,
      // so entries regenerated in the meantime are discarded too, and **every
      // request re-renders**. To avoid this, we ignore the expiry until it
      // passes, which is how `hasExpiredTags` and Next's own `areTagsExpired`
      // treat regular tags.
      // Only a manual `revalidateTag` like the above gets here, since
      // `revalidatePath` always expires immediately.
      if (expiredAt > now) continue

      expiration = Math.max(expiration, expiredAt)
    }

    return expiration
  }

  async updateTags(
    tags: string[],
    durations?: { expire?: number }
  ): Promise<void> {
    this.log?.('updateTags:', tags, durations)
    const now = Date.now()
    const tagsCopy = { ...this.tags }

    for (const tag of tags) {
      const existingEntry = tagsCopy[tag]
      const newEntry = { ...existingEntry }

      if (durations) {
        newEntry.stalesAt = now

        if (durations.expire !== undefined) {
          newEntry.expiresAt = now + durations.expire * 1000
        }
      } else {
        newEntry.expiresAt = now
      }

      tagsCopy[tag] = newEntry
    }

    await this.tagsManager.putTags(tagsCopy)
  }

  protected keyToFilename(cacheKey: string) {
    // By default, Next makes the build ID part of the cache key, so that cache
    // keys can vary across deploys, even if the cached function's code and
    // arguments stay the same. By removing the ID, we make the keys constant
    // across deploys, as long as the related code and arguments stay the same.
    /**
     * @todo The other part of the key based on the function code is constant
     * across builds only as long as the `.next/cache` directory stays the same.
     * So if two distinct servers build the same code, the keys would still
     * differ and the cache won't be sticky.
     * @see next.js/packages/next/src/server/use-cache/use-cache-wrapper.ts:1489
     */
    if (this.options.sticky) cacheKey = cacheKey.replace(this.buildId, '')

    const keyHash = createHash('md5').update(cacheKey).digest('hex')
    let filename = `${this.options.name}/${keyHash}.json`

    if (!this.options.sticky) {
      filename =
        // Add a top-level `build` directory, so that artifacts don't flood the root
        // and make the manifest difficult to find.
        `build/` +
        // Then add the unique build ID, so that you can purge all artifacts
        // related to one specific build.
        `${this.buildId}/` +
        filename
    }

    if (this.options.compress) filename += '.br'

    return filename
  }

  protected hasExpiredTags(tags: string[], createdAt: Timestamp) {
    const now = Date.now()

    for (const tag of tags) {
      const entry = this.tags?.[tag]

      const expiredAt = entry?.expiresAt
      if (typeof expiredAt !== 'number') continue

      if (createdAt <= expiredAt && expiredAt <= now) return true
    }

    return false
  }

  protected hasStaledTags(tags: string[], createdAt: Timestamp) {
    for (const tag of tags) {
      const entry = this.tags?.[tag]

      const staledAt = entry?.stalesAt
      if (typeof staledAt !== 'number') continue

      if (createdAt <= staledAt) return true
    }

    return false
  }
}

/**
 * `cacheLife({ expire: 0 })`: the `use cache` wrapper regenerates these on every
 * read instead of serving the stored copy, so storing them is a wasted write.
 * @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
 */
function isDynamic(entry: CacheEntry) {
  return entry.expire === 0
}
