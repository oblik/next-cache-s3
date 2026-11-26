# Roadmap

Goal: a first npm prerelease that can replace an ISR `cacheHandler` in a production Next.js 16 app running several server instances.

Milestones are ordered. Within a milestone, items are ordered by dependency. Each item is done when it has unit tests and `pnpm check` passes.

## Decisions

- **No ISR.** Only the `use cache` handler API. The target is apps whose routes are dynamic (`await connection()`) and cache through `use cache`.
- **One tags manifest**, not per-tag objects: one fetch, one in-memory copy. Concurrent writers are handled with conditional writes (see 2.3).
- **Explicit configuration.** The consumer writes the handler file and passes storage and options. The package reads no env vars except the debug flag.
- **No runtime imports from `next/dist/...`**, only types. Vendored helpers note where Next has an equivalent.
- **Sticky handlers are experimental** and not needed for the first trial.
- **Tests:** unit tests on in-memory storage plus e2e against `next start` on `FsStorage`. MinIO and multi-instance e2e only if the trial shows a need.

## 1. Package restructure

Done: pnpm workspace with `packages/next-cache-s3` and `examples/basic`, explicit options (`createHandler`, `S3Storage`, `FsStorage`), ESM build with declarations, peer dependencies, vendored `LRUCache` and stream helpers.

## 2. Correctness

Found by comparing `Handler.ts` to Next's built-in handler (`next/dist/server/lib/cache-handlers/default.js`). All are required before the trial.

1. Done: **`softTags` / `revalidatePath`.** `getExpiration` returns the latest past expiry of the soft tags from the manifest, and Next discards older entries itself.
2. **Tag eviction resurrects entries.** A tag is dropped from the manifest `evictMs` (a placeholder default of 24h) after it expires, after which entries created _before_ the expiry are valid again. Eviction has to outlive the longest possible entry lifetime; pick a safe default and document the constraint.
3. **Manifest conditional writes.**
   - `HandlerStorage.get` returns an ETag; `put` accepts `ifMatch`; `get` accepts `ifNoneMatch`
   - On a failed precondition: re-read, merge per tag by taking the later timestamps, retry
   - Background refresh uses `ifNoneMatch`, so an unchanged manifest costs a 304
   - `FsStorage` emulates the same semantics
   - `updateTags` applies changes to the manager's current manifest, not to the handler's `this.tags` snapshot, which can be stale
4. **Fail open.**
   - Storage and parse errors in `get` are a miss; errors in `set` are logged, not thrown
   - A rejected `pendingEntry` must not make a concurrent `get` throw
   - The scheduled manifest write has no `catch` (unhandled rejection)
   - A rejected manifest fetch leaves `readPromise` set forever
5. **Missing manifest refetched on every request.** `loadedAt` is only set when the manifest exists, so a fresh bucket causes a storage read per `refreshTags`.
6. **Partial entries.** If the value stream errors, discard the entry: nothing in the LRU, nothing in storage.
7. Storage growth: document an S3 lifecycle rule for the `build/` prefix, since entries of old builds are never deleted

## 3. Tests

1. In-memory `HandlerStorage` test double (`src/testing/MemoryStorage.ts`, exists): add ETag support and failure injection
2. `Handler` unit tests: hit/miss, expired vs. stale tags, soft tags, `get` during a pending `set`, partial stream, fail-open paths, LRU hit and eviction
3. `TagsManager` unit tests:
   - Fresh / stale / expired manifest paths
   - A pre-existing stale tag in a loaded manifest takes effect without a local `updateTags`
   - `revalidateTag` with several handlers registered writes the manifest once
   - Conflict merge and retry
   - Eviction never revives an entry
4. E2E: build `examples/basic`, run `next start` on `FsStorage`, assert over HTTP: cached render, `revalidateTag` (stale-while-revalidate), `updateTag` (immediate), `revalidatePath`, entries surviving a server restart. Separate `pnpm check:e2e`, since it needs a build.

## 4. Prerelease and trial

1. README: installation, handler file, options, S3 permissions and lifecycle rule, limitations
2. `LICENSE`, package metadata, publish `0.1.0-next.x` under the `next` dist-tag
   - The package ships `src` (minus tests) only so that the declaration and source maps in `dist` resolve. Decide whether that's worth it; otherwise drop `src` from `files` and turn off `declarationMap` / `sourceMap` in `tsconfig.build.json`
3. Trial in a real app:
   - Enable `cacheComponents`, register `cacheHandlers`, remove `cacheHandler` and `cacheMaxMemorySize`
   - Move route caching to `use cache` + `cacheTag`, invalidate with `revalidateTag` / `updateTag`, and check that `revalidatePath` invalidates too
   - Verify the handler file and package end up in the `output: 'standalone'` bundle
   - Verify cross-instance invalidation on at least two server instances
4. Feed anything hard to debug back here as tests (MinIO, multi-instance e2e)

## Later

- Sticky handlers: keys vary across build machines because the function ID part depends on `.next/cache`. Try `deploymentId`; otherwise key on arguments only.
- Pluggable logger instead of `console.debug`
- Brotli for the manifest
- Store JSON-like values (starting with `0:{`) as text instead of a buffer, if it measurably compresses better
- GitHub Actions running `pnpm check` and e2e
- `CONTRIBUTING.md`, issue templates
