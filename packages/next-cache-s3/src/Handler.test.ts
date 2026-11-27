import type { CacheEntry } from 'next/dist/server/lib/cache-handlers/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler, type CreateHandlerOptions } from './createHandler.js'
import type { Handler } from './Handler.js'
import { MemoryStorage } from './testing/MemoryStorage.js'
import { streamFromBuffer, streamToBuffer } from './utils/streams.js'

const SECOND = 1000
const DAY = 24 * 60 * 60 * SECOND

// The `expire` of the `default` cacheLife profile. Next means it as "never",
// but it's finite, so it survives the JSON round trip through storage.
// @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/lib/constants.ts
const INFINITE_CACHE = 0xfffffffe

type EntryOverrides = Partial<Omit<CacheEntry, 'value'>> & { value?: string }

function cacheEntry({
  value = 'value',
  ...overrides
}: EntryOverrides = {}): CacheEntry {
  return {
    value: streamFromBuffer(Buffer.from(value)),
    tags: [],
    stale: 0,
    timestamp: Date.now(),
    revalidate: 60,
    expire: 300,
    ...overrides,
  }
}

async function read(handler: Handler, key = 'key') {
  const entry = await handler.get(key)
  if (!entry) return undefined
  const value = (await streamToBuffer(entry.value)).toString('utf-8')
  return { ...entry, value }
}

function setup(options: Partial<CreateHandlerOptions> = {}) {
  const storage = new MemoryStorage()
  const handler = createHandler({
    name: 'default',
    storage,
    buildId: '1',
    ...options,
  })
  return { storage, handler }
}

/**
 * A second handler over the same data with its own storage object, so it
 * shares neither the LRU nor the in-memory manifest, like another server.
 */
