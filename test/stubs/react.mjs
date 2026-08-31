// Minimal React stand-in. The tests exercise pure logic, never rendering, so
// these only need to exist as importable names.
export const createElement = (type, props, ...children) => ({ type, props, children })
export const useEffect = () => undefined
export const useRef = () => ({ current: null })
export const useState = initial => [initial, () => undefined]
