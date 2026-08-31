// Reconnect backoff and failure diagnosis.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BACKOFF,
  backoffDelay,
  describeClose,
  CONNECT_TIMEOUT_MS,
  describeSecurityFailure,
  describeTimeout,
  errorStatus,
  promptOwner,
  VncSession
} from '../plugin.js'

describe('backoffDelay', () => {
  it('is deterministic when random is injected', () => {
    assert.equal(backoffDelay(0, { random: () => 0 }), 250)
    assert.equal(backoffDelay(0, { random: () => 1 }), 500)
  })

  it('grows exponentially across attempts', () => {
    const mid = attempt => backoffDelay(attempt, { random: () => 0.5 })

    assert.equal(mid(0), 375)
    assert.equal(mid(1), 750)
    assert.equal(mid(2), 1500)
    assert.equal(mid(3), 3000)
  })

  it('never exceeds the cap, however many attempts have passed', () => {
    for (const attempt of [8, 20, 100, 1000]) {
      assert.ok(
        backoffDelay(attempt, { random: () => 1 }) <= BACKOFF.capMs,
        `attempt ${attempt} exceeded the cap`
      )
    }
  })

  it('keeps equal-jitter bounds: always at least half the exponential delay', () => {
    // The point of equal jitter over full jitter — a retry never lands
    // near-instantly, so the delay still reads as "we are waiting".
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const exponential = Math.min(BACKOFF.capMs, BACKOFF.baseMs * BACKOFF.factor ** attempt)

      for (let i = 0; i < 50; i += 1) {
        const delay = backoffDelay(attempt)

        assert.ok(delay >= Math.floor(exponential / 2), `attempt ${attempt} delay ${delay} below half`)
        assert.ok(delay <= exponential, `attempt ${attempt} delay ${delay} above the exponential`)
      }
    }
  })

  it('treats a negative attempt as the first one', () => {
    assert.equal(backoffDelay(-3, { random: () => 0 }), backoffDelay(0, { random: () => 0 }))
  })

  it('accepts overridden options', () => {
    assert.equal(backoffDelay(0, { baseMs: 1000, random: () => 0 }), 500)
    assert.equal(backoffDelay(5, { capMs: 2000, random: () => 1 }), 2000)
  })
})

