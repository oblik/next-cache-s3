import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import type {
  HandlerStorage,
  StorageObject,
  StoragePutOptions,
} from './types.js'
import { createLogger } from './utils/debug.js'

export interface S3StorageOptions {
  bucket: string
  /** Ignored when `client` is given. */
  region?: string
  /**
   * Prepended to every object key, so that several apps (or environments) can
   * share one bucket, e.g. `'my-app/'`.
   */
  prefix?: string
  /** A preconfigured client, e.g. for custom credentials or an S3-compatible endpoint. */
  client?: S3Client
}

/**
 * Stores cache entries as objects in an S3 bucket. Conditional writes need
 * `@aws-sdk/client-s3` 3.700.0 or later, since older versions silently drop
 * `IfMatch` on `PutObject`.
 */
export class S3Storage implements HandlerStorage {
  protected log = createLogger('S3Storage')
  protected client: S3Client
  protected bucket: string
  protected prefix: string

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket
    this.prefix = options.prefix ?? ''
    this.client = options.client ?? new S3Client({ region: options.region })
  }

  async get(key: string): Promise<StorageObject | null> {
    this.log?.(`get: ${key}`)
    const data = await this.client
      .send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key })
      )
      .catch((error) => {
        if (!(error instanceof S3ServiceException)) throw error
        if (['NotFound', 'NoSuchKey'].includes(error.name)) return null
        throw error
      })

    if (!data?.Body) return null
    const body = Buffer.from(await data.Body.transformToByteArray())
    return { body, etag: data.ETag ?? '' }
  }

  async put(
    key: string,
    body: Buffer,
    options?: StoragePutOptions
  ): Promise<{ etag: string } | 'precondition-failed'> {
    this.log?.(`put: ${key}`)
    const data = await this.client
      .send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.prefix + key,
          Body: body,
          IfMatch: options?.ifMatch,
          IfNoneMatch: options?.ifNoneMatch,
        })
      )
      .catch((error) => {
        if (!(error instanceof S3ServiceException)) throw error
        // A 409 means another conditional write to the key was in flight, and
        // is retried like a 412.
        // @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
        const status = error.$metadata.httpStatusCode
        if (status === 412 || status === 409)
          return 'precondition-failed' as const
        throw error
      })

    if (data === 'precondition-failed') return data
    return { etag: data.ETag ?? '' }
  }
}
