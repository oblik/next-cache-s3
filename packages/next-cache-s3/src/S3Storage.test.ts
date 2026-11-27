import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
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
      ? {
          Body: { transformToByteArray: async () => Buffer.from('body') },
          ETag: '"e"',
        }
      : { ETag: '"e"' }
  )
  const storage = new S3Storage({ bucket: 'b', prefix: 'app/', client })

  expect(await storage.put('build/1/x.json', Buffer.from('body'))).toEqual({
    etag: '"e"',
  })
  expect(await storage.get('build/1/x.json')).toEqual({
    body: Buffer.from('body'),
    etag: '"e"',
  })

  const [[put], [get]] = client.send.mock.calls
  expect(put).toBeInstanceOf(PutObjectCommand)
  expect(put.input).toMatchObject({ Bucket: 'b', Key: 'app/build/1/x.json' })
  expect(get.input).toMatchObject({ Bucket: 'b', Key: 'app/build/1/x.json' })
})

it('returns null for a missing key', async () => {
  const client = fakeClient(async () => {
    throw new NoSuchKey({ message: 'missing', $metadata: {} })
  })
  expect(await new S3Storage({ bucket: 'b', client }).get('x')).toBeNull()
})

function s3Error(name: string, httpStatusCode: number) {
  return new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode },
  })
}

it('passes conditions on to S3', async () => {
  const client = fakeClient(async () => ({ ETag: '"e"' }))
  const storage = new S3Storage({ bucket: 'b', client })

  await storage.put('x', Buffer.from(''), { ifMatch: '"a"' })
  await storage.put('x', Buffer.from(''), { ifNoneMatch: '*' })

  const [[ifMatch], [ifNoneMatch]] = client.send.mock.calls
  expect(ifMatch.input).toMatchObject({ IfMatch: '"a"' })
  expect(ifNoneMatch.input).toMatchObject({ IfNoneMatch: '*' })
})

it.each([
  { error: 'PreconditionFailed', status: 412, options: { ifMatch: '"a"' } },
  {
    error: 'ConditionalRequestConflict',
    status: 409,
    options: { ifMatch: '"a"' },
  },
  { error: 'PreconditionFailed', status: 412, options: { ifNoneMatch: '*' } },
] as const)(
  'returns precondition-failed for $error ($status) with $options',
  async ({ error, status, options }) => {
    const client = fakeClient(async () => {
      throw s3Error(error, status)
    })
    const storage = new S3Storage({ bucket: 'b', client })
    expect(await storage.put('x', Buffer.from(''), options)).toBe(
      'precondition-failed'
    )
  }
)

it('throws other errors on put', async () => {
  const client = fakeClient(async () => {
    throw s3Error('AccessDenied', 403)
  })
  const storage = new S3Storage({ bucket: 'b', client })
  await expect(
    storage.put('x', Buffer.from(''), { ifMatch: '"a"' })
  ).rejects.toThrow()
})
