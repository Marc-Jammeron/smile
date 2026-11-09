import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createLimiter, once } from '../src/utils/limiter.js';
import { abortSignalForResponse } from '../src/utils/request-abort.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('createLimiter never runs more than N tasks at once and runs every task', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;
    const results = await Promise.all(Array.from({ length: 7 }, (_, index) => limit(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active -= 1;
        return index;
    })));
    assert.equal(maxActive, 2);
    assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(limit.stats(), { active: 0, queued: 0, max: 2 });
});

test('createLimiter starts queued tasks in FIFO order', async () => {
    const limit = createLimiter(1);
    const started = [];
    await Promise.all([1, 2, 3, 4].map((id) => limit(async () => { started.push(id); await sleep(2); })));
    assert.deepEqual(started, [1, 2, 3, 4]);
});

test('createLimiter releases the slot when a task rejects', async () => {
    const limit = createLimiter(1);
    const outcomes = await Promise.allSettled([
        limit(async () => { throw new Error('boom'); }),
        limit(async () => 'after'),
    ]);
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[1].value, 'after');
    assert.equal(limit.stats().active, 0);
});

test('createLimiter reports queued tasks and falls back to 1 on an invalid limit', async () => {
    const limit = createLimiter(0);
    assert.equal(limit.stats().max, 1);
    let release;
    const first = limit(() => new Promise((resolve) => { release = resolve; }));
    const second = limit(async () => 'second');
    await sleep(1);
    assert.deepEqual(limit.stats(), { active: 1, queued: 1, max: 1 });
    release();
    await first;
    assert.equal(await second, 'second');
});

test('once runs the function a single time and shares its result', async () => {
    let calls = 0;
    const load = once(async () => { calls += 1; return { watermark: true }; });
    const [a, b, c] = await Promise.all([load(), load(), load()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(b, c);
});

test('once shares a rejection and never retries', async () => {
    let calls = 0;
    const load = once(async () => { calls += 1; throw new Error('settings unavailable'); });
    const outcomes = await Promise.allSettled([load(), load()]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['rejected', 'rejected']);
    assert.equal(outcomes[0].reason, outcomes[1].reason);
    assert.equal(calls, 1);
});

// Real HTTP round trip: this is the only way to be sure the flag matches Node 22's behaviour.
const withServer = async (handler, run) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(server.address().port);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
};

test('abortSignalForResponse aborts when the client disconnects before the response', async () => {
    let signal;
    let handlerReached;
    const reached = new Promise((resolve) => { handlerReached = resolve; });
    await withServer((req, res) => {
        signal = abortSignalForResponse(res);
        req.resume();
        handlerReached(); // never answers: the client leaves first
    }, async (port) => {
        const clientRequest = request({ port, host: '127.0.0.1', method: 'POST', path: '/' });
        clientRequest.on('error', () => {});
        clientRequest.end('{"photos":[]}');
        await reached;
        assert.equal(signal.aborted, false, 'a request still being served is not aborted');
        clientRequest.destroy();
        await sleep(50);
        assert.equal(signal.aborted, true);
    });
});

test('abortSignalForResponse does not abort a request whose body was fully read (req close is not a disconnect)', async () => {
    let signal;
    await withServer((req, res) => {
        signal = abortSignalForResponse(res);
        req.on('end', () => setTimeout(() => res.end('ok'), 30));
        req.resume();
    }, async (port) => {
        await new Promise((resolve, reject) => {
            const clientRequest = request({ port, host: '127.0.0.1', method: 'POST', path: '/' }, (response) => {
                response.resume();
                response.on('end', resolve);
            });
            clientRequest.on('error', reject);
            clientRequest.end('{"photos":[]}');
        });
        await sleep(20);
        assert.equal(signal.aborted, false);
    });
});
