export async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length)
    let index = 0

    async function runNext() {
        while (index < items.length) {
            const current = index++
            try {
                results[current] = { status: 'fulfilled', value: await worker(items[current], current) }
            } catch (error) {
                results[current] = { status: 'rejected', reason: error }
            }
        }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, runNext)
    await Promise.all(workers)
    return results
}
