# next-cache-s3

A [`cacheHandlers`](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers) implementation for Next.js 16 [`cacheComponents`](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents) and [`use cache`](https://nextjs.org/docs/app/api-reference/directives/use-cache).

## Setup

1. Copy `.env.example` to `.env`
2. `pnpm build && pnpm start`
3. Play around at http://localhost:3000

**Note:** The cache handler must be pre-built (the `prebuild` script in `package.json`) because it's not a part of Next.js's build process. As you can see in [the docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#usage) it must be specified in the Next config with `require.resolve` pointing to a plain JS file:

```ts
const nextConfig: NextConfig = {
  cacheHandlers: {
    default: require.resolve('./cache-handlers/default-handler.js'),
    remote: require.resolve('./cache-handlers/remote-handler.js'),
  },
}
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
