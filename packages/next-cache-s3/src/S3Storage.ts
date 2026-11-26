import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import type { HandlerStorage } from './types.js'
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
 * Stores cache entries as objects in an S3 bucket.
 * @todo Add ETag support, to prevent unnecessary network overhead.
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

  async get(key: string): Promise<Buffer | null> {
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
    return Buffer.from(await data.Body.transformToByteArray())
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.log?.(`put: ${key}`)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: body,
      })
    )
  }
}
