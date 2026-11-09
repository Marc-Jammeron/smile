import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { collectToBuffer } from '../src/utils/stream-buffer.js';

const streamOf = (...chunks) => Readable.from(chunks.map((chunk) => Buffer.from(chunk)), { objectMode: false });

test('collectToBuffer fills a pre-sized buffer from several chunks', async () => {
    const buffer = await collectToBuffer(streamOf('hel', 'lo ', 'world'), 11);
    assert.equal(buffer.toString(), 'hello world');
    assert.equal(buffer.length, 11);
});

test('collectToBuffer accepts Uint8Array chunks', async () => {
    const stream = Readable.from([new Uint8Array([1, 2]), new Uint8Array([3])], { objectMode: true });
    assert.deepEqual([...await collectToBuffer(stream, 3)], [1, 2, 3]);
});

test('collectToBuffer handles an empty object', async () => {
    assert.equal((await collectToBuffer(streamOf(), 0)).length, 0);
});

test('collectToBuffer falls back to concat when the size is unknown', async () => {
    for (const unknown of [undefined, null, -1, 1.5, Number.NaN]) {
        assert.equal((await collectToBuffer(streamOf('ab', 'cd'), unknown)).toString(), 'abcd', String(unknown));
    }
});

test('collectToBuffer rejects a stream longer than announced', async () => {
    await assert.rejects(() => collectToBuffer(streamOf('abc', 'def'), 4), /more bytes than announced/);
});

test('collectToBuffer rejects a truncated stream instead of returning uninitialised memory', async () => {
    await assert.rejects(() => collectToBuffer(streamOf('abc'), 10), /ended early: received 3 of 10/);
});
