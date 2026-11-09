import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLimits, LIMITS } from '../src/config/limits.js';

test('readLimits returns the agreed defaults', () => {
    assert.deepEqual(readLimits({}), {
        maxConfirmPhotos: 10,
        maxConfirmAttachments: 50,
        maxPresignFiles: 50,
        imageProcessingConcurrency: 2,
        sharpConcurrency: 1,
        maxOriginalBytes: 150_000_000,
        maxInputPixels: 150_000_000
    });
});

test('readLimits honours valid environment overrides', () => {
    const limits = readLimits({ IMAGE_PROCESSING_CONCURRENCY: '1', CONFIRM_MAX_PHOTOS: '5', SHARP_CONCURRENCY: '2' });
    assert.equal(limits.imageProcessingConcurrency, 1);
    assert.equal(limits.maxConfirmPhotos, 5);
    assert.equal(limits.sharpConcurrency, 2);
});

test('readLimits falls back to the default on garbage, zero, negative, fractional or too large values', () => {
    for (const bad of ['abc', '0', '-3', '1.5', '999999', ' ', 'NaN']) {
        assert.equal(readLimits({ IMAGE_PROCESSING_CONCURRENCY: bad }).imageProcessingConcurrency, 2, `value ${JSON.stringify(bad)}`);
    }
});

test('LIMITS is frozen', () => {
    assert.ok(Object.isFrozen(LIMITS));
});
