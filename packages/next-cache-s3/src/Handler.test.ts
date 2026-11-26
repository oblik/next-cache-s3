import type { CacheEntry } from 'next/dist/server/lib/cache-handlers/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from './createHandler.js'
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
  const entry = await handler.get(key, [])
  if (!entry) return undefined
  const value = (await streamToBuffer(entry.value)).toString('utf-8')
  return { ...entry, value }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// `get` finds an entry either in this instance's LRU or, when another instance
// sharing the bucket wrote it, in storage. Expiry must apply to both.
describe.each([
  { source: 'the LRU', readerLruSize: undefined },
  { source: 'storage', readerLruSize: 0 },
])('time-based expiry, reading from $source', ({ readerLruSize }) => {
  let writer: Handler
  let reader: Handler

  beforeEach(() => {
    const storage = new MemoryStorage()
    writer = createHandler({ name: 'default', storage, buildId: '1' })
    reader =
      readerLruSize === undefined
        ? writer
        : createHandler({
            name: 'default',
            storage,
            buildId: '1',
            lruSize: readerLruSize,
          })
  })

  it('serves a fresh entry as-is', async () => {
    await writer.set('key', Promise.resolve(cacheEntry()))

    expect(await read(reader)).toMatchObject({
      value: 'value',
      revalidate: 60,
      expire: 300,
    })
  })

  // Unlike Next's built-in handler, which drops entries at `revalidate`
  // because in-memory entries aren't worth keeping stale. Storage is durable,
  // and the `use cache` wrapper serves an entry past its `revalidate` while it
  // regenerates it in the background, so readers never wait on a render.
  it('keeps serving an entry past revalidate, until expire', async () => {
    await writer.set('key', Promise.resolve(cacheEntry()))
    vi.advanceTimersByTime(61 * SECOND)

    // `revalidate` stays as stored: the wrapper compares it to `timestamp` to
    // decide on a background regeneration.
    expect(await read(reader)).toMatchObject({ value: 'value', revalidate: 60 })
  })

  it('serves an entry up to its exact expire time', async () => {
    await writer.set('key', Promise.resolve(cacheEntry()))
    vi.advanceTimersByTime(300 * SECOND)

    expect(await read(reader)).toMatchObject({ value: 'value' })
  })

  it('treats an entry as missing once past expire', async () => {
    await writer.set('key', Promise.resolve(cacheEntry()))
    vi.advanceTimersByTime(300 * SECOND + 1)

    expect(await read(reader)).toBeUndefined()
  })

  // The timestamp is when the render started, which can be well before the
  // entry reaches `set` (slow renders, a pending `set` awaited by readers).
  it('measures age from the entry timestamp, not from when it was stored', async () => {
    const timestamp = Date.now() - 290 * SECOND
    await writer.set('key', Promise.resolve(cacheEntry({ timestamp })))
    vi.advanceTimersByTime(11 * SECOND)

    expect(await read(reader)).toBeUndefined()
  })

  it("keeps an entry with the default profile's expire for years", async () => {
    await writer.set(
      'key',
      Promise.resolve(cacheEntry({ revalidate: 900, expire: INFINITE_CACHE }))
    )
    vi.advanceTimersByTime(5 * 365 * DAY)

    expect(await read(reader)).toMatchObject({ value: 'value' })
  })

  // A negative `expire` is how Next marks an entry as deleted, since the
  // handler interface has no `delete`. Next only does this in dev (its tiered
  // handler), but honoring it costs nothing and keeps us safe if wrapped.
  // @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
  it('treats a negative expire as deleted, however fresh the entry', async () => {
    await writer.set('key', Promise.resolve(cacheEntry({ expire: -1 })))

    expect(await read(reader)).toBeUndefined()
  })
})

// `cacheLife({ expire: 0 })` makes an entry dynamic: in production the wrapper
// regenerates it on every read and never serves the stored copy, so storing it
// would only cost a write. Next's built-in handler skips them too.
// @see https://github.com/vercel/next.js/blob/v16.3.4/packages/next/src/server/lib/cache-handlers/default.ts
describe('dynamic entries (expire: 0)', () => {
  let storage: MemoryStorage
  let handler: Handler

  beforeEach(() => {
    storage = new MemoryStorage()
    handler = createHandler({ name: 'default', storage, buildId: '1' })
  })

  it('are not written to storage', async () => {
    await handler.set('key', Promise.resolve(cacheEntry({ expire: 0 })))

    expect(storage.put).not.toHaveBeenCalled()
  })

  it('are not kept in the LRU', async () => {
    await handler.set('key', Promise.resolve(cacheEntry({ expire: 0 })))

    expect(await read(handler)).toBeUndefined()
  })

  it('are a miss for a get that was waiting on their pending set', async () => {
    let resolve!: (entry: CacheEntry) => void
    const pending = new Promise<CacheEntry>((r) => (resolve = r))
    const setting = handler.set('key', pending)
    const getting = read(handler)

    resolve(cacheEntry({ expire: 0 }))
    await setting

    expect(await getting).toBeUndefined()
  })
})