describe('describeClose', () => {
  it('treats a normal close after a live session as a clean, non-retryable end', () => {
    const result = describeClose({ code: 1000, everConnected: true })

    assert.equal(result.retryable, false)
    assert.match(result.title, /Disconnected/)
  })

  it('treats a normal close BEFORE connecting as a rejection, not a clean end', () => {
    // websockify accepting then immediately closing is a real failure mode and
    // must not be reported as "the session ended normally".
    const result = describeClose({ code: 1000, everConnected: false })

    assert.equal(result.retryable, false)
    assert.match(result.title, /Rejected/)
  })

  it('retries 1006 after a live session — that is an ordinary network drop', () => {
    const result = describeClose({ code: 1006, everConnected: true })

    assert.equal(result.retryable, true)
    assert.match(result.title, /lost/i)
  })

  it('does not retry 1006 before connecting when the host answered', () => {
    // Host is up but refused the upgrade: auth or path is wrong, and retrying
    // that just hammers a server that will keep saying no.
    const result = describeClose({ code: 1006, everConnected: false, reachable: true })

    assert.equal(result.retryable, false)
    assert.match(result.detail, /401|404|Upgrade|Sign in/)
  })

  it('offers a sign-in when a reachable host refuses the upgrade', () => {
    // The recoverable case: an auth_basic in front of websockify. Credentials
    // in the URL's userinfo do reach the server, so this is worth offering.
    const result = describeClose({ code: 1006, everConnected: false, reachable: true })

    assert.equal(result.fix?.signIn, true)
  })

  it('tells a machine already marked as needing auth to just sign in', () => {
    const result = describeClose({ code: 1006, everConnected: false, reachable: true, httpAuth: true })

    assert.match(result.detail, /Sign in/)
    assert.equal(result.fix.label, 'Sign in…')
  })

  it('does not retry 1006 when nothing answered at all', () => {
    const result = describeClose({ code: 1006, everConnected: false, reachable: false })

    assert.equal(result.retryable, false)
    assert.match(result.detail, /websockify is running|tunnel/)
  })

  it('stays honest when reachability is unknown', () => {
    const result = describeClose({ code: 1006, everConnected: false, reachable: null })

    assert.equal(result.retryable, false)
    assert.match(result.detail, /websockify is not running|path is wrong/)
  })

  it('never retries a TLS failure', () => {
    const result = describeClose({ code: 1015 })

    assert.equal(result.retryable, false)
    assert.match(result.detail, /certificate/i)
  })

  it('never retries a protocol error', () => {
    assert.equal(describeClose({ code: 1002 }).retryable, false)
  })

  it('retries a server-side restart', () => {
    assert.equal(describeClose({ code: 1012 }).retryable, true)
    assert.equal(describeClose({ code: 1013 }).retryable, true)
    assert.equal(describeClose({ code: 1011 }).retryable, true)
  })

  it('surfaces the server-supplied reason verbatim', () => {
    const result = describeClose({ code: 1011, reason: 'target closed' })

    assert.match(result.detail, /Server said: "target closed"/)
    assert.equal(result.reason, 'target closed')
  })

  it('reports the real close code back to the caller', () => {
    assert.equal(describeClose({ code: 4001 }).code, 4001)
  })

  it('handles an application-specific close code', () => {
    const result = describeClose({ code: 4001 })

    assert.equal(result.retryable, true)
    assert.match(result.title, /4001/)
  })

  it('degrades gracefully with no information at all', () => {
    const result = describeClose({})

    assert.equal(typeof result.title, 'string')
    assert.ok(result.title.length > 0)
  })
})

describe('describeSecurityFailure', () => {
  it('is never retryable — retrying a bad password just locks the account faster', () => {
    assert.equal(describeSecurityFailure({ status: 1 }).retryable, false)
  })

  it('quotes the server reason when one is given', () => {
    const result = describeSecurityFailure({ status: 1, reason: 'Authentication failed' })

    assert.match(result.detail, /"Authentication failed"/)
  })

  it('falls back to the status when the server sends no reason', () => {
    assert.match(describeSecurityFailure({ status: 2 }).detail, /status 2/)
  })
})

describe('errorStatus', () => {
  // The close code is the headline feature; it has to reach the UI, not just
  // the prose. Every error path was building its status by hand and dropping
  // `code`, so the overlay's "Close code N" line could never render.
  it('carries the close code through to the UI status', () => {
    const status = errorStatus(describeClose({ code: 1015 }))

    assert.equal(status.phase, 'error')
    assert.equal(status.code, 1015)
    assert.ok(status.message.length > 0)
    assert.ok(status.detail.length > 0)
  })

  it('carries a refused-upgrade 1006 through', () => {
    assert.equal(errorStatus(describeClose({ code: 1006, reachable: true })).code, 1006)
  })

  it('carries the RFB security status through', () => {
    const status = errorStatus(describeSecurityFailure({ status: 1, reason: 'nope' }))

    assert.equal(status.code, 1)
    assert.match(status.detail, /nope/)
  })

  it('uses null rather than undefined when there is no code', () => {
    // The overlay tests `code !== undefined && code !== null`; undefined from a
    // missing property and null from here must both suppress the line, but a
    // stable shape keeps the merge/replace semantics predictable.
    const status = errorStatus({ title: 't', detail: 'd' })

    assert.equal(status.code, null)
  })

  it('preserves an overridden title and detail', () => {
    const described = describeClose({ code: 1006, everConnected: true })
    const status = errorStatus({ ...described, title: 'Gave up reconnecting', detail: 'x' })

    assert.equal(status.message, 'Gave up reconnecting')
    assert.equal(status.detail, 'x')
    assert.equal(status.code, 1006)
  })
})

