import { vi } from 'vitest'
import type { HandlerStorage } from '../types.js'

export class MemoryStorage implements HandlerStorage {
  data = new Map<string, Buffer>()
  put = vi.fn(async (key: string, body: Buffer) => {
    this.data.set(key, body)
  })
  get = vi.fn(async (key: string) => this.data.get(key) ?? null)
}
