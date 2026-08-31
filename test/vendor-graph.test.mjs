// Guards the vendored noVNC tree and the assumptions plugin.js's module loader
// makes about it. If someone re-vendors a different noVNC release and it grows
// an import cycle, a missing file, or a module too large for the desktop file
// bridge to read in one piece, these fail rather than the plugin failing at
// connect time in front of a user.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { NOVNC_VERSION, resolveRelative } from '../plugin.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'vendor/novnc/core/rfb.js'

/** The same specifier pattern plugin.js's loader uses. */
const IMPORT_SPECIFIER = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

/** Older desktop shells read plugin files through an IPC that truncates at
 *  512 KiB; a truncated module would be a syntax error at best. */
const READ_LIMIT_BYTES = 512 * 1024

/** Walk the graph exactly the way the plugin's loader does. */
function walk() {
  const visited = new Map()
  const stack = []
  const problems = { cycles: [], missing: [], oversize: [] }

  const visit = relPath => {
    if (visited.has(relPath)) {
      return
    }

    if (stack.includes(relPath)) {
      problems.cycles.push([...stack, relPath].join(' -> '))

      return
    }

    const absolute = path.join(repoRoot, relPath)

    if (!existsSync(absolute)) {
      problems.missing.push(relPath)

      return
    }

    if (statSync(absolute).size > READ_LIMIT_BYTES) {
      problems.oversize.push(relPath)
    }

    stack.push(relPath)
    const source = readFileSync(absolute, 'utf8')

    for (const match of source.matchAll(IMPORT_SPECIFIER())) {
      const specifier = match[3]

      // The loader only rewrites relative specifiers; anything else is either a
      // comment that happens to read like an import or an error caught below.
      if (specifier.startsWith('.')) {
        visit(resolveRelative(relPath, specifier))
      }
    }

    stack.pop()
    visited.set(relPath, source)
  }

  visit(ENTRY)

  return { modules: visited, problems }
}

const { modules, problems } = walk()

describe('vendored noVNC graph', () => {
  it('has the entry module present', () => {
    assert.ok(existsSync(path.join(repoRoot, ENTRY)), `${ENTRY} is missing — vendor noVNC before shipping`)
  })

  it('resolves every relative import to a real file', () => {
    assert.deepEqual(problems.missing, [], 'unresolved imports in the vendored tree')
  })

  it('is acyclic, because blob-URL modules cannot express a cycle', () => {
    // The loader builds each module's blob URL only after its dependencies
    // have theirs, so a cycle is genuinely unrepresentable rather than merely
    // slow. Catch it here instead of at connect time.
    assert.deepEqual(problems.cycles, [], 'import cycle in the vendored tree')
  })

  it('keeps every module under the desktop read limit', () => {
    assert.deepEqual(problems.oversize, [], `modules larger than ${READ_LIMIT_BYTES} bytes`)
  })

  it('pulls in a plausible module graph', () => {
    // A sanity floor: noVNC's RFB genuinely needs its decoders and pako. If a
    // future re-vendor drops to a handful of files, something went wrong.
    assert.ok(modules.size > 40, `only ${modules.size} modules reachable from ${ENTRY}`)
  })

  it('needs no bare specifiers at runtime', () => {
    const bare = []

    for (const [relPath, source] of modules) {
      for (const match of source.matchAll(IMPORT_SPECIFIER())) {
        const specifier = match[3]

        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          continue
        }

        // Distinguish a real import statement from prose in a comment that
        // happens to contain `from '…'`. Only a real one is a problem: the
        // loader cannot resolve a bare specifier.
        const isRealImport = /^\s*(import|export)\b/.test(
          source.slice(source.lastIndexOf('\n', match.index) + 1, match.index + match[0].length)
        )

        if (isRealImport) {
          bare.push(`${relPath}: ${specifier}`)
        }
      }
    }

    assert.deepEqual(bare, [], 'vendored noVNC must not import bare specifiers')
  })

  it('uses no runtime feature the blob loader cannot provide', () => {
    // import.meta has no meaningful value in a blob module, and a Worker or
    // WASM fetch would reach for a URL that does not exist once vendored.
    const offenders = []

    for (const [relPath, source] of modules) {
      if (/\bimport\.meta\b/.test(source)) {
        offenders.push(`${relPath}: import.meta`)
      }

      if (/\bnew Worker\b/.test(source)) {
        offenders.push(`${relPath}: Worker`)
      }

      if (/\bWebAssembly\b/.test(source)) {
        offenders.push(`${relPath}: WebAssembly`)
      }
    }

    assert.deepEqual(offenders, [])
  })
})

describe('vendored noVNC provenance', () => {
  it('ships its upstream licence', () => {
    const licence = path.join(repoRoot, 'vendor/novnc/LICENSE.txt')

    assert.ok(existsSync(licence), 'vendor/novnc/LICENSE.txt is required by the MPL-2.0 terms')
    assert.match(readFileSync(licence, 'utf8'), /Mozilla\s+Public\s+License/i)
  })

  it('records the pinned version', () => {
    assert.match(NOVNC_VERSION, /^\d+\.\d+\.\d+$/)
  })

  it('documents the pinned version in the README', () => {
    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8')

    assert.ok(
      readme.includes(NOVNC_VERSION),
      `README.md must state the pinned noVNC version (${NOVNC_VERSION})`
    )
  })
})

describe('resolveRelative', () => {
  it('resolves a sibling', () => {
    assert.equal(resolveRelative('core/rfb.js', './display.js'), 'core/display.js')
  })

  it('resolves a nested path', () => {
    assert.equal(resolveRelative('core/rfb.js', './input/keyboard.js'), 'core/input/keyboard.js')
  })

  it('walks up out of core/ into vendor/', () => {
    assert.equal(
      resolveRelative('vendor/novnc/core/inflator.js', '../vendor/pako/lib/zlib/inflate.js'),
      'vendor/novnc/vendor/pako/lib/zlib/inflate.js'
    )
  })

  it('collapses redundant segments', () => {
    assert.equal(resolveRelative('a/b/c.js', './././d.js'), 'a/b/d.js')
    assert.equal(resolveRelative('a/b/c.js', '../b/./d.js'), 'a/b/d.js')
  })
})
