/**
 * The roster's edit and remove affordances.
 *
 * These exist because the plugin shipped with its only edit control rendered at
 * `opacity-0` until hover — present in the DOM, invisible in practice, and the
 * user reported having no way to edit or remove a machine at all. A structural
 * test cannot prove something is visible on screen, but it can prove the
 * controls exist, are reachable two different ways, and are not hidden by the
 * class that caused the original problem.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readFileSync } from 'node:fs'

import { clampTitlebarHeight, MachineRow, normalizeMachine, suggestFix } from '../plugin.js'

/** Walk the element tree the stubbed createElement produces. */
function* walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)

    return
  }

  if (!node || typeof node !== 'object') {
    return
  }

  yield node
  yield* walk(node.children)
  yield* walk(node.props?.children)
}

const nameOf = node => (typeof node.type === 'function' ? node.type.name : node.type)
const find = (tree, name) => [...walk(tree)].filter(node => nameOf(node) === name)
const textOf = node => [...walk(node.children)].filter(n => typeof n === 'string')

const machine = normalizeMachine({ name: 'VPS', host: 'vnc.example.com' }).machine
const tree = MachineRow({ machine, selected: false, phase: 'idle' })

describe('MachineRow', () => {
  it('offers a right-click menu', () => {
    assert.equal(find(tree, 'ContextMenu').length, 1)
    assert.equal(find(tree, 'ContextMenuTrigger').length, 1)
  })

  it('lets the row be edited, duplicated and removed from that menu', () => {
    const labels = find(tree, 'ContextMenuItem').flatMap(item =>
      [item.children, item.props?.children].flat().filter(child => typeof child === 'string')
    )

    assert.deepEqual(labels, ['Edit…', 'Duplicate', 'Remove…'])
  })

  it('marks Remove as destructive', () => {
    const remove = find(tree, 'ContextMenuItem').at(-1)

    assert.equal(remove.props.variant, 'destructive')
  })

  it('wires every menu item to onSelect, which is what the component listens for', () => {
    // ContextMenuItem takes onSelect; an onClick here would silently do nothing.
    for (const item of find(tree, 'ContextMenuItem')) {
      assert.equal(typeof item.props.onSelect, 'function', 'menu item must use onSelect')
      assert.equal(item.props.onClick, undefined, 'onClick would be ignored by ContextMenuItem')
    }
  })

  it('also carries a button, so editing does not depend on knowing to right-click', () => {
    const buttons = find(tree, 'Button')

    assert.ok(buttons.length >= 1, 'expected an edit button on the row')
    assert.equal(typeof buttons[0].props.onClick, 'function')
  })

  it('never hides that button behind opacity-0', () => {
    // The exact regression: `opacity-0 group-hover:opacity-100` made the only
    // edit control invisible until hovered, in a narrow pane.
    for (const button of find(tree, 'Button')) {
      assert.doesNotMatch(String(button.props.className ?? ''), /\bopacity-0\b/)
    }
  })

  it('keeps the row from pushing its controls out of a narrow pane', () => {
    const row = [...walk(tree)].find(node => String(node.props?.className ?? '').includes('cursor-pointer'))

    assert.match(row.props.className, /min-w-0/, 'row must be allowed to shrink')
  })
})

describe('suggestFix', () => {
  const base = extra => normalizeMachine({ name: 'm', host: 'h.example.com', ...extra }).machine

  it('offers TLS on 443 for a plain ws endpoint that went silent', () => {
    // The real case: an https site with websockify behind it, entered as
    // ws:// on websockify's conventional 6080. Both wrong at once.
    const fix = suggestFix(base({ secure: false, port: 6080 }))

    assert.deepEqual(fix.patch, { secure: true, port: 443 })
    assert.match(fix.label, /TLS/)
  })

  it('suggests 443 when TLS is on but the port is not', () => {
    assert.deepEqual(suggestFix(base({ secure: true, port: 6080 })).patch, { port: 443 })
  })

  it('has nothing to suggest once the endpoint is already wss on 443', () => {
    assert.equal(suggestFix(base({ secure: true, port: 443 })), null)
  })
})

describe('roster layout', () => {
  const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

  it('does not put the machine list inside a Radix ScrollArea', () => {
    // Radix renders its viewport content as a table with min-width:100%, which
    // sizes to content instead of to the pane. A long endpoint then widened the
    // row past the pane edge and pushed the edit button out of sight — twice.
    // Checks real usage, not the comment that explains why it is avoided.
    assert.ok(!/h\(\s*ScrollArea/.test(source), 'the roster must not render a ScrollArea')
    assert.ok(!/^\s*ScrollArea,$/m.test(source), 'ScrollArea must not be imported')
  })

  it('constrains the list so a long endpoint cannot widen the pane', () => {
    assert.match(source, /overflow-x-hidden overflow-y-auto/)
    assert.match(source, /flex w-full min-w-0 flex-col/)
  })

  it('offers editing through the command palette too', () => {
    // Redundancy on purpose: a palette command cannot be hidden by layout.
    assert.match(source, /Remote Desktop: Edit current machine…/)
  })

  it('offers editing from the viewer toolbar as well as the roster', () => {
    const gears = source.match(/name: 'settings-gear'/g) ?? []

    assert.ok(gears.length >= 2, 'expected an edit control on both the row and the toolbar')
  })
})

describe('fullscreen layout', () => {
  const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

  it('starts below the app titlebar instead of covering it', () => {
    // `fixed inset-0` put the pane's toolbar at y=0, on top of the window
    // controls at the top right, so the two sets of buttons overlapped.
    assert.ok(!/fixed inset-0 z-50/.test(source), 'fullscreen must not cover the titlebar')
  })

  it('does not take the offset from --titlebar-height', () => {
    // The contrib shell that panes live in sets that variable to 0px, so
    // `var(--titlebar-height,34px)` resolves to zero and the fallback never
    // applies. Reading it was the reason the first fix changed nothing.
    assert.ok(!/top-\[var\(--titlebar-height/.test(source), 'that variable is 0 inside panes')
    assert.match(source, /appTitlebarHeight\(\)/)
  })

  describe('clampTitlebarHeight', () => {
    it('accepts a plausible measurement', () => {
      assert.equal(clampTitlebarHeight(34), 34)
      assert.equal(clampTitlebarHeight(40.4), 40)
    })

    it('falls back when the measurement is missing, zero or absurd', () => {
      // Zero is the exact value the CSS variable would have given us.
      for (const value of [0, -5, undefined, null, NaN, 5000]) {
        assert.equal(clampTitlebarHeight(value), 34, `expected fallback for ${value}`)
      }
    })
  })

  it('still covers the rest of the window', () => {
    assert.match(source, /fixed right-0 bottom-0 left-0/)
  })
})
