import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import { defineConfig, globalIgnores } from 'eslint/config'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: {
      next: { rootDir: 'examples/*/' },
      // React is only installed in the examples, so it can't be detected.
      react: { version: '19.2' },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '**/.next/**',
    '**/out/**',
    '**/build/**',
    '**/next-env.d.ts',
    'packages/*/dist/**',
  ]),
])

export default eslintConfig
