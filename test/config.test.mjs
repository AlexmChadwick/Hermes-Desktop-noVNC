// Config parsing/validation and URL construction, exercised against the real
// plugin.js (the SDK and react specifiers are stubbed by test/loader.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  DEFAULT_PATH,
  DEFAULT_PORT,
  buildProbeUrl,
  buildWsUrl,
  endpointLabel,
  normalizeMachine,
  normalizePath,
  parsePastedEndpoint
} from '../plugin.js'

describe('normalizeMachine', () => {
  it('requires a name and a host', () => {
    const result = normalizeMachine({})

    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => e.includes('Name')))
    assert.ok(result.errors.some(e => e.includes('Host')))
  })

  it('still returns a complete machine when invalid, so the editor keeps rendering', () => {
    const { machine } = normalizeMachine({})

    assert.equal(machine.port, DEFAULT_PORT)
    assert.equal(machine.path, DEFAULT_PATH)
    assert.equal(typeof machine.id, 'string')
  })

  it('defaults to view-only — connecting must never grab control unasked', () => {
    const { machine } = normalizeMachine({ name: 'a', host: 'h.example.com' })

    assert.equal(machine.viewOnly, true)
  })

  it('honours an explicit viewOnly: false', () => {
    const { machine } = normalizeMachine({ name: 'a', host: 'h.example.com', viewOnly: false })

    assert.equal(machine.viewOnly, false)
  })

  it('applies websockify defaults', () => {
    const { machine, ok } = normalizeMachine({ name: 'a', host: 'h.example.com' })

    assert.equal(ok, true)
    assert.equal(machine.port, 6080)
    assert.equal(machine.path, 'websockify')
    assert.equal(machine.secure, false)
    assert.equal(machine.quality, 6)
    assert.equal(machine.compression, 2)
    assert.equal(machine.scale, 'fit')
  })

  it('rejects a host that is neither a bare hostname nor a parseable URL', () => {
    for (const host of ['a b', 'user@host', '!!', 'host_name']) {
      const result = normalizeMachine({ name: 'a', host })

      assert.equal(result.ok, false, `expected ${host} to be rejected`)
    }
  })

  it('strips userinfo out of a pasted URL rather than carrying it into the endpoint', () => {
    // Credentials pasted into the host field must not silently ride along.
    const { machine } = normalizeMachine({ name: 'a', host: 'http://u:p@example.com/y' })

    assert.equal(machine.host, 'example.com')
    assert.ok(!JSON.stringify(machine).includes('u:p'))
  })

  it('accepts IPv4 and bracketed IPv6 literals', () => {
    assert.equal(normalizeMachine({ name: 'a', host: '10.0.0.4' }).ok, true)
    assert.equal(normalizeMachine({ name: 'a', host: '[fd00::1]' }).ok, true)
  })

  it('clamps quality and compression into range', () => {
    const { machine } = normalizeMachine({ name: 'a', host: 'h.example.com', quality: 99, compression: -5 })

    assert.equal(machine.quality, 9)
    assert.equal(machine.compression, 0)
  })

  it('reports a non-numeric port instead of silently defaulting', () => {
    const result = normalizeMachine({ name: 'a', host: 'h.example.com', port: 'abc' })

    assert.equal(result.ok, false)
    assert.ok(result.errors.some(e => e.includes('Port')))
  })

  it('preserves the id it is given so edits do not fork the entry', () => {
    const { machine } = normalizeMachine({ name: 'a', host: 'h.example.com', id: 'fixed' }, { id: 'fixed' })

    assert.equal(machine.id, 'fixed')
  })
})

describe('normalizePath', () => {
  it('strips leading and trailing slashes', () => {
    assert.equal(normalizePath('/websockify/'), 'websockify')
    assert.equal(normalizePath('///a/b///'), 'a/b')
  })

  it('defaults when empty and allows an explicitly empty path', () => {
    assert.equal(normalizePath(undefined), DEFAULT_PATH)
    assert.equal(normalizePath('/'), '')
  })
})

describe('parsePastedEndpoint', () => {
  it('leaves a bare host alone', () => {
    assert.equal(parsePastedEndpoint('vnc.example.com'), null)
  })

  it('splits host:port and leaves the default path alone', () => {
    assert.deepEqual(parsePastedEndpoint('vnc.example.com:6081'), {
      host: 'vnc.example.com',
      port: 6081,
      path: undefined,
      secure: false
    })

    // A pasted host:port must not silently wipe the websockify default.
    const { machine } = normalizeMachine({ name: 'a', host: 'vnc.example.com:6081' })

    assert.equal(machine.path, DEFAULT_PATH)
    assert.equal(machine.port, 6081)
  })

  it('understands a full wss URL', () => {
    const parsed = parsePastedEndpoint('wss://vnc.example.com/websockify')

    assert.equal(parsed.host, 'vnc.example.com')
    assert.equal(parsed.secure, true)
    assert.equal(parsed.path, 'websockify')
  })

  it('drops vnc.html — that is the noVNC page, not the socket endpoint', () => {
    const parsed = parsePastedEndpoint('https://desk.example.com/vnc.html?autoconnect=true')

    assert.equal(parsed.host, 'desk.example.com')
    assert.equal(parsed.secure, true)
    assert.equal(parsed.path, '?autoconnect=true')
  })

  it('re-brackets an IPv6 literal so it round-trips through validation', () => {
    const parsed = parsePastedEndpoint('ws://[fd00::1]:6080/websockify')

    assert.equal(parsed.host, '[fd00::1]')
    assert.equal(normalizeMachine({ name: 'a', host: parsed.host }).ok, true)
  })

  it('is used by normalizeMachine, so a pasted URL becomes a valid machine', () => {
    const { machine, ok } = normalizeMachine({ name: 'a', host: 'wss://desk.example.com/vnc.html' })

    assert.equal(ok, true)
    assert.equal(machine.host, 'desk.example.com')
    assert.equal(machine.secure, true)
    assert.equal(machine.port, 443)
  })
})

