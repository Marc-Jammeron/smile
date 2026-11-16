import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { SHARP_CONCURRENCY, configureSharp, parseCpuMax, readCgroupLimits, timed, roundTimings, trackJob, startCpuTimer, takeEventLoopLagP99Ms, startEventLoopMonitor } from '../src/services/runtime-metrics.js';

test('parseCpuMax reads the cgroup v2 quota as a number of vCPU', () => {
    assert.deepEqual(parseCpuMax('100000 100000\n'), { raw: '100000 100000', vcpu: 1 });
    assert.deepEqual(parseCpuMax('150000 100000'), { raw: '150000 100000', vcpu: 1.5 });
    assert.deepEqual(parseCpuMax('max 100000'), { raw: 'max 100000', vcpu: null });
    assert.deepEqual(parseCpuMax(null), { raw: null, vcpu: null });
});

test('readCgroupLimits prefers cgroup v2', () => {
    const files = { '/sys/fs/cgroup/cpu.max': '100000 100000', '/sys/fs/cgroup/memory.max': '1073741824' };
    assert.deepEqual(readCgroupLimits((path) => files[path] ?? null), { cpuMax: '100000 100000', cpuLimitVcpu: 1, memoryMax: '1073741824' });
});

test('readCgroupLimits falls back to cgroup v1, and to nulls without cgroup', () => {
    const v1 = { '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000', '/sys/fs/cgroup/memory/memory.limit_in_bytes': '536870912' };
    assert.deepEqual(readCgroupLimits((path) => v1[path] ?? null), { cpuMax: '200000 100000', cpuLimitVcpu: 2, memoryMax: '536870912' });
    const unlimited = { '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' };
    assert.deepEqual(readCgroupLimits((path) => unlimited[path] ?? null), { cpuMax: null, cpuLimitVcpu: null, memoryMax: null });
    assert.deepEqual(readCgroupLimits(() => null), { cpuMax: null, cpuLimitVcpu: null, memoryMax: null });
});

test('timed accumulates the duration of a stage, even when it throws', async () => {
    const timings = {};
    await timed(timings, 'step', () => new Promise((resolve) => setTimeout(resolve, 20)));
    await timed(timings, 'step', () => new Promise((resolve) => setTimeout(resolve, 20)));
    assert.ok(timings.step >= 30, `expected >= 30 ms, got ${timings.step}`);
    await assert.rejects(timed(timings, 'failing', async () => { throw new Error('boom'); }), /boom/);
    assert.ok('failing' in timings);
    assert.equal(await timed(null, 'ignored', async () => 42), 42);
    assert.deepEqual(roundTimings({ a: 1.4, b: 2.6 }), { a: 1, b: 3 });
});

test('trackJob reports the highest number of jobs that overlapped', () => {
    const finishA = trackJob();
    const finishB = trackJob();
    assert.equal(finishA(), 2);
    const finishC = trackJob();
    assert.equal(finishB(), 2);
    assert.equal(finishC(), 2); // C started while B was running (A was done)
    const finishD = trackJob();
    assert.equal(finishD(), 1); // alone
});

test('startCpuTimer returns user and system CPU time in ms', () => {
    const read = startCpuTimer();
    let x = 0;
    for (let i = 0; i < 2e6; i++) x += Math.sqrt(i);
    const { cpuUserMs, cpuSystemMs } = read();
    assert.ok(x > 0 && Number.isInteger(cpuUserMs) && Number.isInteger(cpuSystemMs));
    assert.ok(cpuUserMs + cpuSystemMs >= 0);
});

test('the event loop lag is null until the monitor runs, then a number', async () => {
    assert.equal(takeEventLoopLagP99Ms(), null);
    startEventLoopMonitor();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lag = takeEventLoopLagP99Ms();
    assert.equal(typeof lag, 'number');
    assert.ok(lag >= 0);
});

test('configureSharp pins sharp.concurrency to 1, whatever libvips picked, and remembers the default', () => {
    assert.equal(SHARP_CONCURRENCY, 1);
    sharp.concurrency(16); // what libvips picks on Alpine: one thread per host core
    assert.deepEqual(configureSharp(), { default: 16, configured: 1 });
    assert.equal(sharp.concurrency(), 1);
    // idempotent: a second call keeps the original default and the setting
    sharp.concurrency(8);
    assert.deepEqual(configureSharp(), { default: 16, configured: 1 });
    assert.equal(sharp.concurrency(), 1);
});
