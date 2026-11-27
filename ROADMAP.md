# Roadmap

Goal: a first npm prerelease that can replace an ISR `cacheHandler` in a production Next.js 16 app running several server instances.

This lists only what's left; commits show what's done. Milestones are ordered, and within a milestone, items are ordered by dependency. Each item is done when it has unit tests and `pnpm check` passes. Items are bullets with a bold name rather than numbers, so removing one doesn't renumber the rest: refer to them by name.

## Decisions

- **No ISR.** Only the `use cache` handler API. The target is apps whose routes are dynamic (`await connection()`) and cache through `use cache`.
- **One tags manifest**, not per-tag objects: one fetch, one in-memory copy. Concurrent writers are handled with conditional writes, replaying local updates on a conflict.
- **Explicit configuration.** The consumer writes the handler file and passes storage and options. The package reads no env vars except the debug flag.
- **No runtime imports from `next/dist/...`**, only types. Vendored helpers note where Next has an equivalent.
- **Sticky handlers are experimental** and not needed for the first trial.
- **Tests:** unit tests on in-memory storage plus e2e against `next start` on `FsStorage` until the trial. Hardening then tests the invariants under simulated faults and the storage contract against real S3, not emulators.

## Tests

- **`Handler` unit tests.** A stream that errors partway through `set`.
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

## Hardening

After the trial, before a stable release. The goal is to trust the package, not coverage: every test here checks an invariant that would cause an incident if broken.

- **Invariants.** Write down what must never happen, in the README or a doc the tests link to:
  - A request never fails because of the cache
  - An entry is never served after one of its tags expired (stale is allowed until `expire`)
  - No tag update is lost when instances write the manifest concurrently
- **Simulation tests.** A `FaultyStorage` wrapping `MemoryStorage`, driven by a seed: random latency, reordered responses, 412s, thrown errors. N instances run random `set` / `get` / `updateTags` interleavings over thousands of seeds, checking the invariants after each; a failing seed replays exactly. Likely `fast-check` with `fc.scheduler()`.
- **Storage contract suite.** One suite run against `MemoryStorage`, `FsStorage` and real S3: round trip, missing key, ETag consistency, `ifMatch` / `ifNoneMatch` conflicts. Passing it on S3 is what makes the in-memory tests mean something. Replaces most of `S3Storage.test.ts`, which tests a mocked client. Run against the provider used in production, since conditional-write support differs between S3-compatible services.
- **Test bucket.** In a separate AWS account, from a reviewed IaC template applied by hand: one bucket with a 1-day lifecycle rule, a GitHub OIDC role limited to `main` and manual runs, with object read/write/delete on that bucket only. No stored keys.
- **CI.** GitHub Actions: `pnpm check` (including simulation) on every push and PR; e2e and the S3 contract suite on `main`, nightly and on demand, never on fork PRs.

## Later

- **Sticky handlers.** Keys vary across build machines because the function ID part depends on `.next/cache`. Try `deploymentId`; otherwise key on arguments only.
- **Brotli for the manifest**, if it grows large
