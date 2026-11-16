import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planListReload, finalStateKey, LIST_RELOAD_MIN_INTERVAL_MS } from './processingPoll.js'

const status = (queued, processing, done, failed) => ({ queued, processing, done, failed })
const fresh = { lastKey: null, dirty: false, lastReloadAt: 0 }

test('the first answer only records the counters: the list was just loaded', () => {
    const plan = planListReload(status(5, 2, 3, 0), fresh, 1_000)
    assert.deepEqual(plan, { key: '3-0', dirty: false, reload: false })
})

test('queued -> processing moves do not reload the list', () => {
    const state = { lastKey: '3-0', dirty: false, lastReloadAt: 0 }
    assert.equal(planListReload(status(4, 2, 3, 0), state, 60_000).reload, false)
    assert.equal(planListReload(status(3, 2, 3, 0), state, 60_000).reload, false)
})

test('a photo reaching done reloads the list', () => {
    const state = { lastKey: '3-0', dirty: false, lastReloadAt: 0 }
    assert.deepEqual(planListReload(status(3, 2, 4, 0), state, 60_000), { key: '4-0', dirty: true, reload: true })
})

test('a photo reaching failed reloads the list', () => {
    const state = { lastKey: '3-0', dirty: false, lastReloadAt: 0 }
    assert.equal(planListReload(status(3, 1, 3, 1), state, 60_000).reload, true)
})

test('reloads are at least 10 s apart while photos are being processed', () => {
    const justReloaded = { lastKey: '3-0', dirty: false, lastReloadAt: 100_000 }
    const throttled = planListReload(status(3, 2, 4, 0), justReloaded, 103_000)
    assert.deepEqual(throttled, { key: '4-0', dirty: true, reload: false })
    // the change is remembered and reloaded once the interval has passed, with no new change
    const later = planListReload(status(2, 2, 4, 0), { lastKey: throttled.key, dirty: throttled.dirty, lastReloadAt: 100_000 }, 100_000 + LIST_RELOAD_MIN_INTERVAL_MS)
    assert.equal(later.reload, true)
})

test('a final reload runs as soon as the queue is empty, even inside the interval', () => {
    const state = { lastKey: '9-0', dirty: true, lastReloadAt: 100_000 }
    assert.equal(planListReload(status(0, 0, 10, 0), state, 101_000).reload, true)
})

test('nothing changed and the queue is empty: no reload', () => {
    const state = { lastKey: '10-0', dirty: false, lastReloadAt: 0 }
    assert.equal(planListReload(status(0, 0, 10, 0), state, 999_999).reload, false)
})

test('finalStateKey ignores queued and processing', () => {
    assert.equal(finalStateKey(status(1, 1, 7, 2)), finalStateKey(status(0, 0, 7, 2)))
})
