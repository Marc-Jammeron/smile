// Memory / CPU benchmark of generateDerivedImages on REAL JPEG files. No MinIO, no database,
// no network: S3 is stubbed (the original is read from a local directory through the same
// stream->Buffer code the app uses, the outputs are only counted) and the DB module is mocked.
// Read-only on the input files. Never touches production.
//
// Run it under the production limits, in the production image (see the README block below):
//
//   docker build -t smile-back-bench back/
//   docker run --rm --memory=1g --memory-swap=1g --cpus=0.25 -v /path/to/jpegs:/photos:ro \
//     smile-back-bench node --experimental-test-module-mocks src/scripts/bench-derived-images.js \
//     --dir /photos --count 30 --chunk 3
//
// Before/after: run the same command from a checkout of the old code (copy this file into it).
// This script only depends on files that exist in both versions (it falls back to the old
// "chunks + Buffer.concat" download when src/utils/stream-buffer.js is absent).
//
// Options:
//   --dir <path>        directory of .jpg/.jpeg files (cycled when --count exceeds them)
//   --generate          fill --dir with synthetic noisy JPEGs when it has none (--megapixels, default 24)
//   --count <n>         photos to process (default 30)
//   --chunk <n>         photos per simulated confirm request, requests are sequential (default 3)
//   --watermark / --no-watermark   (default: watermark, like a PENDING upload)
//   --json              print the result as JSON only
// Environment: IMAGE_PROCESSING_CONCURRENCY (default 2), SHARP_CONCURRENCY (default 1),
//   LOG_LEVEL (default warn). Both are read by the app code under test as well.
import { mock } from 'node:test';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

process.env.LOG_LEVEL ??= 'warn';
// Placeholders only, so importing the S3 module stays quiet. No S3 call is ever made (stubbed below).
process.env.S3_BUCKET ??= 'bench';
process.env.S3_ACCESS_KEY ??= 'bench';
process.env.S3_SECRET_KEY ??= 'bench';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);

const COUNT = Number(option('count', 30));
const CHUNK = Number(option('chunk', 3));
const CONCURRENCY = Number(process.env.IMAGE_PROCESSING_CONCURRENCY) || 2;
const WATERMARK = !flag('no-watermark');
const AS_JSON = flag('json');
const DIR = option('dir', path.join(tmpdir(), 'smile-bench-jpegs'));

const say = (...parts) => { if (!AS_JSON) console.log(...parts); };

// --- inputs -------------------------------------------------------------------------------
const listJpegs = async (dir) => {
    try {
        return (await readdir(dir)).filter((name) => /\.jpe?g$/i.test(name)).sort().map((name) => path.join(dir, name));
    } catch {
        return [];
    }
};

const generateSyntheticJpegs = async (dir, megapixels) => {
    await mkdir(dir, { recursive: true });
    const height = Math.round(Math.sqrt((megapixels * 1_000_000) / 1.5));
    const width = Math.round(height * 1.5);
    say(`Generating 4 synthetic ${megapixels} Mpx JPEGs (${width}x${height}) in ${dir} ...`);
    for (let index = 0; index < 4; index += 1) {
        const buffer = await sharp({ create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 50 } } })
            .jpeg({ quality: 92 }).toBuffer();
        await writeFile(path.join(dir, `synthetic-${index}.jpg`), buffer);
    }
};

let files = await listJpegs(DIR);
if (files.length === 0 && flag('generate')) {
    await generateSyntheticJpegs(DIR, Number(option('megapixels', 24)));
    files = await listJpegs(DIR);
}
if (files.length === 0) {
    console.error(`No JPEG found in ${DIR}. Pass --dir <path> with real files, or --generate for synthetic ones.`);
    process.exit(2);
}

// --- stubs --------------------------------------------------------------------------------
mock.module('../repository/db.repository.js', {
    defaultExport: { GallerySettings: { findByPk: async () => null } }, // no saved settings => default watermark
});

const here = fileURLToPath(new URL('.', import.meta.url));
let collectToBuffer;
try {
    ({ collectToBuffer } = await import(path.join(here, '../utils/stream-buffer.js')));
} catch {
    collectToBuffer = async (stream) => { // the pre-optimisation download: all chunks, then concat
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
    };
}

const s3Repository = (await import('../repository/s3.repository.js')).default;
const sources = new Map();
let outputBytes = 0;
s3Repository.getObject = async (key) => {
    const file = sources.get(key);
    const { size } = await stat(file);
    return collectToBuffer(createReadStream(file), size);
};
s3Repository.putObject = async (key, body) => { outputBytes += body.length; return key; };

const { generateDerivedImages } = await import('../services/image-processing.service.js');
const settingsService = await import('../services/settings.service.js');
const watermarkConfig = WATERMARK && settingsService.loadWatermarkConfig ? await settingsService.loadWatermarkConfig() : undefined;

