import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// The "Runtime configuration" line, with a logger that records what is logged.
const infoLogs = [];
const fakeLogger = { debug() {}, info: (message, fields) => infoLogs.push({ message, fields }), warn() {}, error() {}, failure() {} };
mock.module('../src/logger.js', { defaultExport: { child: () => fakeLogger } });

const { configureSharp, logRuntimeConfig } = await import('../src/services/runtime-metrics.js');

const lastConfigLog = () => infoLogs.findLast(({ message }) => message === 'Runtime configuration').fields;

test('before configureSharp the default is unknown (null)', () => {
    logRuntimeConfig();
    assert.equal(lastConfigLog().sharpConcurrencyDefault, null);
});

test('the Runtime configuration line shows the pinned concurrency and the one libvips picked', () => {
    sharp.concurrency(16);
    configureSharp();
    logRuntimeConfig();
    const fields = lastConfigLog();
    assert.equal(fields.sharpConcurrency, 1);
    assert.equal(fields.sharpConcurrencyDefault, 16);
    for (const name of ['sharpCache', 'availableParallelism', 'uvThreadpoolSize', 'cpuMax', 'cpuLimitVcpu', 'memoryMax']) {
        assert.ok(name in fields, `${name} is logged`);
    }
});
