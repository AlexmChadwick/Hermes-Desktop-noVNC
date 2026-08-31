// Reconnect backoff and failure diagnosis.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BACKOFF, backoffDelay, describeClose, describeSecurityFailure } from '../plugin.js'

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
    assert.match(result.detail, /401|404|Upgrade/)
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