// --- measurement --------------------------------------------------------------------------
const readNumber = async (file) => {
    try {
        const raw = (await readFile(file, 'utf8')).trim();
        return raw === 'max' ? null : Number(raw);
    } catch {
        return null;
    }
};
const MB = 1024 * 1024;
const peaks = { rss: 0, external: 0, arrayBuffers: 0, heapUsed: 0, cgroupCurrent: 0 };
const sample = async () => {
    const usage = process.memoryUsage();
    peaks.rss = Math.max(peaks.rss, usage.rss);
    peaks.external = Math.max(peaks.external, usage.external);
    peaks.arrayBuffers = Math.max(peaks.arrayBuffers, usage.arrayBuffers);
    peaks.heapUsed = Math.max(peaks.heapUsed, usage.heapUsed);
    peaks.cgroupCurrent = Math.max(peaks.cgroupCurrent, (await readNumber('/sys/fs/cgroup/memory.current')) ?? 0);
};
const sampler = setInterval(sample, 50);

// Tiny FIFO semaphore (same behaviour as src/utils/limiter.js, inlined so the bench also runs on the old code).
let active = 0;
const waiting = [];
const limit = async (task) => {
    if (active >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve)); else active += 1;
    try { return await task(); } finally {
        const next = waiting.shift();
        if (next) next(); else active -= 1;
    }
};

const keys = Array.from({ length: COUNT }, (_, index) => {
    const key = `uploads/bench/${index}-${path.basename(files[index % files.length])}`;
    sources.set(key, files[index % files.length]);
    return key;
});

say(`sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}, sharp.concurrency=${sharp.concurrency()}, cache=${JSON.stringify(sharp.cache())}`);
say(`${COUNT} photos from ${files.length} file(s), ${CHUNK} per request (sequential requests), pool=${CONCURRENCY}, watermark=${WATERMARK}, cpus visible=${availableParallelism()}`);

const photoMs = [];
const requestMs = [];
const failures = [];
const startedAt = performance.now();
for (let offset = 0; offset < keys.length; offset += CHUNK) {
    const requestStart = performance.now();
    await Promise.all(keys.slice(offset, offset + CHUNK).map((key) => limit(async () => {
        const photoStart = performance.now();
        try {
            await generateDerivedImages(key, { watermark: WATERMARK, watermarkConfig });
            photoMs.push(performance.now() - photoStart);
        } catch (error) {
            failures.push({ key, error: error.message });
        }
    })));
    requestMs.push(performance.now() - requestStart);
}
const totalMs = performance.now() - startedAt;
await sample();
clearInterval(sampler);

const percentile = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value, digits = 0) => (value === null ? null : Number(value.toFixed(digits)));
const cgroupLimit = await readNumber('/sys/fs/cgroup/memory.max');
const cgroupPeak = await readNumber('/sys/fs/cgroup/memory.peak');

const result = {
    photos: COUNT - failures.length,
    failed: failures.length,
    totalSeconds: round(totalMs / 1000, 1),
    photosPerMinute: round((photoMs.length / totalMs) * 60_000, 1),
    perPhotoMs: { p50: round(percentile(photoMs, 50)), p95: round(percentile(photoMs, 95)) },
    perRequestMs: { p50: round(percentile(requestMs, 50)), p95: round(percentile(requestMs, 95)) },
    peakMb: {
        rssSampled: round(peaks.rss / MB),
        rssMaxResident: round((process.resourceUsage().maxRSS * 1024) / MB), // kernel-accurate peak RSS
        external: round(peaks.external / MB),
        arrayBuffers: round(peaks.arrayBuffers / MB),
        heapUsed: round(peaks.heapUsed / MB),
        cgroupCurrentSampled: peaks.cgroupCurrent ? round(peaks.cgroupCurrent / MB) : null,
        cgroupPeak: cgroupPeak ? round(cgroupPeak / MB) : null,
    },
    cgroupLimitMb: cgroupLimit ? round(cgroupLimit / MB) : null,
    outputMb: round(outputBytes / MB, 1),
};
const peakForVerdict = result.peakMb.cgroupPeak ?? result.peakMb.rssMaxResident;
if (result.cgroupLimitMb) {
    result.peakPercentOfLimit = round((peakForVerdict / result.cgroupLimitMb) * 100);
}

if (AS_JSON) {
    console.log(JSON.stringify({ ...result, failures }, null, 2));
} else {
    console.log('\nResult');
    console.log(JSON.stringify(result, null, 2));
    if (failures.length > 0) console.log('Failures:', failures.slice(0, 5));
    if (result.peakPercentOfLimit !== undefined) {
        console.log(`\nPeak memory: ${peakForVerdict} MB = ${result.peakPercentOfLimit}% of the ${result.cgroupLimitMb} MB limit (target: under 60%).`);
    } else {
        console.log('\nNo cgroup memory limit visible (not running in a limited container): run it with docker --memory=1g.');
    }
}
process.exit(failures.length > 0 ? 1 : 0);
