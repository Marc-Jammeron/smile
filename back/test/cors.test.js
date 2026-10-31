import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';

// app.js imports db.repository.js (real Postgres connection as a module side effect) and
// s3.repository.js, so both are mocked before import, same approach as the service tests.
mock.module('../src/repository/db.repository.js', {
    defaultExport: { Collection: { findOne: async () => null } },
});
mock.module('../src/repository/s3.repository.js', { defaultExport: {} });

const ADMIN = 'https://admin.example.com';
const CLIENT_1 = 'https://collection.example.com';
const CLIENT_2 = 'https://gallery.example.com';
const UNKNOWN = 'https://evil.example.com';

process.env.ADMIN_ORIGIN = ADMIN;
process.env.CLIENT_ORIGIN = ` ${CLIENT_1} , ,${CLIENT_2},`;
process.env.SESSION_SECRET = 'test-secret';

const { default: app } = await import('../app.js');
const { parseOrigins } = await import('../src/config/cors.js');
const { verifyOrigin } = await import('../src/middleware/auth.middleware.js');

let server;
let baseUrl;

before(async () => {
    await new Promise(resolve => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

const ADMIN_PATHS = ['/auth/me', '/collections', '/photos/collection/1', '/settings'];
const CLIENT_PATH = '/client/sometoken';

const request = (path, origin, method = 'GET') =>
    fetch(baseUrl + path, { method, headers: origin ? { Origin: origin } : {} });

const preflight = (path, origin, method) =>
    fetch(baseUrl + path, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' },
    });

test('parseOrigins splits on commas, trims and drops empty entries', () => {
    assert.deepEqual(parseOrigins(' a , ,b,'), ['a', 'b']);
    assert.deepEqual(parseOrigins(''), []);
    assert.deepEqual(parseOrigins(undefined), []);
});

for (const path of ADMIN_PATHS) {
    test(`admin origin is accepted with credentials on ${path}`, async () => {
        const res = await request(path, ADMIN);
        assert.equal(res.headers.get('access-control-allow-origin'), ADMIN);
        assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    });

    test(`admin preflight is accepted on ${path}`, async () => {
        const res = await preflight(path, ADMIN, 'PUT');
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('access-control-allow-origin'), ADMIN);
        assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    });

    for (const [label, origin] of [['client origin', CLIENT_1], ['unknown origin', UNKNOWN]]) {
        test(`${label} is refused on ${path}`, async () => {
            const res = await request(path, origin);
            assert.notEqual(res.status, 500);
            assert.equal(res.headers.get('access-control-allow-origin'), null);
            assert.equal(res.headers.get('access-control-allow-credentials'), null);

            const pre = await preflight(path, origin, 'PUT');
            assert.notEqual(pre.status, 500);
            assert.equal(pre.headers.get('access-control-allow-origin'), null);
        });
    }

    test(`request without Origin is not blocked on ${path}`, async () => {
        const res = await request(path);
        assert.equal(res.status, 401); // reaches requireAuth, no CORS rejection
    });
}

for (const origin of [CLIENT_1, CLIENT_2]) {
    test(`client origin ${origin} is accepted without credentials on /client`, async () => {
        const res = await request(CLIENT_PATH, origin);
        assert.equal(res.status, 404); // reaches the route (token unknown)
        assert.equal(res.headers.get('access-control-allow-origin'), origin);
        assert.equal(res.headers.get('access-control-allow-credentials'), null);

        const pre = await preflight(`${CLIENT_PATH}/validate`, origin, 'POST');
        assert.equal(pre.status, 204);
        assert.equal(pre.headers.get('access-control-allow-origin'), origin);
        assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    });
}

test('admin origin is refused on /client', async () => {
    const res = await request(CLIENT_PATH, ADMIN);
    assert.notEqual(res.status, 500);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('unknown origin is refused on /client', async () => {
    const res = await request(CLIENT_PATH, UNKNOWN);
    assert.notEqual(res.status, 500);
    assert.equal(res.headers.get('access-control-allow-origin'), null);

    const pre = await preflight(CLIENT_PATH, UNKNOWN, 'GET');
    assert.notEqual(pre.status, 500);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
});

test('request without Origin is allowed on /client', async () => {
    const res = await request(CLIENT_PATH);
    assert.equal(res.status, 404);
});

const runVerifyOrigin = (method, origin) => {
    let status = null;
    let nextCalled = false;
    const req = { method, headers: origin ? { origin } : {} };
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    verifyOrigin(req, res, () => { nextCalled = true; });
    return { status, nextCalled };
};

test('verifyOrigin only lets ADMIN_ORIGIN through on mutating methods', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(runVerifyOrigin(method, ADMIN).nextCalled, true);
        assert.equal(runVerifyOrigin(method, CLIENT_1).status, 403);
        assert.equal(runVerifyOrigin(method, UNKNOWN).status, 403);
        assert.equal(runVerifyOrigin(method, undefined).status, 403);
    }
    assert.equal(runVerifyOrigin('GET', UNKNOWN).nextCalled, true);
});
