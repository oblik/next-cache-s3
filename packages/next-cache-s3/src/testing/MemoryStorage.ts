import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import type {
  HandlerStorage,
  StorageObject,
  StoragePutOptions,
} from '../types.js'

export class MemoryStorage implements HandlerStorage {
  data = new Map<string, Buffer>()

  get = vi.fn(async (key: string): Promise<StorageObject | null> => {
    const body = this.data.get(key)
    return body ? { body, etag: etagOf(body) } : null
  })

  put = vi.fn(
    async (
      key: string,
      body: Buffer,
      options?: StoragePutOptions
    ): Promise<{ etag: string } | 'precondition-failed'> => {
      const current = this.data.get(key)
      if (options?.ifNoneMatch && current) return 'precondition-failed'
      if (options?.ifMatch && (!current || etagOf(current) !== options.ifMatch))
        return 'precondition-failed'

      this.data.set(key, body)
      return { etag: etagOf(body) }
    }
  )
}

function etagOf(body: Buffer) {
  return `"${createHash('md5').update(body).digest('hex')}"`
}
