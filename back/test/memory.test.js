import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMemorySnapshot, getRuntimeLimits, startMemoryHeartbeat } from '../src/utils/memory.js';

test('getMemorySnapshot reports rss, heapUsed, external and arrayBuffers in MB', () => {
    const snapshot = getMemorySnapshot({ rss: 1024 * 1024 * 512, heapUsed: 1024 * 1024 * 10.04, external: 1024 * 1024, arrayBuffers: 0 });
    assert.deepEqual(snapshot, { rssMb: 512, heapUsedMb: 10, externalMb: 1, arrayBuffersMb: 0 });
});

test('getMemorySnapshot works on the live process', () => {
    const snapshot = getMemorySnapshot();
    for (const field of ['rssMb', 'heapUsedMb', 'externalMb', 'arrayBuffersMb']) {
        assert.equal(typeof snapshot[field], 'number', field);
        assert.ok(snapshot[field] >= 0, field);
    }
});

test('getRuntimeLimits exposes the node version and parallelism', () => {
    const limits = getRuntimeLimits();
    assert.equal(limits.nodeVersion, process.version);
    assert.ok(limits.availableParallelism >= 1);
    assert.ok(limits.memoryLimitMb === null || limits.memoryLimitMb > 0);
});

test('startMemoryHeartbeat is disabled by default and for sub-second intervals', () => {
    assert.equal(startMemoryHeartbeat(0), null);
    assert.equal(startMemoryHeartbeat(500), null);
    assert.equal(startMemoryHeartbeat(Number.NaN), null);
});

test('startMemoryHeartbeat never keeps the process alive (unref timer)', async () => {
    const lines = [];
    const timer = startMemoryHeartbeat(1000, { info: (message, meta) => lines.push({ message, meta }) });
    assert.ok(timer);
    assert.equal(timer.hasRef(), false);
    clearInterval(timer);
    assert.equal(lines.length, 0);
});
