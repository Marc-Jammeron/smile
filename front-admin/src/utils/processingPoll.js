// Decides, after each processing-status answer, whether the photo list must be reloaded.
//
// The list is expensive (3 presigned URLs per photo, a few hundred KB): it is only worth
// reloading when a photo reached a final state (done or failed counters moved), because
// queued -> processing changes nothing the list shows. Reloads are at least
// `minIntervalMs` apart while photos are still being processed, and one last reload runs
// as soon as the queue is empty, so the list never stays stale.
export const LIST_RELOAD_MIN_INTERVAL_MS = 10_000

export const finalStateKey = ({ done, failed }) => `${done}-${failed}`

// state: { lastKey (null before the first answer), dirty (a change not yet reloaded),
//          lastReloadAt (ms) }
// Returns { key, dirty, reload }: the key to remember, the new `dirty`, and whether to
// reload now. When `reload` is true the caller sets `dirty` to false once the list loaded.
export const planListReload = (status, { lastKey, dirty, lastReloadAt }, now, minIntervalMs = LIST_RELOAD_MIN_INTERVAL_MS) => {
    const key = finalStateKey(status)
    const changed = lastKey !== null && lastKey !== key
    const pending = dirty || changed
    const queueEmpty = status.queued + status.processing === 0
    const reload = pending && (queueEmpty || now - lastReloadAt >= minIntervalMs)
    return { key, dirty: pending, reload }
}
