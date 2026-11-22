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

test('getSignedArchiveDownloadUrl forces a download under the given filename', async () => {
    const url = new URL(await s3Repository.getSignedArchiveDownloadUrl('archives/c/DELIVERED-abc.zip', 'Mariage été (Léa).zip'));
    assert.match(url.pathname, /archives\/c\/DELIVERED-abc\.zip/);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.equal(url.searchParams.get('response-content-type'), 'application/zip');
    assert.equal(
        url.searchParams.get('response-content-disposition'),
        "attachment; filename*=UTF-8''Mariage%20%C3%A9t%C3%A9%20%28L%C3%A9a%29.zip"
    );
});

test('getSignedArchiveDownloadUrl is not cached: the filename is part of the signature', async () => {
    const [a, b] = await Promise.all([
        s3Repository.getSignedArchiveDownloadUrl('archives/c/DELIVERED-abc.zip', 'a.zip'),
        s3Repository.getSignedArchiveDownloadUrl('archives/c/DELIVERED-abc.zip', 'b.zip'),
    ]);
    assert.notEqual(a, b);
});

test('createStreamUpload returns an Upload to await or abort, and sends nothing by itself', async () => {
    const upload = s3Repository.createStreamUpload('archives/c/x.zip', Buffer.from('x'), {
        contentType: 'application/zip',
        partSizeBytes: 16 * 1024 * 1024,
        queueSize: 2,
    });
    assert.equal(typeof upload.done, 'function');
    assert.equal(typeof upload.abort, 'function');
});
