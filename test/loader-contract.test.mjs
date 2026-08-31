/**
 * The host loader's acceptance check, replicated exactly.
 *
 * This exists because the plugin was once rejected at load time by the real app
 * with "unsupported imports: host up, host did not, x, nothing did" — four
 * phrases in ordinary prose comments. The loader scans plugin.js as TEXT with a
 * regex that is not comment-aware or string-aware, so any prose shaped like an
 * import statement fails the whole plugin. Nothing else in this suite could
 * catch that, because the file imports and behaves perfectly once loaded.
 *
 * Kept byte-for-byte in sync with `unsupportedImports()` in the app's
 * apps/desktop/src/contrib/runtime-loader.ts.
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.join(repoRoot, 'plugin.js')
const source = readFileSync(PLUGIN, 'utf8')

/** Verbatim from the app's runtime-loader. */
const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

/** The only specifiers the loader can resolve (see sdk/runtime.ts). */
const RESOLVABLE = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])

/** Verbatim port of the loader's rejection logic. */
function unsupportedImports(text) {
  const bare = new Set()

  for (const match of text.matchAll(importSpecifierRe())) {
    const spec = match[3]

    // Relative/absolute and any URL scheme are skipped by the loader.
    if (spec && !/^[./]/.test(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec) && !RESOLVABLE.has(spec)) {
      bare.add(spec)
    }
  }

  return [...bare]
}

/** Line number + text for a match index, so a failure is actionable. */
function locate(text, index) {
  const line = text.slice(0, index).split('\n').length

  return `line ${line}: ${text.split('\n')[line - 1].trim()}`
}

describe('host loader acceptance', () => {
  it('has no specifier the loader would reject', () => {
    const offenders = []

    for (const match of source.matchAll(importSpecifierRe())) {
      const spec = match[3]

      if (spec && !/^[./]/.test(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec) && !RESOLVABLE.has(spec)) {
        offenders.push(`${JSON.stringify(spec)} — ${locate(source, match.index)}`)
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'the loader scans this file as text and is not comment-aware. Rewrite the prose ' +
        'so the word "from" is never directly followed by a quoted string:\n' +
        offenders.join('\n')
    )
  })

  it('imports nothing beyond the two resolvable modules', () => {
    // A real import of anything else fails the same check, for real reasons.
    // `[\s\S]*?` because the SDK import spans many lines; the lazy quantifier
    // stops at that statement's own `from '…'` rather than running on.
    const real = [
      ...source.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s*(['"])([^'"]+)\1/g),
      ...source.matchAll(/(?:^|\n)\s*import\s*(['"])([^'"]+)\1/g)
    ].map(m => m[2])

    for (const spec of real) {
      assert.ok(RESOLVABLE.has(spec), `plugin.js may not import ${JSON.stringify(spec)}`)
    }

    assert.deepEqual([...new Set(real)].sort(), ['@hermes/plugin-sdk', 'react'])
  })

  it('reports nothing unsupported through the loader helper', () => {
    assert.deepEqual(unsupportedImports(source), [])
  })

  it('mentions each resolvable specifier exactly once, in its real import', () => {
    // The loader does not just *scan* these matches, it REWRITES them to blob
    // URLs — anywhere in the text, comments and string literals included. A
    // second mention of 'react' sitting inside a user-facing string would be
    // silently replaced with a blob: URL at load time. One occurrence each
    // means the only things rewritten are the two genuine import statements.
    const counts = {}

    for (const match of source.matchAll(importSpecifierRe())) {
      counts[match[3]] = (counts[match[3]] ?? 0) + 1
    }

    assert.deepEqual(counts, { '@hermes/plugin-sdk': 1, react: 1 })
  })

  it('would still be rejected if the guarded prose came back', () => {
    // Proves the check has teeth rather than passing vacuously.
    const regressed = `${source}\n// distinguishes "a" from "b"\n`

    assert.deepEqual(unsupportedImports(regressed), ['b'])
  })

  it('fits the older shell read limit, so it is never truncated', () => {
    // Older desktop shells read plugin.js through an IPC that silently
    // truncates at 512 KiB; half a module can still parse.
    const bytes = statSync(PLUGIN).size

    assert.ok(bytes < 512 * 1024, `plugin.js is ${bytes} bytes, over the 512 KiB read limit`)
  })

  it('default-exports the shape the loader validates', () => {
    // The loader rejects anything without `id` and a `register` function.
    assert.match(source, /export default \{/)
    assert.match(source, /\bid:\s*ID\b/)
    assert.match(source, /\bregister\s*\(ctx\)\s*\{/)
  })
})
