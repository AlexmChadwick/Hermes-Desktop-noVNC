// Maps the two specifiers the Hermes plugin loader provides at runtime
// (@hermes/plugin-sdk and react) onto local stubs, so plugin.js can be
// imported and its pure logic exercised under plain node.
const STUBS = {
  '@hermes/plugin-sdk': './stubs/sdk.mjs',
  react: './stubs/react.mjs'
}

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier]

  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true }
  }

  return next(specifier, context)
}
