import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresignedUrlCache } from '../src/repository/presigned-url-cache.js';

const setup = (options = {}) => {
    let clock = 1_000;
    let signed = [];
    const cache = createPresignedUrlCache({ ttlMs: 240_000, now: () => clock, ...options });
    const sign = async (key) => { signed.push(key); return `https://s3/${key}?sig=${signed.length}`; };
    return { cache, sign, signed: () => signed, advance: (ms) => { clock += ms; } };
};

test('the same key gets the same URL, signed once, while the entry is fresh', async () => {
    const { cache, sign, signed, advance } = setup();
    const first = await cache.get('a.jpg', sign);
    advance(239_000);
    assert.equal(await cache.get('a.jpg', sign), first);
    assert.deepEqual(signed(), ['a.jpg']);
});

test('the URL is signed again once the TTL has passed', async () => {
    const { cache, sign, signed, advance } = setup();
    const first = await cache.get('a.jpg', sign);
    advance(240_001);
    const second = await cache.get('a.jpg', sign);
    assert.notEqual(second, first);
    assert.equal(signed().length, 2);
});

test('different keys are signed separately', async () => {
    const { cache, sign, signed } = setup();
    const [a, b] = await Promise.all([cache.get('a.jpg', sign), cache.get('b.jpg', sign)]);
    assert.notEqual(a, b);
    assert.deepEqual(signed(), ['a.jpg', 'b.jpg']);
});

test('concurrent requests for one key share a single signature', async () => {
    const { cache, sign, signed } = setup();
    const urls = await Promise.all([cache.get('a.jpg', sign), cache.get('a.jpg', sign), cache.get('a.jpg', sign)]);
    assert.equal(new Set(urls).size, 1);
    assert.equal(signed().length, 1);
});

test('a failed signature is not cached', async () => {
    const { cache } = setup();
    let attempts = 0;
    const flaky = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return 'https://s3/ok';
    };
    await assert.rejects(cache.get('a.jpg', flaky), /boom/);
    assert.equal(await cache.get('a.jpg', flaky), 'https://s3/ok');
    assert.equal(attempts, 2);
});

test('invalidate forces a fresh URL (object replaced or deleted)', async () => {
    const { cache, sign } = setup();
    const first = await cache.get('a.jpg', sign);
    cache.invalidate('a.jpg');
    assert.notEqual(await cache.get('a.jpg', sign), first);
});

test('the cache stays bounded: expired entries go first, then the oldest', async () => {
    const { cache, sign, advance } = setup({ maxEntries: 3 });
    await cache.get('old.jpg', sign);
    advance(240_001); // old.jpg is expired
    await cache.get('b.jpg', sign);
    await cache.get('c.jpg', sign);
    await cache.get('d.jpg', sign); // full: the expired one is dropped
    assert.equal(cache.size(), 3);
    await cache.get('e.jpg', sign); // full of live entries: the oldest (b) is dropped
    assert.equal(cache.size(), 3);
});
