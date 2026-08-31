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

export const PALETTE_AREA = 'commandPalette'
export const PANES_AREA = 'panes'

export const Button = component('Button')
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
