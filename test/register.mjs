// Registers the stub resolver so tests can import the REAL plugin.js.
// Run with: node --import ./test/register.mjs --test test/
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
