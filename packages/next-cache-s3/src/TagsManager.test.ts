import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from './createHandler.js'
import {
  defaultTagsManagerOptions,
  TagsManager,
  type TagsManifest,
} from './TagsManager.js'
import { MemoryStorage } from './testing/MemoryStorage.js'

const KEY = 'tags-manifest.json'
const { expireMs } = defaultTagsManagerOptions

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * Each instance plays a server: its own storage object and manager, over data
 * shared with the others like a bucket.
 */
function instances(count: number) {
  const data = new Map<string, Buffer>()
  return Array.from({ length: count }, () => {
    const storage = new MemoryStorage()
    storage.data = data
    const manager = new TagsManager(storage, defaultTagsManagerOptions)
    return { storage, manager }
  })
}

function stored(storage: MemoryStorage): TagsManifest | undefined {
  const body = storage.data.get(KEY)
  return body ? JSON.parse(body.toString('utf-8')) : undefined
}

describe('concurrent writes', () => {
  it('keeps the updates of two instances that wrote the first manifest', async () => {
    const [a, b] = instances(2)
    await a.manager.getTags()
    await b.manager.getTags()

    a.manager.updateTags(['a'])
    b.manager.updateTags(['b'])
    await vi.runAllTimersAsync()

    expect(stored(a.storage)).toEqual({
      a: { expiresAt: expect.any(Number) },
      b: { expiresAt: expect.any(Number) },
    })
  })

  it('keeps the updates of two instances that wrote over an older manifest', async () => {
    const [a, b] = instances(2)
    a.manager.updateTags(['old'])
    await vi.runAllTimersAsync()
    await a.manager.getTags()
    await b.manager.getTags()

    a.manager.updateTags(['a'])
    b.manager.updateTags(['b'])
    await vi.runAllTimersAsync()

    expect(Object.keys(stored(a.storage)!).sort()).toEqual(['a', 'b', 'old'])
  })

  // Merging by the later timestamp would keep the far-future `expiresAt` of
  // the `revalidateTag`, postponing the `updateTag` by an hour.
  it('applies a conflicting update after the one already written', async () => {
    const [a, b] = instances(2)
    await a.manager.getTags()
    await b.manager.getTags()

    a.manager.updateTags(['x'], { expire: 3600 })
    await vi.runAllTimersAsync()
    const updatedAt = Date.now()
    b.manager.updateTags(['x'])
    await vi.runAllTimersAsync()

    expect(stored(a.storage)!.x.expiresAt).toBe(updatedAt)
  })

  it('gives up after repeated conflicts, and writes after the next read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const [a] = instances(1)
    await a.manager.getTags()
    for (let i = 0; i < 5; i++) {
      a.storage.put.mockResolvedValueOnce('precondition-failed')
    }

    a.manager.updateTags(['a'])
    await vi.runAllTimersAsync()
    expect(stored(a.storage)).toBeUndefined()
    expect(error).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(expireMs)
    await a.manager.getTags()
    await vi.runAllTimersAsync()
    expect(stored(a.storage)).toHaveProperty('a')
  })

  it('logs a failing write instead of throwing, and retries after the next read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const [a] = instances(1)
    await a.manager.getTags()
    a.storage.put.mockRejectedValueOnce(new Error('network'))

    a.manager.updateTags(['a'])
    await vi.runAllTimersAsync()
    expect(error).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(expireMs)
    await a.manager.getTags()
    await vi.runAllTimersAsync()
    expect(stored(a.storage)).toHaveProperty('a')
  })
})

describe('reads', () => {
  it('reads again after a failed read', async () => {
    const [a] = instances(1)
    a.storage.get.mockRejectedValueOnce(new Error('network'))

    await expect(a.manager.getTags()).rejects.toThrow('network')
    await expect(a.manager.getTags()).resolves.toEqual({})
  })
})

// The handler's `tags` is a snapshot from its last `refreshTags`, which can
// predate an update another instance made since.
it("doesn't write back a handler's stale copy of a tag", async () => {
  const [a, b] = instances(2)
  const handler = createHandler({
    name: 'default',
    storage: a.storage,
    buildId: '1',
  })
  b.manager.updateTags(['x'], {})
  await vi.runAllTimersAsync()
  await handler.refreshTags()

  const expiredAt = Date.now()
  b.manager.updateTags(['x'])
  await vi.runAllTimersAsync()

  // The handler gets the stale copy without `expiresAt`, while its manager
  // reads the newer manifest in the background.
  vi.advanceTimersByTime(defaultTagsManagerOptions.staleMs)
  await handler.refreshTags()
  await vi.runAllTimersAsync()
  await handler.updateTags(['y'])
  await vi.runAllTimersAsync()

  expect(stored(a.storage)!.x.expiresAt).toBe(expiredAt)
})
