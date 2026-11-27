import type { HandlerStorage } from './types.js'
import { createLogger } from './utils/debug.js'

export interface TagsManifest {
  [tagName: string]: Readonly<{
    /** Timestamp at which the resource tagged with this tag becomes expired. */
    expiresAt?: number

    /** Timestamp at which the resource tagged with this tag becomes stale. */
    stalesAt?: number
  }>
}

export interface TagsManagerOptions {
  /** How long a loaded manifest is used before it's refreshed in the background. */
  staleMs: number
  /** How long a loaded manifest can be used at all, before a refresh blocks. */
  expireMs: number
  /**
   * How long a tag stays in the manifest after both its `expiresAt` and
   * `stalesAt` have passed, which keeps the manifest from growing forever.
   * Entries older than this are a miss, since an entry created before its
   * tag's expiry would otherwise become valid again once the tag is gone.
   * `Infinity` keeps tags forever and never caps entries.
   */
  retentionMs: number
}

// Low, so that invalidations from other instances apply almost immediately. The
// cost is a manifest read about every `staleMs` under traffic, and a blocking
// read on the first request after `expireMs` without traffic.
export const defaultTagsManagerOptions: TagsManagerOptions = {
  staleMs: 500,
  expireMs: 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
}

// Tags are evicted this long after `retentionMs`, while entries are capped at
// exactly `retentionMs`. Otherwise an instance whose clock runs ahead could
// evict a tag while another instance still serves an entry created before it.
const EVICTION_MARGIN_MS = 60 * 1000

const MANIFEST_KEY = 'tags-manifest.json'

// Each failed attempt means another instance wrote the manifest in between, so
// running out takes sustained contention. The updates aren't dropped then, but
// written along with the next update or after the next read.
const MAX_WRITE_ATTEMPTS = 5
const WRITE_BACKOFF_MS = 50

/** A `revalidateTag`, `updateTag` or `revalidatePath` call. */
export interface TagsUpdate {
  tags: string[]
  durations?: { expire?: number }
  at: number
}

interface StoredManifest {
  manifest: TagsManifest
  etag: string
}

/**
 * Keeps one copy of the tags manifest that all instances share in storage.
 * Local updates are queued and replayed on top of the stored manifest, instead
 * of being merged into a copy of it, so that when another instance writes in
 * between, its changes and ours both end up in storage, as if the two writes
 * had happened one after the other.
 */
export class TagsManager {
  protected log = createLogger('TagsManager')

  /** What's in storage as of the last read or write; `null` if nothing. */
  protected stored?: StoredManifest | null
  /** Updates not written to storage yet. */
  protected pending: TagsUpdate[] = []
  /** `stored` with `pending` applied and old tags evicted. */
  protected manifest: Readonly<TagsManifest> = {}
  protected loadedAt?: number

  protected readPromise?: Promise<void>
  protected writePromise?: Promise<void>
  protected writeAgain = false

  constructor(
    protected storage: HandlerStorage,
    protected options: TagsManagerOptions
  ) {}

  /** Entries older than this are a miss, see `retentionMs`. */
  get maxEntryAgeMs() {
    return this.options.retentionMs
  }

  async getTags(): Promise<Readonly<TagsManifest>> {
    if (this.loadedAt === undefined) {
      await this.load()
      return this.manifest
    }

    const now = Date.now()

    // Manifest is fresh; directly return it.
    if (now < this.loadedAt + this.options.staleMs) {
      this.log?.('returning fresh manifest')
      return this.manifest
    }

    // Manifest is stale; load it **in the background**.
    if (now < this.loadedAt + this.options.expireMs) {
      this.log?.('revalidating stale manifest')
      this.load().catch((error) => this.log?.('background read failed', error))
      return this.manifest
    }

    // Manifest is expired.
    await this.load()
    return this.manifest
  }

  /**
   * Applies the update to the in-memory manifest right away, and writes it to
   * storage at the end of the call stack.
   */
  updateTags(tags: string[], durations?: { expire?: number }) {
    this.pending.push({ tags, durations, at: Date.now() })
    this.rebuild()
    this.scheduleWrite()
  }

  protected load(): Promise<void> {
    this.readPromise ??= this.read().finally(() => {
      this.readPromise = undefined
    })
    return this.readPromise
  }

  /** @todo Add Brotli compression here as well? */
  protected async read() {
    this.log?.('fetching manifest')
    const object = await this.storage.get(MANIFEST_KEY)
    this.loadedAt = Date.now()
    this.stored = object && {
      manifest: JSON.parse(object.body.toString('utf-8')),
      etag: object.etag,
    }
    this.rebuild()

    // Either a previous write failed, or tags need evicting.
    if (!this.writePromise && this.needsWrite()) this.scheduleWrite()
  }

