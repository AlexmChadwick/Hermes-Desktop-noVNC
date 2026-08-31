/**
 * The credential store.
 *
 * `createSecretStore` takes its key holder by injection precisely so this can
 * run for real under node: the WebCrypto here is the same `crypto.subtle` the
 * browser provides, and only the IndexedDB round-trip is faked.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSecretStore } from '../plugin.js'

/** Stands in for IndexedDB, holding the CryptoKey object itself. */
function fakeKeyHolder() {
  let stored = null

  return {
    generated: () => stored,
    getStoredKey: async () => stored,
    putStoredKey: async key => {
      stored = key
    }
  }
}

const build = holder =>
  createSecretStore({
    subtle: globalThis.crypto.subtle,
    randomBytes: length => globalThis.crypto.getRandomValues(new Uint8Array(length)),
    getStoredKey: holder.getStoredKey,
    putStoredKey: holder.putStoredKey
  })

describe('createSecretStore', () => {
  it('round-trips credentials', async () => {
    const store = build(fakeKeyHolder())
    const sealed = await store.seal({ username: 'alex', password: 'hunter2' })

    assert.deepEqual(await store.open(sealed), { username: 'alex', password: 'hunter2' })
  })

  it('produces ciphertext, not the password in disguise', async () => {
    // The whole point: what lands in plugin storage must not contain the
    // secret in any readable form.
    const store = build(fakeKeyHolder())
    const sealed = await store.seal({ username: 'alex', password: 'hunter2' })
    const serialized = JSON.stringify(sealed)

    assert.ok(!serialized.includes('hunter2'))
    assert.ok(!serialized.includes('alex'))
    assert.ok(!Buffer.from(sealed.data, 'base64').toString('utf8').includes('hunter2'))
  })

  it('generates a key that cannot be read back out', async () => {
    const holder = fakeKeyHolder()
    await build(holder).seal({ password: 'x' })

    const key = holder.generated()

    assert.equal(key.extractable, false, 'the key must be non-extractable')
    await assert.rejects(() => globalThis.crypto.subtle.exportKey('raw', key))
  })

  it('uses a fresh nonce for every seal, so equal secrets do not look equal', async () => {
    const store = build(fakeKeyHolder())
    const a = await store.seal({ password: 'same' })
    const b = await store.seal({ password: 'same' })

    assert.notEqual(a.iv, b.iv)
    assert.notEqual(a.data, b.data)
  })

  it('reuses the stored key rather than minting one per call', async () => {
    const holder = fakeKeyHolder()
    const store = build(holder)
    const sealed = await store.seal({ password: 'p' })
    const first = holder.generated()

    assert.deepEqual(await store.open(sealed), { password: 'p' })
    assert.equal(holder.generated(), first)
  })

  it('cannot be opened by a different key', async () => {
    const sealed = await build(fakeKeyHolder()).seal({ password: 'hunter2' })

    // A second store with its own key stands in for another profile or a
    // rotated key: the blob is inert without the original.
    assert.equal(await build(fakeKeyHolder()).open(sealed), null)
  })

  it('rejects a tampered blob rather than returning garbage', async () => {
    const holder = fakeKeyHolder()
    const store = build(holder)
    const sealed = await store.seal({ password: 'hunter2' })
    const bytes = Buffer.from(sealed.data, 'base64')
    bytes[0] ^= 0xff

    // AES-GCM authenticates, so a flipped bit fails the tag rather than
    // decrypting to something plausible.
    assert.equal(await store.open({ ...sealed, data: bytes.toString('base64') }), null)
  })

  it('treats an absent or unversioned blob as nothing stored', async () => {
    const store = build(fakeKeyHolder())

    assert.equal(await store.open(null), null)
    assert.equal(await store.open(undefined), null)
    assert.equal(await store.open({ data: 'x' }), null)
  })

  it('survives a key holder that throws, without leaking the failure', async () => {
    const store = createSecretStore({
      subtle: globalThis.crypto.subtle,
      randomBytes: length => globalThis.crypto.getRandomValues(new Uint8Array(length)),
      getStoredKey: async () => {
        throw new Error('no IndexedDB')
      },
      putStoredKey: async () => {}
    })

    await assert.rejects(() => store.seal({ password: 'x' }))
    assert.equal(await store.open({ v: 1, iv: 'AAAA', data: 'AAAA' }), null)
  })
})
