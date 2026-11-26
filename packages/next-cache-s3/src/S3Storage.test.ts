import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { expect, it, vi } from 'vitest'
import { S3Storage } from './S3Storage.js'

function fakeClient(send: (command: unknown) => Promise<unknown>) {
  return { send: vi.fn(send) } as unknown as S3Client & {
    send: ReturnType<typeof vi.fn>
  }
}

it('prefixes keys on put and get', async () => {
  const client = fakeClient(async (command) =>
    command instanceof GetObjectCommand
      ? { Body: { transformToByteArray: async () => Buffer.from('body') } }
      : {}
  )
  const storage = new S3Storage({ bucket: 'b', prefix: 'app/', client })

  await storage.put('build/1/x.json', Buffer.from('body'))
  expect(await storage.get('build/1/x.json')).toEqual(Buffer.from('body'))

  const [[put], [get]] = client.send.mock.calls
  expect(put).toBeInstanceOf(PutObjectCommand)
  expect(put.input).toMatchObject({ Bucket: 'b', Key: 'app/build/1/x.json' })
  expect(get.input).toEqual({ Bucket: 'b', Key: 'app/build/1/x.json' })
})

it('uses keys as-is without a prefix', async () => {
  const client = fakeClient(async () => ({}))
  await new S3Storage({ bucket: 'b', client }).put('x.json', Buffer.from(''))
  expect(client.send.mock.calls[0][0].input.Key).toBe('x.json')
})

it('returns null for a missing key', async () => {
  const client = fakeClient(async () => {
    throw new NoSuchKey({ message: 'missing', $metadata: {} })
  })
  expect(await new S3Storage({ bucket: 'b', client }).get('x')).toBeNull()
})