  protected rebuild() {
    this.manifest = this.build(this.stored?.manifest)
  }

  protected build(stored: TagsManifest = {}): TagsManifest {
    const manifest = { ...stored }
    for (const update of this.pending) applyUpdate(manifest, update)

    const now = Date.now()
    const evictAfterMs = this.options.retentionMs + EVICTION_MARGIN_MS

    for (const tagName in manifest) {
      const tag = manifest[tagName]
      const msSinceStaled = tag.stalesAt ? now - tag.stalesAt : Infinity
      const msSinceExpired = tag.expiresAt ? now - tag.expiresAt : Infinity
      if (msSinceStaled >= evictAfterMs && msSinceExpired >= evictAfterMs) {
        this.log?.(`evicting tag from manifest: ${tagName}`)
        delete manifest[tagName]
      }
    }

    return manifest
  }

  protected needsWrite() {
    return (
      this.pending.length > 0 ||
      !isSameManifest(this.manifest, this.stored?.manifest ?? {})
    )
  }

  /**
   * Prevents performing unnecessary updates by scheduling a single update at
   * the end of the call stack. Otherwise, if you have multiple cache handlers
   * registered, each one will try to update the tags manifest immediately,
   * resulting in one update per handler.
   */
  protected scheduleWrite() {
    if (this.scheduledTimer) {
      this.log?.('cancelling scheduled update')
      clearTimeout(this.scheduledTimer)
    }

    this.log?.('scheduling update')

    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = undefined
      this.write()
    }, 0)
  }

  protected scheduledTimer?: NodeJS.Timeout

  /** Runs one write at a time, and another after it if one was requested. */
  protected write() {
    if (this.writePromise) {
      this.writeAgain = true
      return
    }

    this.writePromise = this.tryWrite()
      .catch((error) => {
        // Not thrown, since nothing awaits the write and a failure would crash
        // the process. The pending updates are kept and written later.
        console.error('[next-cache-s3] failed to write tags manifest:', error)
      })
      .finally(() => {
        this.writePromise = undefined
        if (this.writeAgain) {
          this.writeAgain = false
          this.write()
        }
      })
  }

  protected async tryWrite() {
    for (let attempt = 1; ; attempt++) {
      if (this.stored === undefined) await this.load()
      const stored = this.stored
      if (stored === undefined) throw new Error('manifest could not be read')

      const written = this.pending.length
      const manifest = this.build(stored?.manifest)

      // Another instance already wrote the same, e.g. evicted the same tags.
      if (isSameManifest(manifest, stored?.manifest ?? {})) {
        this.log?.('manifest unchanged, skipping write')
        this.pending.splice(0, written)
        this.rebuild()
        return
      }

      this.log?.('writing manifest')
      const body = Buffer.from(JSON.stringify(manifest), 'utf-8')
      const result = await this.storage.put(
        MANIFEST_KEY,
        body,
        stored ? { ifMatch: stored.etag } : { ifNoneMatch: '*' }
      )

      if (result !== 'precondition-failed') {
        this.stored = { manifest, etag: result.etag }
        this.loadedAt = Date.now()
        // Updates made during the write stay pending for the next one.
        this.pending.splice(0, written)
        this.rebuild()
        // Tags may have become due for eviction while the write was in flight.
        if (this.needsWrite()) this.writeAgain = true
        return
      }

      if (attempt === MAX_WRITE_ATTEMPTS) {
        throw new Error(`gave up after ${attempt} conflicting writes`)
      }

      this.log?.(`manifest changed in storage, retrying (attempt ${attempt})`)
      // Jitter keeps instances that conflicted once from conflicting again.
      await sleep(Math.random() * WRITE_BACKOFF_MS * attempt)
      await this.load()
    }
  }
}

/**
 * Mirrors `updateTags` of Next's built-in handler.
 * @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
 */
function applyUpdate(manifest: TagsManifest, update: TagsUpdate) {
  for (const tag of update.tags) {
    const newEntry = { ...manifest[tag] }

    if (update.durations) {
      newEntry.stalesAt = update.at

      if (update.durations.expire !== undefined) {
        newEntry.expiresAt = update.at + update.durations.expire * 1000
      }
    } else {
      newEntry.expiresAt = update.at
    }

    manifest[tag] = newEntry
  }
}

function isSameManifest(a: TagsManifest, b: TagsManifest) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false

  return keys.every(
    (tag) =>
      b[tag] &&
      a[tag].stalesAt === b[tag].stalesAt &&
      a[tag].expiresAt === b[tag].expiresAt
  )
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
