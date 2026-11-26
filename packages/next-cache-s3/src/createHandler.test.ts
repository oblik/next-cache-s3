import type { CacheEntry } from 'next/dist/server/lib/cache-handlers/types.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHandler } from './createHandler.js'
import type { HandlerStorage } from './types.js'
import { streamFromBuffer } from './utils/streams.js'

class MemoryStorage implements HandlerStorage {
  data = new Map<string, Buffer>()
  put = vi.fn(async (key: string, body: Buffer) => {
    this.data.set(key, body)
  })
  get = vi.fn(async (key: string) => this.data.get(key) ?? null)
}

function entry(): Promise<CacheEntry> {
  return Promise.resolve({
    value: streamFromBuffer(Buffer.from('value')),
    tags: [],
    stale: 0,
    timestamp: Date.now(),
    expire: 60,
    revalidate: 60,
  })
}

const manifestWrites = (storage: MemoryStorage) =>
  storage.put.mock.calls.filter(([key]) => key === 'tags-manifest.json')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('shares one tags manifest between handlers on the same storage', async () => {
  const storage = new MemoryStorage()
  const a = createHandler({ name: 'a', storage, buildId: '1' })
  const b = createHandler({ name: 'b', storage, buildId: '1' })

  await a.updateTags(['tag'])
  await b.updateTags(['tag'])
  await vi.runAllTimersAsync()

  expect(manifestWrites(storage)).toHaveLength(1)
})

it('keeps separate tags manifests for separate storages', async () => {
  const storageA = new MemoryStorage()
  const storageB = new MemoryStorage()
  const a = createHandler({ name: 'a', storage: storageA, buildId: '1' })
  const b = createHandler({ name: 'b', storage: storageB, buildId: '1' })

  await a.updateTags(['tag'])
  await b.updateTags(['tag'])
  await vi.runAllTimersAsync()

  expect(manifestWrites(storageA)).toHaveLength(1)
  expect(manifestWrites(storageB)).toHaveLength(1)
})

it('uses the given build ID in storage keys', async () => {
  const storage = new MemoryStorage()
  const handler = createHandler({ name: 'default', storage, buildId: 'abc' })

  await handler.set('key', entry())

  expect(storage.put).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^build\/abc\/default\/[0-9a-f]+\.json$/),
    expect.any(Buffer)
  )
})

it('reads the build ID from .next/BUILD_ID by default', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'next-cache-s3-'))
  try {
    await mkdir(join(cwd, '.next'))
    await writeFile(join(cwd, '.next', 'BUILD_ID'), 'from-file\n')
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)

    const storage = new MemoryStorage()
    await createHandler({ name: 'default', storage }).set('key', entry())

    expect(storage.put.mock.calls[0][0]).toMatch(/^build\/from-file\//)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
