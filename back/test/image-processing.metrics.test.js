import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

// Checks the timed "Derived images generated" log line. Same mocks as
// image-processing.service.test.js, plus a logger that records what is logged.
const infoLogs = [];
const fakeLogger = { debug() {}, info: (message, fields) => infoLogs.push({ message, fields }), warn() {}, error() {}, failure() {} };

mock.module('../src/logger.js', { defaultExport: { child: () => fakeLogger } });

const originalBuffer = await sharp({ create: { width: 1500, height: 1000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
const watermarkImage = await sharp({ create: { width: 100, height: 40, channels: 4, background: '#ff0000' } }).png().toBuffer();

const slow = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
let getObjectFails = false;

mock.module('../src/repository/s3.repository.js', {
    defaultExport: {
        getObject: async () => {
            if (getObjectFails) throw new Error('S3 down');
            return slow(15, originalBuffer);
        },
        putObject: async (key) => slow(10, key),
    },
});
mock.module('../src/services/settings.service.js', {
    namedExports: {
        validateWatermarkValues: async (values) => values,
        loadSavedWatermarkValues: async () => slow(5, {}),
        buildWatermarkConfig: async () => slow(5, { image: watermarkImage, position: 'southeast', opacity: 1, size: null, margin: 24 }),
    },
});

const { generateDerivedImages } = await import('../src/services/image-processing.service.js');
const { trackJob } = await import('../src/services/runtime-metrics.js');

const lastLine = () => infoLogs.findLast(({ message }) => message === 'Derived images generated').fields;

test('the line carries the time of every stage, CPU, event loop lag and concurrency', async () => {
    await generateDerivedImages('uploads/c/x.jpg', { watermark: true });
    const fields = lastLine();
    assert.deepEqual(Object.keys(fields.timings).sort(), [
        'composeEncodeMs', 'decodeResizeMs', 'thumbnailMs', 's3GetMs', 's3PutMs', 'settingsMs', 'watermarkMs', 'watermarkPrepMs'
    ].sort());
    for (const value of Object.values(fields.timings)) {
        assert.ok(Number.isInteger(value) && value >= 0);
    }
    assert.ok(fields.timings.s3GetMs >= 10);
    assert.ok(fields.timings.s3PutMs >= 8);
    assert.ok(fields.timings.settingsMs >= 3 && fields.timings.watermarkPrepMs >= 3);
    assert.ok(fields.durationMs >= fields.timings.s3GetMs + fields.timings.s3PutMs);
    assert.ok(Number.isInteger(fields.cpuUserMs) && Number.isInteger(fields.cpuSystemMs));
    assert.equal(fields.eventLoopLagP99Ms, null); // the monitor is started by the worker, not here
    assert.equal(fields.concurrentJobs, 1);
});

test('without watermark there is no settings, watermark stage', async () => {
    await generateDerivedImages('uploads/c/x.jpg', { watermark: false });
    const { timings } = lastLine();
    assert.deepEqual(Object.keys(timings).sort(), ['composeEncodeMs', 'decodeResizeMs', 's3GetMs', 's3PutMs', 'thumbnailMs']);
});

test('concurrentJobs counts the photos processed at the same time', async () => {
    await Promise.all([
        generateDerivedImages('uploads/c/a.jpg', { watermark: false }),
        generateDerivedImages('uploads/c/b.jpg', { watermark: false }),
    ]);
    assert.equal(lastLine().concurrentJobs, 2);
});

test('a failed photo does not stay counted as a running job', async () => {
    getObjectFails = true;
    await assert.rejects(generateDerivedImages('uploads/c/x.jpg', { watermark: false }), /S3 down/);
    getObjectFails = false;
    await generateDerivedImages('uploads/c/x.jpg', { watermark: false });
    assert.equal(lastLine().concurrentJobs, 1);
    assert.equal(trackJob()(), 1); // nothing else is registered
});
