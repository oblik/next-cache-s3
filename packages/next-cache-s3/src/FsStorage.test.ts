// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsStorage } from './FsStorage.js'

let root: string
let storage: FsStorage

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cache-handler-fs-'))
  storage = new FsStorage({ dir: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function body(key: string) {
  const object = await storage.get(key)
  if (!object) throw new Error('no object')
  return object.body
}

describe('get/put', () => {
  it('round-trips a nested key, creating parent directories', async () => {
    const key = 'build/x/page/123/us/en/banner_ids=&eea=false.json'
    await storage.put(key, Buffer.from('{"a":1}'))
    expect(await body(key)).toEqual(Buffer.from('{"a":1}'))
  })

  it('returns null for a missing key', async () => {
    expect(await storage.get('build/x/missing.json')).toBeNull()
  })

  it('overwrites an existing key without leaving temp files', async () => {
    const key = 'build/x/page/1.json'
    await storage.put(key, Buffer.from('first'))
    await storage.put(key, Buffer.from('second'))
    expect(await body(key)).toEqual(Buffer.from('second'))
    expect(await readdir(join(root, 'build/x/page'))).toEqual(['1.json'])
  })

  it('refuses keys that escape the root', async () => {
    await expect(storage.get('../outside.json')).rejects.toThrow(/escapes/)
  })
})

describe('ETags', () => {
  const key = 'tags-manifest.json'

  it('returns the same ETag from put and get', async () => {
    const put = await storage.put(key, Buffer.from('a'))
    if (put === 'precondition-failed') throw new Error('unexpected')
    expect(await storage.get(key)).toMatchObject(put)
  })

  it('writes with ifMatch only while the ETag matches', async () => {
    const first = await storage.put(key, Buffer.from('a'))
    if (first === 'precondition-failed') throw new Error('unexpected')
    await storage.put(key, Buffer.from('b'))

    expect(
      await storage.put(key, Buffer.from('c'), { ifMatch: first.etag })
    ).toBe('precondition-failed')
    expect(await body(key)).toEqual(Buffer.from('b'))
  })

  it("writes with ifNoneMatch only if the key doesn't exist", async () => {
    expect(
      await storage.put(key, Buffer.from('a'), { ifNoneMatch: '*' })
    ).toHaveProperty('etag')
    expect(await storage.put(key, Buffer.from('b'), { ifNoneMatch: '*' })).toBe(
      'precondition-failed'
    )
    expect(await body(key)).toEqual(Buffer.from('a'))
  })
})
