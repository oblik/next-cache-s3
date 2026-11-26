import { FsStorage, S3Storage } from 'next-cache-s3'

// One instance shared by all handler files, so they also share one tags
// manifest in memory.
export const storage = process.env.CACHE_S3_BUCKET
  ? new S3Storage({
      bucket: process.env.CACHE_S3_BUCKET,
      region: process.env.CACHE_S3_REGION,
    })
  : new FsStorage({ dir: '.next/cache/handler' })
