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
