// Formats each file right after Claude edits it, so that its next edits build
// on the same output that format-on-save produces.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const { tool_input } = JSON.parse(readFileSync(0, 'utf8'))
const file = relative(root, tool_input.file_path)

// Files outside the project (e.g. scratch files) aren't ours to format.
if (file.startsWith('..')) process.exit(0)

const { status } = spawnSync(
  'node_modules/.bin/prettier',
  ['--write', '--ignore-unknown', '--log-level', 'warn', file],
  { cwd: root, stdio: 'inherit' }
)

process.exit(status ?? 1)
