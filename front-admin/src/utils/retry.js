export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function computeBackoffDelay(attempt, { baseMs = 2000, maxMs = 15000, random = Math.random } = {}) {
    const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1))
    return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export async function withRetry(fn, {
    maxAttempts = 3,
    shouldRetry = (error) => error?.retryable === true,
    sleep = defaultSleep,
    random = Math.random,
    baseMs,
    maxMs,
} = {}) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await fn(attempt)
        } catch (error) {
            if (attempt >= maxAttempts || !shouldRetry(error)) throw error
            await sleep(computeBackoffDelay(attempt, { baseMs, maxMs, random }))
        }
    }
}
