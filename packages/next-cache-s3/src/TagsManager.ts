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

export class TagsManager {
  protected log = createLogger('TagsManager')

  protected manifest?: Readonly<TagsManifest>
  protected readPromise?: Promise<TagsManifest | undefined>
  protected loadedAt?: number

  constructor(
    protected storage: HandlerStorage,
    protected options: TagsManagerOptions
  ) {}

  /** Entries older than this are a miss, see `retentionMs`. */
  get maxEntryAgeMs() {
    return this.options.retentionMs
  }

  async getTags() {
    if (!this.manifest) return this.loadManifest()

    const now = Date.now()

    // Manifest is fresh; directly return it.
    if (now < this.loadedAt! + this.options.staleMs) {
      this.log?.('returning fresh manifest')
      return this.manifest
    }

    // Manifest is stale; load it **in the background**.
    if (now < this.loadedAt! + this.options.expireMs) {
      this.log?.('revalidating stale manifest')
      this.loadManifest()
      return this.manifest
    }

    // Manifest is expired.
    return this.loadManifest()
  }

  async putTags(tags: TagsManifest) {
    this.updateManifest(tags)
    this.scheduleUpdate()
  }

  protected async loadManifest() {
    if (this.readPromise) return this.readPromise

    this.readPromise = this.fetchManifest()
    const manifest = await this.readPromise
    if (manifest) this.updateManifest(manifest)
    this.readPromise = undefined
    return this.manifest
  }

  /** @todo Add Brotli compression here as well? */
  protected async fetchManifest(): Promise<TagsManifest | undefined> {
    this.log?.('fetching manifest')
    const body = await this.storage.get('tags-manifest.json')
    if (!body) return

    this.loadedAt = Date.now()
    const jsonString = body.toString('utf-8')
    return JSON.parse(jsonString)
  }

  protected async updateManifest(tags: TagsManifest) {
    const now = Date.now()
    const newManifest = Object.assign({}, this.manifest || {}, tags)
    const evictAfterMs = this.options.retentionMs + EVICTION_MARGIN_MS
    let dirty = false

    for (const tagName in newManifest) {
      const tag = newManifest[tagName]
      const msSinceStaled = tag.stalesAt ? now - tag.stalesAt : Infinity
      const msSinceExpired = tag.expiresAt ? now - tag.expiresAt : Infinity
      if (msSinceStaled >= evictAfterMs && msSinceExpired >= evictAfterMs) {
        this.log?.(`evicting tag from manifest: ${tagName}`)
        delete newManifest[tagName]
        dirty = true
      }
    }

    this.manifest = newManifest
    if (dirty) this.scheduleUpdate()
  }

  /**
   * Prevents performing unnecessary updates by scheduling a single update at
   * the end of the call stack. Otherwise, if you have multiple cache handlers
   * registered, each one will try to update the tags manifest immediately,
   * resulting in one update per handler.
   */
  protected scheduleUpdate() {
    if (this.scheduledTimer) {
      this.log?.('cancelling scheduled update')
      clearTimeout(this.scheduledTimer)
    }

    this.log?.('scheduling update')

    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = undefined

      const json = JSON.stringify(this.manifest)
      const body = Buffer.from(json, 'utf-8')

      this.log?.('writing manifest')
      this.storage.put('tags-manifest.json', body)
    }, 0)
  }

  protected scheduledTimer?: NodeJS.Timeout
}
