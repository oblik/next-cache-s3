# next-cache-s3

A [`cacheHandlers`](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers) implementation for Next.js 16 `cacheComponents` / `use cache`, backed by S3 (filesystem locally).
Meant to be published to npm as a project-agnostic package. It has to support dynamically rendered sites that run several server instances against one shared bucket.
What's left to build, in order, is in [ROADMAP.md](ROADMAP.md). Check it before starting work and update it when an item is done or the plan changes.

## Scope

- Only the `use cache` handler API (`CacheHandler` in `next/dist/server/lib/cache-handlers/types`)
- No ISR / singular `cacheHandler` support, on purpose. Don't add it.
- Must be safe with several server instances sharing one bucket

## Layout

- `cache-handler/src` — the library
  - `Handler.ts` — the `CacheHandler` implementation: LRU in front of storage, tag checks
  - `TagsManager.ts` — the single shared tags manifest (`tags-manifest.json`), cached with stale-while-revalidate
  - `createHandler.ts` — wires build ID, storage and tags manager, which are shared by all handlers in the process
  - `S3Storage.ts`, `FsStorage.ts` — `HandlerStorage` backends; the filesystem one mimics S3 semantics
- `cache-handler/*.mjs` — the handler entry files that `next.config.ts` points to
  - They import from `cache-handler/dist`, which is gitignored and built with `pnpm build:handler`
  - Next doesn't compile handlers, so rebuild after changing `src` or the app keeps running old code
- `app`, `components` — demo Next.js app for trying the handler by hand

## Commands

- `pnpm check` — typecheck, lint, unit tests, format check. Run it before calling anything done.
- `pnpm test` runs once; `pnpm test:watch` watches
- `pnpm build && pnpm start` — the only way to exercise caching for real; `next dev` behaves differently
- `NEXT_CACHE_S3_DEBUG=true` (see `.env.example`) turns on handler logs and artificial storage latency

## Conventions

- Prettier: single quotes, no semicolons, `es5` trailing commas. A hook formats files after each edit.
- Comments explain _why_, never _how_
- Handler behavior should follow Next's built-in handler (`node_modules/next/dist/server/lib/cache-handlers/default.js`). Read the installed Next source instead of relying on memory, since this API changes between releases. Link the upstream code in a comment when mirroring it.
- A cache must fail open: a storage or parsing error is a cache miss, never a failed request
- Every behavior change needs a unit test against an in-memory `HandlerStorage` with fake timers
- No new imports from `next/dist/...` other than types
