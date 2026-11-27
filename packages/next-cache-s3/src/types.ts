/**
 * Minimal key/value store the cache handler needs. Keys are the **full** object
 * keys (including the `build/<id>/` prefix) and values are opaque byte buffers;
 * JSON (de)serialization and compression are the handler's job.
 *
 * ETags let several server instances update the shared tags manifest without
 * overwriting each other's changes. They're opaque: only ever compared for
 * equality, never parsed.
 */
export interface HandlerStorage {
  /** `null` when the key doesn't exist. */
  get(key: string): Promise<StorageObject | null>

  /**
   * `'precondition-failed'` when a condition in `options` doesn't hold, in
   * which case nothing is written. Conditions must be checked atomically with
   * the write, or concurrent writers can still overwrite each other.
   */
  put(
    key: string,
    body: Buffer,
    options?: StoragePutOptions
  ): Promise<{ etag: string } | 'precondition-failed'>
}

export interface StorageObject {
  body: Buffer
  etag: string
}

export interface StoragePutOptions {
  /** Writes only if the object exists and still has this ETag. */
  ifMatch?: string
  /** Writes only if the object doesn't exist. */
  ifNoneMatch?: '*'
}
