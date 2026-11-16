import os from "node:os";
import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import sharp from "sharp";
import logger from "../logger.js";

const log = logger.child("runtime-metrics");

const NS_PER_MS = 1e6;
const round1 = (value) => Math.round(value * 10) / 10;

// --- Event loop lag -----------------------------------------------------------------

let eventLoopHistogram = null;

// Idempotent. Not started at import time so that tests (and any process that merely
// imports the image pipeline) keep no timer around: the worker starts it.
export const startEventLoopMonitor = () => {
    if (!eventLoopHistogram) {
        eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
        eventLoopHistogram.enable();
    }
};

// p99 of the event loop delay since the previous call (the histogram is reset on read),
// i.e. roughly "since the previous photo was logged". null when the monitor is off or
// has no sample yet. A starved loop (CPU quota used up by sharp) shows up here.
export const takeEventLoopLagP99Ms = () => {
    if (!eventLoopHistogram || eventLoopHistogram.count === 0) {
        return null;
    }
    const p99 = round1(eventLoopHistogram.percentile(99) / NS_PER_MS);
    eventLoopHistogram.reset();
    return p99;
};

// --- Concurrent jobs ----------------------------------------------------------------

const runningJobs = new Set();

// Registers a job and returns `finish()`, which gives the highest number of jobs that
// ran at the same time as this one (itself included).
export const trackJob = () => {
    const job = { peak: 0 };
    runningJobs.add(job);
    for (const running of runningJobs) {
        running.peak = Math.max(running.peak, runningJobs.size);
    }
    return () => {
        runningJobs.delete(job);
        return job.peak;
    };
};

// --- CPU time -----------------------------------------------------------------------

// Process-wide (the API shares the process with the worker unless WORKER_ENABLED=false),
// so with concurrent jobs it covers all of them: read it together with `concurrentJobs`.
// wall time >> user+system means the process was waiting (I/O) or throttled by the quota.
export const startCpuTimer = () => {
    const startedAt = process.cpuUsage();
    return () => {
        const { user, system } = process.cpuUsage(startedAt);
        return { cpuUserMs: Math.round(user / 1000), cpuSystemMs: Math.round(system / 1000) };
    };
};

// --- Stage timings ------------------------------------------------------------------

// Runs `fn`, adds its duration to timings[name] (a stage may run several times).
export const timed = async (timings, name, fn) => {
    if (!timings) {
        return fn();
    }
    const startedAt = performance.now();
    try {
        return await fn();
    } finally {
        timings[name] = (timings[name] ?? 0) + (performance.now() - startedAt);
    }
};

export const roundTimings = (timings) =>
    Object.fromEntries(Object.entries(timings).map(([name, ms]) => [name, Math.round(ms)]));

// --- Startup config -----------------------------------------------------------------

// cgroup v2 "cpu.max" is "<quota> <period>" or "max <period>" (no limit).
export const parseCpuMax = (content) => {
    const [quota, period] = String(content ?? "").trim().split(/\s+/);
    const periodUs = Number(period);
    if (quota === "max" || !Number.isFinite(Number(quota)) || !Number.isFinite(periodUs) || periodUs <= 0) {
        return { raw: String(content ?? "").trim() || null, vcpu: null };
    }
    return { raw: `${quota} ${period}`, vcpu: round1(Number(quota) / periodUs) };
};

const readTextFile = (path) => {
    try {
        return readFileSync(path, "utf8").trim();
    } catch {
        return null;
    }
};

// cgroup v2 first, then v1 (cfs_quota_us is -1 without a limit).
export const readCgroupLimits = (read = readTextFile) => {
    const cpuMaxV2 = read("/sys/fs/cgroup/cpu.max");
    let cpu;
    if (cpuMaxV2 !== null) {
        cpu = parseCpuMax(cpuMaxV2);
    } else {
        const quota = read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
        const period = read("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
        cpu = quota === null || period === null || Number(quota) < 0
            ? { raw: null, vcpu: null }
            : parseCpuMax(`${quota} ${period}`);
    }
    const memory = read("/sys/fs/cgroup/memory.max") ?? read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    return { cpuMax: cpu.raw, cpuLimitVcpu: cpu.vcpu, memoryMax: memory };
};

// --- sharp ---------------------------------------------------------------------------

// libvips threads per sharp operation. On Alpine (musl) sharp leaves libvips with one
// thread per core of the *host* (16 on a 16-core machine), ignoring the container's CPU
// quota: with 1 vCPU that over-subscription made a photo ~1.8x slower than with a single
// thread (bench, node:22-alpine --cpus=1: 478 ms -> 269 ms). On glibc sharp already uses 1.
// The photos are processed in parallel by the worker (WORKER_CONCURRENCY), so one thread
// per photo is what the CPU quota can actually serve.
export const SHARP_CONCURRENCY = 1;

let sharpConcurrencyDefault = null;

// Call once at startup, in every entry point (API and worker). Idempotent.
export const configureSharp = () => {
    if (sharpConcurrencyDefault === null) {
        sharpConcurrencyDefault = sharp.concurrency();
    }
    sharp.concurrency(SHARP_CONCURRENCY);
    return { default: sharpConcurrencyDefault, configured: sharp.concurrency() };
};

export const logRuntimeConfig = () => {
    log.info("Runtime configuration", {
        sharpConcurrency: sharp.concurrency(),
        // What sharp/libvips picked on its own before configureSharp() (null: never called).
        sharpConcurrencyDefault,
        sharpCache: sharp.cache(),
        sharpVersion: sharp.versions?.sharp,
        libvipsVersion: sharp.versions?.vips,
        availableParallelism: os.availableParallelism(),
        uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "(unset, libuv default 4)",
        nodeVersion: process.version,
        ...readCgroupLimits()
    });
};
