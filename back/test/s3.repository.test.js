import { test } from 'node:test';
import assert from 'node:assert/strict';

// Presigning is local (no network): dummy credentials are enough.
process.env.S3_ENDPOINT = 'https://s3.example.test';
process.env.S3_REGION = 'fr-par';
process.env.S3_BUCKET = 'test-bucket';
process.env.S3_ACCESS_KEY = 'test-access-key';
process.env.S3_SECRET_KEY = 'test-secret-key';

const { default: s3Repository } = await import('../src/repository/s3.repository.js');

test('getSignedDownloadUrl returns the same URL for the same key (cached)', async () => {
    const first = await s3Repository.getSignedDownloadUrl('uploads/c/photo-thumb.jpg');
    const second = await s3Repository.getSignedDownloadUrl('uploads/c/photo-thumb.jpg');
    assert.equal(second, first);
    assert.match(first, /X-Amz-Expires=300/);
    assert.match(first, /photo-thumb\.jpg/);
});

test('getSignedDownloadUrl signs each key separately', async () => {
    const [a, b] = await Promise.all([
        s3Repository.getSignedDownloadUrl('uploads/c/a.jpg'),
        s3Repository.getSignedDownloadUrl('uploads/c/b.jpg'),
    ]);
    assert.notEqual(a, b);
    assert.match(a, /a\.jpg/);
    assert.match(b, /b\.jpg/);
});
