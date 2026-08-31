// Stand-in for @hermes/plugin-sdk. Only needs to supply the names plugin.js
// imports; the tests never render, so the components are inert markers.
const component = name => {
  const fn = () => null
  Object.defineProperty(fn, 'name', { value: name })

  return fn
}

/** Minimal nanostores-compatible atom — plugin.js creates several at module
 *  scope, so this has to actually work. */
export const atom = initial => {
  let value = initial
  const listeners = new Set()

  return {
    get: () => value,
    set: next => {
      value = next
      listeners.forEach(listener => listener(value))
    },
    subscribe: listener => {
      listeners.add(listener)
      listener(value)

      return () => listeners.delete(listener)
    },
    listen: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }
}

export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const useValue = store => store.get()

export const host = {
  notify: () => undefined,
  request: async () => ({}),
  state: {}
}

// Real value, verified against app/command-palette/contrib.ts — an earlier
// stub said 'commandPalette', which made a browser assertion pass vacuously.
export const PALETTE_AREA = 'palette'
export const PANES_AREA = 'panes'

export const Button = component('Button')
export const ConfirmDialog = component('ConfirmDialog')
export const ContextMenu = component('ContextMenu')
export const ContextMenuContent = component('ContextMenuContent')
export const ContextMenuItem = component('ContextMenuItem')
export const ContextMenuSeparator = component('ContextMenuSeparator')
export const ContextMenuTrigger = component('ContextMenuTrigger')
export const Codicon = component('Codicon')
export const Dialog = component('Dialog')
export const DialogContent = component('DialogContent')
export const DialogDescription = component('DialogDescription')
export const DialogFooter = component('DialogFooter')
export const DialogHeader = component('DialogHeader')
export const DialogTitle = component('DialogTitle')
export const EmptyState = component('EmptyState')
export const GlyphSpinner = component('GlyphSpinner')
export const Input = component('Input')
export const ScrollArea = component('ScrollArea')
export const Switch = component('Switch')
export const Tip = component('Tip')
