# Roadmap

Goal: a first npm prerelease that can replace an ISR `cacheHandler` in a production Next.js 16 app running several server instances.

This lists only what's left; commits show what's done. Milestones are ordered, and within a milestone, items are ordered by dependency. Each item is done when it has unit tests and `pnpm check` passes. Items are bullets with a bold name rather than numbers, so removing one doesn't renumber the rest: refer to them by name.

## Decisions

- **No ISR.** Only the `use cache` handler API. The target is apps whose routes are dynamic (`await connection()`) and cache through `use cache`.
- **One tags manifest**, not per-tag objects: one fetch, one in-memory copy. Concurrent writers are handled with conditional writes, replaying local updates on a conflict.
- **Explicit configuration.** The consumer writes the handler file and passes storage and options. The package reads no env vars except the debug flag.
- **No runtime imports from `next/dist/...`**, only types. Vendored helpers note where Next has an equivalent.
- **Sticky handlers are experimental** and not needed for the first trial.
- **Tests:** unit tests on in-memory storage plus e2e against `next start` on `FsStorage`. MinIO and multi-instance e2e only if the trial shows a need.

## Correctness

Found by comparing `Handler.ts` to Next's built-in handler (`next/dist/server/lib/cache-handlers/default.js`). All are required before the trial.

- **Fail open.**
  - Storage and parse errors in `get` are a miss; errors in `set` are logged, not thrown
  - A rejected `pendingEntry` must not make a concurrent `get` throw

## Tests

- **`Handler` unit tests.** Expired vs. stale tags, `get` during a pending `set`, partial stream, fail-open paths.
- **`TagsManager` unit tests.** Fresh / stale / expired manifest paths.
- **E2E.** Build `examples/basic`, run `next start` on `FsStorage`, assert over HTTP: cached render, `revalidateTag` (stale-while-revalidate), `updateTag` (immediate), `revalidatePath`. Separate `pnpm check:e2e`, since it needs a build.

## Prerelease and trial

- **README.** Installation, handler file, options, S3 permissions, limitations.
  - An S3 lifecycle rule for the `build/` prefix, since entries of old builds are never deleted
  - `@aws-sdk/client-s3` 3.700.0+ is needed for conditional writes
  - `tags.retentionMs` caps `cacheLife` profiles
- **Publish.** `LICENSE`, package metadata, publish `0.1.0-next.x` under the `next` dist-tag.
- **Trial in a real app.**
  - Enable `cacheComponents`, register `cacheHandlers`, remove `cacheHandler` and `cacheMaxMemorySize`
  - Move route caching to `use cache` + `cacheTag`, invalidate with `revalidateTag` / `updateTag`, and check that `revalidatePath` invalidates too
  - Verify the handler file and package end up in the `output: 'standalone'` bundle
  - Verify cross-instance invalidation on at least two server instances

## Later

- **Sticky handlers.** Keys vary across build machines because the function ID part depends on `.next/cache`. Try `deploymentId`; otherwise key on arguments only.
- **Brotli for the manifest**, if it grows large
- **CI.** GitHub Actions running `pnpm check` and e2e.