describe('promptOwner', () => {
  // Guards the credential-misdirection path: a prompt raised by one session and
  // answered after the user switched machines must not reach the new session.
  it('returns the session when the tokens match', () => {
    const session = { token: 7 }

    assert.equal(promptOwner(session, { token: 7 }), session)
  })

  it('refuses a prompt raised by a different session', () => {
    assert.equal(promptOwner({ token: 8 }, { token: 7 }), null)
  })

  it('refuses when there is no live session', () => {
    assert.equal(promptOwner(null, { token: 7 }), null)
  })

  it('refuses when there is no prompt', () => {
    assert.equal(promptOwner({ token: 7 }, null), null)
  })

  it('never matches two token-less objects', () => {
    // `undefined === undefined` would otherwise be a match, which is exactly
    // the accident this check exists to prevent.
    assert.equal(promptOwner({}, {}), null)
    assert.equal(promptOwner({ token: undefined }, { token: undefined }), null)
  })
})

describe('VncSession.applyDisplaySettings', () => {
  const machine = extra => ({
    id: 'm1',
    viewOnly: true,
    quality: 6,
    compression: 2,
    scale: 'fit',
    shared: true,
    host: 'h.example.com',
    ...extra
  })

  const withStubRfb = m => {
    const session = new VncSession(m, null)
    session.rfb = {}

    return session
  }

  it('applies the machine it is given, not the one captured at construction', () => {
    // The bug this pins: editing a machine creates a NEW object, so re-applying
    // the constructor's captured one silently undid every toggle.
    const session = withStubRfb(machine({ viewOnly: true }))

    session.applyDisplaySettings(machine({ viewOnly: false }))

    assert.equal(session.rfb.viewOnly, false)
  })

  it('re-asserts view-only when the user turns control back off', () => {
    // The dangerous direction: the toolbar would read "View only" while input
    // still reached the remote machine.
    const session = withStubRfb(machine({ viewOnly: false }))

    session.applyDisplaySettings(machine({ viewOnly: true }))

    assert.equal(session.rfb.viewOnly, true)
  })

  it('adopts the edited machine so later reads see it', () => {
    const session = withStubRfb(machine())

    session.applyDisplaySettings(machine({ quality: 9 }))

    assert.equal(session.machine.quality, 9)
    assert.equal(session.rfb.qualityLevel, 9)
  })

  it('falls back to the stored machine when called with no argument', () => {
    const session = withStubRfb(machine({ compression: 7 }))

    session.applyDisplaySettings()

    assert.equal(session.rfb.compressionLevel, 7)
  })

  it('maps scale onto the right pair of noVNC flags', () => {
    const fit = withStubRfb(machine({ scale: 'fit' }))
    fit.applyDisplaySettings()

    assert.equal(fit.rfb.scaleViewport, true)
    assert.equal(fit.rfb.clipViewport, false)

    const actual = withStubRfb(machine({ scale: 'actual' }))
    actual.applyDisplaySettings()

    assert.equal(actual.rfb.scaleViewport, false)
    assert.equal(actual.rfb.clipViewport, true)
  })

  it('does not throw before a connection exists', () => {
    const session = new VncSession(machine(), null)

    session.applyDisplaySettings(machine({ viewOnly: false }))

    assert.equal(session.machine.viewOnly, false)
  })

  it('gives each session a distinct token', () => {
    assert.notEqual(new VncSession(machine(), null).token, new VncSession(machine(), null).token)
  })
})

