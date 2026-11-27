import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  HandlerStorage,
  StorageObject,
  StoragePutOptions,
} from './types.js'
import { createLogger, delay } from './utils/debug.js'
import { isErrno } from './utils/isErrno.js'

const TMP_SUFFIX = '.tmp'

export interface FsStorageOptions {
  /** Resolved against the current working directory. */
  dir: string
}

/**
 * Filesystem implementation that should mimic the behaviors of S3 but locally,
 * so that caching can work in development mode.
 */
export class FsStorage implements HandlerStorage {
  protected log = createLogger('FsStorage')

  protected root: string

  constructor(options: FsStorageOptions) {
    this.root = resolve(options.dir)
  }

  /**
   * Resolves key segments to an absolute path, refusing anything that would
   * escape the storage root (e.g. via `..`).
   */
  pathFor(segments: string[]): string {
    const result = join(this.root, ...segments)
    if (result !== this.root && !result.startsWith(this.root + sep)) {
      throw new Error(`Key escapes storage root: ${segments.join('/')}`)
    }
    return result
  }

  async get(key: string): Promise<StorageObject | null> {
    const path = this.pathFor(key.split('/'))
    this.log?.(`reading ${path}`)
    await delay?.(150, 50, this.log)
    return readObject(path)
  }

  /**
   * Writes to a temporary file first and then renames it, so a concurrent
   * `get` never observes a partially written entry. Conditions aren't checked
   * atomically with the write like on S3, which is fine for one process.
   */
  async put(
    key: string,
    body: Buffer,
    options?: StoragePutOptions
  ): Promise<{ etag: string } | 'precondition-failed'> {
    const filepath = this.pathFor(key.split('/'))

    if (options?.ifMatch || options?.ifNoneMatch) {
      const current = await readObject(filepath)
      const failed = options.ifNoneMatch
        ? current !== null
        : current?.etag !== options.ifMatch
      if (failed) return 'precondition-failed'
    }

    await mkdir(dirname(filepath), { recursive: true })
    await this.write(filepath, body)
    return { etag: etagOf(body) }
  }

  protected async write(filepath: string, body: Buffer) {
    const tmp = `${filepath}.${randomUUID()}${TMP_SUFFIX}`

    try {
      this.log?.(`writing ${filepath}`)
      await delay?.(200, 100, this.log)
      await writeFile(tmp, body)
      await rename(tmp, filepath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
}

async function readObject(path: string): Promise<StorageObject | null> {
  try {
    const body = await readFile(path)
    return { body, etag: etagOf(body) }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null
    throw error
  }
}

// Like S3's ETag for objects uploaded in one part, but only ever compared.
function etagOf(body: Buffer) {
  return `"${createHash('md5').update(body).digest('hex')}"`
}
