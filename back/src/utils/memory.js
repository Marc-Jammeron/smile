import { availableParallelism } from 'node:os';
import logger from '../logger.js';

const BYTES_PER_MB = 1024 * 1024;

const toMb = (bytes) => Math.round((bytes / BYTES_PER_MB) * 10) / 10;

// `external` and `arrayBuffers` are where Buffers live (S3 downloads, sharp outputs):
// they are off the V8 heap, so heapUsed alone says nothing about an image-processing spike.
export const getMemorySnapshot = (usage = process.memoryUsage()) => ({
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers)
});

// What the container really got (cgroup limit), as opposed to what the host exposes.
// constrainedMemory() returns 0 (or undefined on old runtimes) when there is no limit.
export const getRuntimeLimits = () => {
    const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
    return {
        nodeVersion: process.version,
        memoryLimitMb: constrained > 0 && constrained < Number.MAX_SAFE_INTEGER ? toMb(constrained) : null,
        availableParallelism: availableParallelism()
    };
};

// Optional heartbeat, off by default (MEMORY_LOG_INTERVAL_MS=0). unref() so it never
// keeps the process alive. Returns the timer, or null when disabled.
export const startMemoryHeartbeat = (intervalMs = Number(process.env.MEMORY_LOG_INTERVAL_MS) || 0, log = logger.child('memory')) => {
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
        return null;
    }
    const timer = setInterval(() => log.info('Memory usage', getMemorySnapshot()), intervalMs);
    timer.unref();
    return timer;
};
