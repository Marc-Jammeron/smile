import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// The real router and the real rate limiters, on a real (ephemeral) HTTP server. Only what
// touches the database is replaced: the token middleware lets everything through, and the
// controllers answer 200.
mock.module('../src/middleware/client.middleware.js', {
    namedExports: { loadGalleryByToken: (req, res, next) => next() },
});
const ok = (req, res) => res.json({ ok: true });
mock.module('../src/controller/client.controller.js', {
    namedExports: {
        getClientGallery: ok, updateClientPhotoSelection: ok, validateClientSelection: ok,
        downloadAllDeliveredPhotos: ok, getClientArchive: ok,
    },
});

const { clientRouter } = await import('../src/router/client.router.js');

const startServer = async () => {
    const app = express();
    app.use('/client', clientRouter);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    return { base: `http://127.0.0.1:${server.address().port}/client`, close: () => new Promise((resolve) => server.close(resolve)) };
};

const hit = async (url, count) => {
    const statuses = [];
    for (let i = 0; i < count; i += 1) {
        statuses.push((await fetch(url)).status);
    }
    return statuses;
};

// One scenario: the limiters keep their counters per IP for the life of the module, so the
// numbers below add up (150 + 250 polls, 100 gallery calls).
test('the ZIP polling has its own rate limit and does not eat the general one', async () => {
    const { base, close } = await startServer();
    try {
        // 150 polls (12 minutes at one every 5 s): well over the general limit of 100.
        const polls = await hit(`${base}/tok/archive`, 150);
        assert.ok(polls.every((status) => status === 200), 'every poll is answered');

        // The rest of the API still has its whole budget, and its own limit still applies.
        const gallery = await hit(`${base}/tok`, 100);
        assert.ok(gallery.every((status) => status === 200));
        assert.equal((await fetch(`${base}/tok`)).status, 429);

        // The polling is limited too, at 400 per 15 minutes.
        const morePolls = await hit(`${base}/tok/archive`, 251);
        assert.equal(morePolls.filter((status) => status === 200).length, 250);
        assert.equal(morePolls.at(-1), 429);
    } finally {
        await close();
    }
});
