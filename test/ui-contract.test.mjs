/**
 * Guards the UI contracts that fail *silently* — no crash, no console error,
 * just a feature that quietly does nothing.
 *
 * Both of these were real defects found by auditing against the app source:
 *   - every `Tip` was passed `content` instead of `label`, so all seven
 *     tooltips rendered their child untouched and no tooltip ever appeared;
 *   - the overlay and fullscreen backdrops referenced `--ui-bg`, which the app
 *     does not define, so an unresolved custom property left them transparent.
 *
 * Neither the unit tests nor the browser verification could catch these: the
 * plugin loads, registers and renders perfectly with both bugs present.
 *
 * The checks that need the app's own stylesheet skip themselves when Hermes is
 * not installed, so the suite still runs on a machine without it.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(repoRoot, 'plugin.js'), 'utf8')

const APP_SRC = path.join(homedir(), '.hermes/hermes-agent/apps/desktop/src')
const STYLES = path.join(APP_SRC, 'styles.css')
const CODICONS = path.join(homedir(), '.hermes/hermes-agent/node_modules/@vscode/codicons/dist/codicon.css')

describe('Tip usage', () => {
  it('passes `label`, never `content`', () => {
    // TipProps is declared as `Omit<…, 'content'>` with a required `label`, and
    // Tip returns its child untouched when label is falsy — so `content` is not
    // merely ignored, it is deliberately excluded, and the failure is silent.
    const wrong = [...source.matchAll(/h\(\s*Tip,\s*\{[^}]*?\bcontent:/gs)]

    assert.equal(wrong.length, 0, `${wrong.length} Tip call(s) still pass "content" instead of "label"`)
  })

  it('gives every Tip a label', () => {
    const tips = [...source.matchAll(/h\(\s*Tip,\s*\{/g)]
    const labelled = [...source.matchAll(/h\(\s*Tip,\s*\{[\s\S]{0,400}?\blabel:/g)]

    assert.ok(tips.length > 0, 'expected the toolbar to use Tip')
    assert.equal(labelled.length, tips.length, 'every Tip must be given a label')
  })
})

describe('CSS custom properties', () => {
  const referenced = [...new Set([...source.matchAll(/\(--([a-z0-9-]+)\)/g)].map(m => `--${m[1]}`))]

  it('references at least one app token', () => {
    assert.ok(referenced.length > 0)
  })

  it('uses only custom properties the app actually defines', { skip: !existsSync(STYLES) }, () => {
    const styles = readFileSync(STYLES, 'utf8')
    const defined = new Set([...styles.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map(m => m[1]))
    const missing = referenced.filter(name => !defined.has(name))

    assert.deepEqual(
      missing,
      [],
      `these custom properties are not defined by the app, so they resolve to nothing: ${missing.join(', ')}`
    )
  })
})

describe('Codicon names', () => {
  const names = [...new Set([...source.matchAll(/h\(\s*Codicon,\s*\{\s*name:\s*'([^']+)'/g)].map(m => m[1]))]
  // Icon names also appear in ternaries, e.g. `name: x ? 'a' : 'b'`.
  const ternary = [...source.matchAll(/h\(\s*Codicon,\s*\{\s*name:[^,}]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g)]
  const all = [...new Set([...names, ...ternary.flatMap(m => [m[1], m[2]])])]

  it('finds the icon names used', () => {
    assert.ok(all.length > 0, 'expected to find Codicon usages')
  })

  it('uses only icons that exist in the vendored codicon set', { skip: !existsSync(CODICONS) }, () => {
    const css = readFileSync(CODICONS, 'utf8')
    const known = new Set([...css.matchAll(/\.codicon-([a-z0-9-]+):before/g)].map(m => m[1]))
    const missing = all.filter(name => !known.has(name))

    assert.deepEqual(missing, [], `unknown codicon name(s): ${missing.join(', ')}`)
  })
})

describe('SDK imports', () => {
  const SDK_INDEX = path.join(APP_SRC, 'sdk/index.ts')

  // Every name plugin.js pulls out of the SDK, from its (multi-line) import.
  // Anchored to a line-start `import` with `[^}]*`: the file header quotes an
  // import statement in prose, and a looser pattern matched that comment
  // instead — the same "prose looks like code" trap the loader itself sets.
  const imported = (() => {
    const block = source.match(/^import\s*\{([^}]*)\}\s*from\s*'@hermes\/plugin-sdk'/m)

    return block
      ? block[1]
          .split(',')
          .map(name => name.trim())
          .filter(Boolean)
      : []
  })()

  it('finds the SDK import block', () => {
    assert.ok(imported.length > 0, 'expected plugin.js to import from @hermes/plugin-sdk')
  })

  it('imports only names the real SDK exports', { skip: !existsSync(SDK_INDEX) }, () => {
    // The shim does `export const { …names } = sdk`, so a name the SDK does not
    // export is a hard failure the moment the plugin is imported.
    const sdk = readFileSync(SDK_INDEX, 'utf8')
    const missing = imported.filter(name => {
      const patterns = [
        new RegExp(`^\\s*export\\s+(const|function|class)\\s+${name}\\b`, 'm'),
        new RegExp(`^\\s*${name}\\s*(,|$)`, 'm'),
        new RegExp(`\\b${name}\\s+as\\b`),
        new RegExp(`\\bas\\s+${name}\\b`),
        new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, 's')
      ]

      return !patterns.some(pattern => pattern.test(sdk))
    })

    assert.deepEqual(missing, [], `not exported by the SDK: ${missing.join(', ')}`)
  })

  it('is mirrored by the test stub, so the suite cannot pass on a fiction', () => {
    // The stub once carried a wrong PALETTE_AREA value and a browser assertion
    // passed against it rather than against the app.
    const stub = readFileSync(new URL('./stubs/sdk.mjs', import.meta.url), 'utf8')
    const missing = imported.filter(name => !new RegExp(`\\b${name}\\b`).test(stub))

    assert.deepEqual(missing, [], `missing from test/stubs/sdk.mjs: ${missing.join(', ')}`)
  })
})