describe('buildWsUrl', () => {
  const base = name => normalizeMachine({ name: 'm', host: 'vnc.example.com', ...name }).machine

  it('builds a plain ws URL with the websockify port', () => {
    assert.equal(buildWsUrl(base({})), 'ws://vnc.example.com:6080/websockify')
  })

  it('uses wss when secure', () => {
    assert.equal(buildWsUrl(base({ secure: true, port: 6080 })), 'wss://vnc.example.com:6080/websockify')
  })

  it('omits the port when it is the scheme default', () => {
    assert.equal(buildWsUrl(base({ secure: true, port: 443 })), 'wss://vnc.example.com/websockify')
    assert.equal(buildWsUrl(base({ secure: false, port: 80 })), 'ws://vnc.example.com/websockify')
  })

  it('normalizes a path with stray slashes into exactly one separator', () => {
    assert.equal(buildWsUrl(base({ path: '/websockify/' })), 'ws://vnc.example.com:6080/websockify')
  })

  it('supports an empty path', () => {
    assert.equal(buildWsUrl(base({ path: '/' })), 'ws://vnc.example.com:6080/')
  })

  it('preserves a query string in the path (token-authenticated websockify)', () => {
    assert.equal(
      buildWsUrl(base({ path: 'websockify?token=abc' })),
      'ws://vnc.example.com:6080/websockify?token=abc'
    )
  })

  it('keeps IPv6 brackets intact', () => {
    assert.equal(buildWsUrl(base({ host: '[fd00::1]' })), 'ws://[fd00::1]:6080/websockify')
  })

  it('never carries userinfo credentials', () => {
    // Chromium ignores userinfo on a WebSocket URL, so the plugin must not
    // pretend to support it. A second argument must not reintroduce one.
    assert.ok(!buildWsUrl(base({})).includes('@'))
    assert.ok(!buildWsUrl(base({}), { basic: { username: 'a', password: 'b' } }).includes('@'))
  })

  it('carries a websockify token in the path, which is the mechanism that works', () => {
    assert.equal(
      buildWsUrl(base({ path: 'websockify?token=s3cret' })),
      'ws://vnc.example.com:6080/websockify?token=s3cret'
    )
  })
})

describe('buildProbeUrl', () => {
  const base = extra => normalizeMachine({ name: 'm', host: 'vnc.example.com', ...extra }).machine

  it('uses the http twin of the socket scheme', () => {
    assert.equal(buildProbeUrl(base({})), 'http://vnc.example.com:6080/websockify')
    assert.equal(buildProbeUrl(base({ secure: true, port: 443 })), 'https://vnc.example.com/websockify')
  })

  it('never carries credentials — the probe is unauthenticated by design', () => {
    assert.ok(!buildProbeUrl(base({})).includes('@'))
  })
})

describe('endpointLabel', () => {
  it('shows the endpoint without the scheme', () => {
    const machine = normalizeMachine({ name: 'm', host: 'vnc.example.com' }).machine

    assert.equal(endpointLabel(machine), 'vnc.example.com:6080/websockify')
  })
})

describe('machines.sample.json', () => {
  // A sample config that does not actually validate is worse than no sample.
  const sample = JSON.parse(
    readFileSync(new URL('../machines.sample.json', import.meta.url), 'utf8')
  )

  it('every sample machine validates cleanly', () => {
    for (const entry of sample.machines) {
      const result = normalizeMachine(entry, { id: entry.id })

      assert.deepEqual(result.errors, [], `${entry.name} did not validate`)
    }
  })

  it('every sample machine round-trips without being rewritten', () => {
    // Normalizing a stored machine must be a no-op, or hydration on load would
    // silently mutate the user's saved roster.
    for (const entry of sample.machines) {
      const once = normalizeMachine(entry, { id: entry.id }).machine
      const twice = normalizeMachine(once, { id: once.id }).machine

      assert.deepEqual(twice, once, `${entry.name} is not stable under normalization`)
    }
  })

  it('builds the endpoint each sample describes', () => {
    const byId = Object.fromEntries(
      sample.machines.map(m => [m.id, buildWsUrl(normalizeMachine(m, { id: m.id }).machine)])
    )

    assert.equal(byId['m-workshop'], 'ws://127.0.0.1:6080/websockify')
    assert.equal(byId['m-kiosk'], 'wss://kiosk.example.net/websockify?token=REPLACE_ME')
    assert.equal(byId['m-v6'], 'ws://[fd00::1]:6080/websockify')
  })

  it('ships no real credentials', () => {
    const raw = readFileSync(new URL('../machines.sample.json', import.meta.url), 'utf8')

    assert.ok(raw.includes('REPLACE_ME'), 'the token placeholder must stay a placeholder')
    assert.ok(!/password/i.test(raw), 'the sample must not carry a password field')
  })
})