function otherInstance(storage: MemoryStorage) {
  const otherStorage = new MemoryStorage()
  otherStorage.data = storage.data
  return createHandler({
    name: 'default',
    storage: otherStorage,
    buildId: '1',
    lruSize: 0,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Each option changes how entries are encoded in storage, so each has to read
// back what it wrote. Binary bytes catch an encoding that only works for text.
describe.each([
  { compress: false, base64: false },
  { compress: true, base64: false },
  { compress: false, base64: true },
])('storage round trip with %o', (options) => {
  it('reads back the entry another instance wrote', async () => {
    const { storage, handler } = setup(options)
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
    const entry = { ...cacheEntry(), value: streamFromBuffer(bytes) }
    await handler.set('key', Promise.resolve(entry))

    const other = createHandler({
      name: 'default',
      storage,
      buildId: '1',
      lruSize: 0,
      ...options,
    })
    const read = await other.get('key')

    expect(await streamToBuffer(read!.value)).toEqual(bytes)
    expect(read).toMatchObject({ revalidate: 60, expire: 300 })
  })
})

// Read from storage rather than the LRU, since that's where entries written by
// other instances come from, and the expiry logic is the same for both.
describe('time-based expiry', () => {
  let handler: Handler
  let reader: Handler

  beforeEach(() => {
    const instance = setup()
    handler = instance.handler
    reader = otherInstance(instance.storage)
  })

  // Unlike Next's built-in handler, which drops entries at `revalidate`
  // because in-memory entries aren't worth keeping stale. Storage is durable,
  // and the `use cache` wrapper serves an entry past its `revalidate` while it
  // regenerates it in the background, so readers never wait on a render.
  it('keeps serving an entry past revalidate, until expire', async () => {
    await handler.set('key', Promise.resolve(cacheEntry()))
    vi.advanceTimersByTime(61 * SECOND)

    // `revalidate` stays as stored: the wrapper compares it to `timestamp` to
    // decide on a background regeneration.
    expect(await read(reader)).toMatchObject({ value: 'value', revalidate: 60 })
  })

  it('treats an entry as missing once past expire', async () => {
    await handler.set('key', Promise.resolve(cacheEntry()))
    vi.advanceTimersByTime(301 * SECOND)

    expect(await read(reader)).toBeUndefined()
  })

  // The timestamp is when the render started, which can be well before the
  // entry reaches `set` (slow renders, a pending `set` awaited by readers).
  it('measures age from the entry timestamp, not from when it was stored', async () => {
    const timestamp = Date.now() - 290 * SECOND
    await handler.set('key', Promise.resolve(cacheEntry({ timestamp })))
    vi.advanceTimersByTime(11 * SECOND)

    expect(await read(reader)).toBeUndefined()
  })
})

// `cacheLife({ expire: 0 })` makes an entry dynamic: in production the wrapper
// regenerates it on every read and never serves the stored copy, so storing it
// would only cost a write. Next's built-in handler skips them too.
// @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
describe('dynamic entries (expire: 0)', () => {
  it('are not stored', async () => {
    const { storage, handler } = setup()
    await handler.set('key', Promise.resolve(cacheEntry({ expire: 0 })))

    expect(storage.put).not.toHaveBeenCalled()
    expect(await read(handler)).toBeUndefined()
  })

  it('are a miss for a get that was waiting on their pending set', async () => {
    const { handler } = setup()
    let resolve!: (entry: CacheEntry) => void
    const pending = new Promise<CacheEntry>((r) => (resolve = r))
    const setting = handler.set('key', pending)
    const getting = read(handler)

    resolve(cacheEntry({ expire: 0 }))
    await setting

    expect(await getting).toBeUndefined()
  })
})

// `revalidateTag(tag, profile)` marks a tag stale, and `updateTag(tag)` or
// `revalidateTag(tag, { expire: 0 })` expires it.
describe('tags', () => {
  let storage: MemoryStorage
  let handler: Handler

  beforeEach(async () => {
    ;({ storage, handler } = setup())
    await handler.refreshTags()
    await handler.set(
      'key',
      Promise.resolve(cacheEntry({ tags: ['post'], expire: INFINITE_CACHE }))
    )
    vi.advanceTimersByTime(SECOND)
  })

  async function revalidate(tags: string[], durations?: { expire?: number }) {
    await handler.updateTags(tags, durations)
    await handler.refreshTags()
  }

  it('treats an entry as missing once one of its tags expired', async () => {
    await revalidate(['post'])

    expect(await read(handler)).toBeUndefined()
  })

  // `revalidate: -1` makes the wrapper serve the entry while it regenerates it.
  it('serves an entry with a stale tag, marked for regeneration', async () => {
    await revalidate(['post'], {})

    expect(await read(handler)).toMatchObject({
      value: 'value',
      revalidate: -1,
    })
  })

  it('serves an entry created after its tag expired', async () => {
    await revalidate(['post'])
    vi.advanceTimersByTime(SECOND)
    await handler.set(
      'key',
      Promise.resolve(cacheEntry({ tags: ['post'], value: 'new' }))
    )

    expect(await read(handler)).toMatchObject({ value: 'new', revalidate: 60 })
  })

  it('sees an expiry made by another instance sharing the bucket', async () => {
    const other = otherInstance(storage)
    await other.refreshTags()
    await other.updateTags(['post'])
    await vi.advanceTimersByTimeAsync(0) // Runs the scheduled manifest write.

    vi.advanceTimersByTime(10 * SECOND) // Ages the handler's loaded manifest.
    await handler.refreshTags()

    expect(await read(handler)).toBeUndefined()
  })
})

// Next derives "soft" tags from the route of each request, and
// `revalidatePath` expires them. Next then asks `getExpiration` when the
// request's soft tags last expired, and discards entries created before that.
describe('soft tags (getExpiration)', () => {
  const softTags = ['_N_T_/layout', '_N_T_/blog/layout', '_N_T_/blog/hello']

  let storage: MemoryStorage
  let handler: Handler

  beforeEach(async () => {
    ;({ storage, handler } = setup())
    await handler.refreshTags()
  })

  async function revalidate(tags: string[], durations?: { expire?: number }) {
    await handler.updateTags(tags, durations)
    await handler.refreshTags()
  }

  it('is the time revalidatePath expired one of the tags', async () => {
    const revalidatedAt = Date.now()
    await revalidate(['_N_T_/blog/hello'])
    vi.advanceTimersByTime(10 * SECOND)

    expect(await handler.getExpiration(softTags)).toBe(revalidatedAt)
  })

  it('is the latest expiry among the tags', async () => {
    await revalidate(['_N_T_/blog/hello'])
    vi.advanceTimersByTime(10 * SECOND)
    const latest = Date.now()
    await revalidate(['_N_T_/layout'])
    vi.advanceTimersByTime(10 * SECOND)

    expect(await handler.getExpiration(softTags)).toBe(latest)
  })

  // Returning the future expiry right away would make Next discard every entry
  // regenerated before it, which turns off caching for the path until then.
  it('ignores an expiry until it passes', async () => {
    const revalidatedAt = Date.now()
    await revalidate(['_N_T_/blog/hello'], { expire: 60 })

    expect(await handler.getExpiration(softTags)).toBe(0)

    vi.advanceTimersByTime(60 * SECOND)
    expect(await handler.getExpiration(softTags)).toBe(
      revalidatedAt + 60 * SECOND
    )
  })

  it('sees a revalidatePath made by another instance sharing the bucket', async () => {
    const other = otherInstance(storage)

    // If the bucket had no manifest yet, `other` would have nothing loaded and
    // would fetch on every refresh anyway. So it loads one first, and the test
    // checks that it replaces that copy once it's out of date.
    await revalidate(['unrelated'])
    await vi.advanceTimersByTimeAsync(0) // Runs the scheduled manifest write.
    await other.refreshTags()

    const revalidatedAt = Date.now()
    await revalidate(['_N_T_/blog/hello'])
    // Runs the scheduled write, and ages `other`'s copy past the manager's
    // `expireMs`, so its next refresh refetches instead of using it.
    vi.advanceTimersByTime(10 * SECOND)
    await other.refreshTags()

    expect(await other.getExpiration(softTags)).toBe(revalidatedAt)
  })
})

// Tags are evicted from the manifest `retentionMs` after they expire, so an
// entry created before that expiry would become valid again. Capping entries
// at the same age makes sure none is still around by then.
describe('tags retention', () => {
  const RETENTION = 7 * DAY
  // Eviction waits a minute past the retention, to allow for clock skew.
  const EVICTION = RETENTION + 60 * SECOND

  function manifest(storage: MemoryStorage) {
    const body = storage.data.get('tags-manifest.json')
    return body ? JSON.parse(body.toString('utf-8')) : undefined
  }

  const longLived = { revalidate: 900, expire: INFINITE_CACHE }

  it('treats an entry older than the retention as missing', async () => {
    const { handler } = setup({ tags: { retentionMs: RETENTION } })
    await handler.set('key', Promise.resolve(cacheEntry(longLived)))
    vi.advanceTimersByTime(RETENTION + 1)

    expect(await read(handler)).toBeUndefined()
  })

  it('never lets an evicted tag revive an entry', async () => {
    const { storage, handler } = setup({ tags: { retentionMs: RETENTION } })
    await handler.refreshTags()
    await handler.set(
      'key',
      Promise.resolve(cacheEntry({ ...longLived, tags: ['post'] }))
    )
    await handler.updateTags(['post'])
    await handler.refreshTags()
    expect(await read(handler)).toBeUndefined()

    // Eviction happens when the manifest is next loaded, which the refresh
    // does once the loaded copy is out of date.
    vi.advanceTimersByTime(EVICTION)
    await handler.refreshTags()
    await vi.advanceTimersByTimeAsync(0) // Runs the scheduled manifest write.

    expect(manifest(storage)).not.toHaveProperty('post')
    expect(await read(handler)).toBeUndefined()
  })

  // For sites with few tags, where the manifest never gets big.
  it('keeps entries and tags forever with an infinite retention', async () => {
    const { storage, handler } = setup({ tags: { retentionMs: Infinity } })
    await handler.refreshTags()
    await handler.updateTags(['other'])
    await handler.set('key', Promise.resolve(cacheEntry(longLived)))

    vi.advanceTimersByTime(5 * 365 * DAY)
    await handler.refreshTags()
    await vi.advanceTimersByTimeAsync(0)

    expect(await read(handler)).toMatchObject({ value: 'value' })
    expect(manifest(storage)).toHaveProperty('other')
  })
})

// Next rethrows handler errors, so a throwing handler fails the request.
describe('failing open', () => {
  let error: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('treats a failing storage read as a miss', async () => {
    const { storage, handler } = setup({ lruSize: 0 })
    storage.get.mockRejectedValueOnce(new Error('network'))

    expect(await handler.get('key')).toBeUndefined()
    expect(error).toHaveBeenCalledOnce()
  })

  it('treats a corrupt entry as a miss', async () => {
    const { storage, handler } = setup({ lruSize: 0 })
    await handler.set('key', Promise.resolve(cacheEntry()))
    for (const key of storage.data.keys()) {
      storage.data.set(key, Buffer.from('{"value":'))
    }

    expect(await handler.get('key')).toBeUndefined()
  })

  it('resolves set when the storage write fails', async () => {
    const { storage, handler } = setup()
    storage.put.mockRejectedValueOnce(new Error('network'))

    await expect(
      handler.set('key', Promise.resolve(cacheEntry()))
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledOnce()
  })

  it('resolves set and a waiting get when the render fails', async () => {
    const { handler } = setup()
    let reject!: (error: Error) => void
    const pending = new Promise<CacheEntry>((_, r) => (reject = r))
    const setting = handler.set('key', pending)
    const getting = handler.get('key')

    reject(new Error('render failed'))

    await expect(setting).resolves.toBeUndefined()
    await expect(getting).resolves.toBeUndefined()
  })

  it('keeps the last manifest when a refresh fails', async () => {
    const { storage, handler } = setup()
    await handler.refreshTags()
    await handler.set('key', Promise.resolve(cacheEntry({ tags: ['post'] })))
    await handler.updateTags(['post'])
    await handler.refreshTags()

    vi.advanceTimersByTime(10 * SECOND)
    storage.get.mockRejectedValueOnce(new Error('network'))
    await expect(handler.refreshTags()).resolves.toBeUndefined()

    expect(await read(handler)).toBeUndefined()
  })
})
