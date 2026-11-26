import { expect, it, vi } from 'vitest'
import { LRUCache } from './LRUCache.js'

const bySize = (v: { size: number }) => v.size

it('evicts the least recently used items once over the max size', () => {
  const onEvict = vi.fn()
  const cache = new LRUCache(10, bySize, onEvict)
  cache.set('a', { size: 4 })
  cache.set('b', { size: 4 })
  cache.get('a')
  cache.set('c', { size: 4 })

  expect(cache.has('a')).toBe(true)
  expect(cache.has('b')).toBe(false)
  expect(cache.has('c')).toBe(true)
  expect(onEvict).toHaveBeenCalledExactlyOnceWith('b', { size: 4 })
  expect(cache.currentSize).toBe(8)
})

it('evicts as many items as needed to fit a large one', () => {
  const cache = new LRUCache(10, bySize)
  cache.set('a', { size: 3 })
  cache.set('b', { size: 3 })
  cache.set('c', { size: 3 })
  cache.set('d', { size: 9 })

  expect(['a', 'b', 'c', 'd'].filter((k) => cache.has(k))).toEqual(['d'])
  expect(cache.size).toBe(1)
  expect(cache.currentSize).toBe(9)
})

it('replaces an existing key, adjusting the size', () => {
  const cache = new LRUCache(10, bySize)
  cache.set('a', { size: 4 })
  cache.set('a', { size: 6 })

  expect(cache.get('a')).toEqual({ size: 6 })
  expect(cache.size).toBe(1)
  expect(cache.currentSize).toBe(6)
})

it('refuses an item larger than the whole cache, keeping the rest', () => {
  const cache = new LRUCache(10, bySize)
  cache.set('a', { size: 4 })

  expect(cache.set('b', { size: 11 })).toBe(false)
  expect(cache.has('a')).toBe(true)
  expect(cache.has('b')).toBe(false)
})

it('throws on items without a size', () => {
  const cache = new LRUCache(10, bySize)
  expect(() => cache.set('a', { size: 0 })).toThrow(/size must be > 0/)
})

it('removes a key without calling onEvict', () => {
  const onEvict = vi.fn()
  const cache = new LRUCache(10, bySize, onEvict)
  cache.set('a', { size: 4 })
  cache.remove('a')

  expect(cache.has('a')).toBe(false)
  expect(cache.currentSize).toBe(0)
  expect(onEvict).not.toHaveBeenCalled()
})
