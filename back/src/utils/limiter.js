// FIFO semaphore: `limit(task)` runs `task` as soon as fewer than `maxConcurrent` tasks
// are running, otherwise queues it. The slot is always released, whether the task
// resolves or rejects. Shared at module level it bounds the whole process, not just
// one request.
export const createLimiter = (maxConcurrent) => {
    const max = Number.isInteger(maxConcurrent) && maxConcurrent >= 1 ? maxConcurrent : 1;
    let active = 0;
    const waiting = [];

    const release = () => {
        active -= 1;
        const next = waiting.shift();
        if (next) {
            active += 1;
            next();
        }
    };

    const limit = async (task) => {
        if (active >= max) {
            await new Promise((resolve) => waiting.push(resolve));
        } else {
            active += 1;
        }
        try {
            return await task();
        } finally {
            release();
        }
    };

    limit.stats = () => ({ active, queued: waiting.length, max });
    return limit;
};

// Memoizes the first call's promise, rejection included: every caller shares the same
// outcome and `fn` runs at most once.
export const once = (fn) => {
    let promise = null;
    return () => {
        promise ??= Promise.resolve().then(fn);
        return promise;
    };
};
