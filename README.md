# next-cache-s3

A [`cacheHandlers`](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers) implementation for Next.js 16 [`cacheComponents`](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents) and [`use cache`](https://nextjs.org/docs/app/api-reference/directives/use-cache).

## Setup

The library is in [`packages/next-cache-s3`](packages/next-cache-s3) and a demo app in [`examples/basic`](examples/basic).

1. `pnpm install`
2. Copy `examples/basic/.env.example` to `examples/basic/.env`
3. `pnpm build && pnpm start`
4. Play around at http://localhost:3000

**Note:** Next doesn't compile cache handlers, so the library is pre-built (on install and before `pnpm build`). [As the docs say](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#usage), the Next config points to plain JS files with `require.resolve`, which here import the library:

```js
// examples/basic/cache-handlers/default.mjs
import { createHandler } from 'next-cache-s3'
import { storage } from './storage.mjs'

export default createHandler({ name: 'default', storage })
```

## Features

- LRU cache in addition to S3, to reduce network overhead
- Tags manifest syncing with LRU and stale-while-revalidate
- Sticky handlers (for caching across builds)
- Optimizations:
  - Brotli compression
  - base64 encoding

## Roadmap

See [ROADMAP.md](ROADMAP.md).
