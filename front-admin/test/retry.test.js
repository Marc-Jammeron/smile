import test from 'node:test'
import assert from 'node:assert/strict'
import { computeBackoffDelay, withRetry } from '../src/utils/retry.js'

const retryable = () => Object.assign(new Error('boom'), { retryable: true })
const fatal = () => Object.assign(new Error('nope'), { retryable: false })

test('computeBackoffDelay: equal jitter borné, croissant, plafonné', () => {
    assert.equal(computeBackoffDelay(1, { baseMs: 2000, random: () => 0 }), 1000)
    assert.equal(computeBackoffDelay(1, { baseMs: 2000, random: () => 1 }), 2000)
    assert.equal(computeBackoffDelay(2, { baseMs: 2000, random: () => 0 }), 2000)
    assert.equal(computeBackoffDelay(2, { baseMs: 2000, random: () => 1 }), 4000)
    assert.equal(computeBackoffDelay(10, { baseMs: 2000, maxMs: 15000, random: () => 1 }), 15000)
})

test('withRetry: réussit au 3e essai après 2 erreurs retentables', async () => {
    const delays = []
    let calls = 0
    const result = await withRetry(async () => {
        calls += 1
        if (calls < 3) throw retryable()
        return 'ok'
    }, { sleep: async (ms) => delays.push(ms), random: () => 0 })
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
    assert.deepEqual(delays, [1000, 2000])
})

test('withRetry: abandonne après maxAttempts et relance la dernière erreur', async () => {
    let calls = 0
    await assert.rejects(
        withRetry(async () => { calls += 1; throw retryable() }, { sleep: async () => {} }),
        /boom/
    )
    assert.equal(calls, 3)
})

test('withRetry: pas de retry sur une erreur non retentable', async () => {
    let calls = 0
    await assert.rejects(
        withRetry(async () => { calls += 1; throw fatal() }, { sleep: async () => {} }),
        /nope/
    )
    assert.equal(calls, 1)
})

test('withRetry: une erreur sans drapeau retryable (bug, TypeError) n\'est pas retentée', async () => {
    let calls = 0
    await assert.rejects(withRetry(async () => { calls += 1; throw new TypeError('x') }, { sleep: async () => {} }))
    assert.equal(calls, 1)
})
