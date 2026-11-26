import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('./cache-handlers/default.mjs'),
    sticky: require.resolve('./cache-handlers/sticky.mjs'),
  },
}

export default nextConfig
