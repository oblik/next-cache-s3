import fs from 'node:fs'
import path from 'node:path'
import { Handler } from './Handler.js'
import {
  defaultTagsManagerOptions,
  TagsManager,
  type TagsManagerOptions,
} from './TagsManager.js'
import type { HandlerStorage } from './types.js'

export interface CreateHandlerOptions {
  /** Namespaces the handler's entries in storage. Use the `cacheHandlers` key. */
  name: string
  /**
   * Handlers that share a storage **instance** also share one tags manifest
   * in memory, so a `revalidateTag` writes it once. Create the storage in a
   * module that all handler files import, rather than once per handler file.
   */
  storage: HandlerStorage
  /**
   * Defaults to the contents of `.next/BUILD_ID` in the working directory. Set
   * it when that's not where the build output is, e.g. with a custom
   * `distDir`.
   */
  buildId?: string
  /** In-memory LRU size in bytes, in front of storage. `0` disables it. */
  lruSize?: number
  /**
   * Keeps entries across builds by leaving the build ID out of storage keys.
   * @experimental Keys still differ between build machines.
   */
  sticky?: boolean
  /** Brotli-compresses entries in storage. */
  compress?: boolean
  /** Stores Buffers as base64 instead of number arrays in JSON. */
  base64?: boolean
  /**
   * Tags manifest timings. Applied by the first handler created for a storage
   * instance, since the manifest is shared.
   */
  tags?: Partial<TagsManagerOptions>
}

// Same as Next's `cacheMaxMemorySize` default.
const DEFAULT_LRU_SIZE = 50 * 1024 * 1024

// Keyed by storage, so that handlers sharing a storage instance share the
// manifest too, without the module having to hold a single global manager.
const tagsManagers = new WeakMap<HandlerStorage, TagsManager>()

export function createHandler(options: CreateHandlerOptions): Handler {
  const { storage } = options

  let tagsManager = tagsManagers.get(storage)
  if (!tagsManager) {
    tagsManager = new TagsManager(storage, {
      ...defaultTagsManagerOptions,
      ...options.tags,
    })
    tagsManagers.set(storage, tagsManager)
  }

  return new Handler(options.buildId ?? readBuildId(), storage, tagsManager, {
    name: options.name,
    lruSize: options.lruSize ?? DEFAULT_LRU_SIZE,
    sticky: options.sticky ?? false,
    compress: options.compress ?? false,
    base64: options.base64 ?? false,
  })
}

function readBuildId(): string {
  // There's no build ID yet in these phases, but handlers are still created.
  if (process.env.__NEXT_DEV_SERVER === '1') return '_dev'
  if (process.env.NEXT_PHASE === 'phase-production-build') return '_build'

  const buildIdPath = path.join(process.cwd(), '.next', 'BUILD_ID')
  const buildId = fs.readFileSync(buildIdPath, 'utf8').trim()
  if (!buildId) throw new Error(`Build ID missing in ${buildIdPath}`)
  return buildId
}
