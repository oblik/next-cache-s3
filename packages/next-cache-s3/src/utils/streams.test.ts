import { expect, it } from 'vitest'
import { streamFromBuffer, streamToBuffer } from './streams.js'

it('round-trips a buffer', async () => {
  const buffer = Buffer.from('hello')
  expect(await streamToBuffer(streamFromBuffer(buffer))).toEqual(buffer)
})

it('concatenates every chunk of a stream', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('a'))
      controller.enqueue(Buffer.from('bc'))
      controller.close()
    },
  })
  expect(await streamToBuffer(stream)).toEqual(Buffer.from('abc'))
})

it('rejects when the stream errors', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('a'))
      controller.error(new Error('boom'))
    },
  })
  await expect(streamToBuffer(stream)).rejects.toThrow('boom')
})