describe('describeTimeout', () => {
  const machine = extra => ({ host: 'vnc.example.com', port: 6080, secure: false, ...extra })

  it('is retryable — a stalled attempt is often a transient network problem', () => {
    assert.equal(describeTimeout(machine(), 0).retryable, true)
  })

  it('names the endpoint that went quiet', () => {
    const described = describeTimeout(machine(), 0)

    assert.match(described.detail, /vnc\.example\.com:6080/)
    assert.match(described.title, /No answer/)
  })

  it('explains that silence is not the same as refusal', () => {
    // The distinction that matters: a closed port refuses instantly, so a hang
    // means filtered/firewalled rather than "nothing is listening".
    assert.match(describeTimeout(machine(), 0).detail, /refuses immediately|firewall|tunnel/)
  })

  it('suggests TLS when a plain ws attempt to an https endpoint stalls', () => {
    assert.match(describeTimeout(machine({ secure: false }), 0).detail, /Use TLS|443/)
  })

  it('does not suggest TLS when it is already on', () => {
    assert.doesNotMatch(describeTimeout(machine({ secure: true, port: 443 }), 0).detail, /turn on Use TLS/)
  })

  it('distinguishes a socket that opened but never handshook', () => {
    const described = describeTimeout(machine(), 1)

    assert.match(described.title, /never completed the handshake/)
    assert.match(described.detail, /websockify/)
  })

  it('quotes the timeout it actually used', () => {
    const seconds = String(Math.round(CONNECT_TIMEOUT_MS / 1000))

    assert.ok(describeTimeout(machine(), 0).detail.includes(seconds))
  })

  it('is long enough to outlast a slow but working connection', () => {
    assert.ok(CONNECT_TIMEOUT_MS >= 8000, 'too short would abort healthy links on slow networks')
    assert.ok(CONNECT_TIMEOUT_MS <= 30000, 'too long and the pane just looks hung')
  })
})

describe('VncSession stall handling', () => {
  const machine = { id: 'm1', host: 'h.example.com', port: 6080, secure: false, viewOnly: true, quality: 6, compression: 2, scale: 'fit', shared: true }

  const stalled = () => {
    const session = new VncSession(machine, null)
    session.socket = { readyState: 0, close() {} } // CONNECTING: nothing answered

    return session
  }

  it('turns a stalled attempt into a scheduled retry', () => {
    // The bug this pins: with no stall detector the pane sat on "Connecting…"
    // until Chromium's own TCP timeout, because a filtered port never refuses.
    const session = stalled()

    session.failAttempt()

    assert.equal(session.attempt, 1, 'should have consumed one retry attempt')
    assert.ok(session.timer, 'should have scheduled the next attempt')
    session.cancelTimer()
  })

  it('backs off across repeated stalls instead of hammering', () => {
    const session = stalled()

    session.failAttempt()
    session.cancelTimer()
    session.socket = { readyState: 0, close() {} }
    session.failAttempt()

    assert.equal(session.attempt, 2)
    session.cancelTimer()
  })

  it('gives up rather than retrying a dead endpoint forever', () => {
    const session = stalled()
    session.attempt = BACKOFF.maxAttempts

    session.failAttempt()

    assert.equal(session.timer, null, 'must not schedule past the attempt cap')
  })

  it('does nothing once the session has been disposed', () => {
    const session = stalled()
    session.dispose()

    session.failAttempt()

    assert.equal(session.attempt, 0)
    assert.equal(session.timer, null)
  })

  it('clears the stall timer when it tears down', () => {
    const session = new VncSession(machine, null)
    session.connectTimer = setTimeout(() => {}, 60_000)

    session.teardownSocket()

    assert.equal(session.connectTimer, null, 'a stale timer would fail a later attempt')
  })
})

describe('a stalled attempt carries its remedy to the UI', () => {
  const machine = { host: 'h.example.com', port: 6080, secure: false }

  it('describeTimeout attaches the fix', () => {
    assert.deepEqual(describeTimeout(machine, 0).fix.patch, { secure: true, port: 443 })
  })

  it('errorStatus passes the fix through so the overlay can offer it', () => {
    // Without this the diagnosis names the problem but leaves the user to find
    // the editor and translate it into two field changes themselves.
    assert.deepEqual(errorStatus(describeTimeout(machine, 0)).fix.patch, { secure: true, port: 443 })
  })

  it('offers no fix when the endpoint accepted but never handshook', () => {
    // Port and scheme are evidently fine there; the path is the suspect.
    assert.equal(errorStatus(describeTimeout(machine, 1)).fix, null)
  })

  it('offers no fix for an ordinary close', () => {
    assert.equal(errorStatus(describeClose({ code: 1015 })).fix, null)
  })
})
