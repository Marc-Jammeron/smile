import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createLogger, runWithContext, serializeError } from '../src/logger.js';
import { createRequestLogger } from '../src/middleware/request-logger.middleware.js';

// Logger JSON dont les lignes sont capturées en mémoire plutôt qu'écrites sur stdout/stderr.
const capture = (options = {}) => {
    const lines = [];
    const logger = createLogger({
        level: 'debug',
        format: 'json',
        write: (level, line) => lines.push({ level, entry: JSON.parse(line) }),
        ...options
    });
    return { logger, lines };
};

test('only entries at or above the configured level are written', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    assert.deepEqual(lines.map(({ entry }) => entry.msg), ['w', 'e']);
});

test('silent writes nothing, and the level can be changed at runtime', () => {
    const { logger, lines } = capture({ level: 'silent' });
    logger.error('hidden');
    assert.equal(lines.length, 0);
    logger.setLevel('info');
    logger.info('visible');
    assert.equal(lines.length, 1);
    assert.equal(logger.getLevel(), 'info');
    assert.throws(() => logger.setLevel('verbose'), /Unknown log level/);
});

test('LOG_LEVEL and NODE_ENV drive the defaults, and node --test is silent unless asked otherwise', () => {
    const levelOf = (env) => createLogger({ env, write() {} }).getLevel();
    assert.equal(levelOf({}), 'debug');
    assert.equal(levelOf({ NODE_ENV: 'production' }), 'info');
    assert.equal(levelOf({ NODE_ENV: 'production', LOG_LEVEL: 'WARN' }), 'warn');
    assert.equal(levelOf({ LOG_LEVEL: 'nonsense' }), 'debug');
    assert.equal(levelOf({ NODE_TEST_CONTEXT: 'child-v8' }), 'silent');
    assert.equal(levelOf({ NODE_TEST_CONTEXT: 'child-v8', LOG_LEVEL: 'debug' }), 'debug');
});

test('warn and error go to stderr, debug and info to stdout', () => {
    const streams = [];
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    process.stdout.write = () => { streams.push('stdout'); return true; };
    process.stderr.write = () => { streams.push('stderr'); return true; };
    try {
        const logger = createLogger({ level: 'debug', format: 'json' });
        logger.debug('a');
        logger.info('b');
        logger.warn('c');
        logger.error('d');
    } finally {
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
    }
    assert.deepEqual(streams, ['stdout', 'stdout', 'stderr', 'stderr']);
});

test('json entries carry time, level, scope and message, and meta cannot overwrite them', () => {
    const { logger, lines } = capture();
    logger.child('photo').child('service').info('hello', { photoId: 'p1', level: 'fake', msg: 'fake', scope: 'fake' });
    const { entry } = lines[0];
    assert.equal(entry.level, 'info');
    assert.equal(entry.scope, 'photo.service');
    assert.equal(entry.msg, 'hello');
    assert.equal(entry.photoId, 'p1');
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
});

test('errors are serialized with name, message, status and stack', () => {
    const { logger, lines } = capture();
    const error = Object.assign(new Error('boom'), { status: 409, code: 'E_CONFLICT' });
    logger.error('failed', error, { collectionId: 'c1' });
    const { entry } = lines[0];
    assert.equal(entry.collectionId, 'c1');
    assert.equal(entry.error.message, 'boom');
    assert.equal(entry.error.status, 409);
    assert.equal(entry.error.code, 'E_CONFLICT');
    assert.match(entry.error.stack, /boom/);
});

test('an error passed alone, or nested in the meta, is serialized as well', () => {
    const { logger, lines } = capture();
    logger.error('alone', new Error('one'));
    logger.error('nested', { cause: new Error('two') });
    assert.equal(lines[0].entry.error.message, 'one');
    assert.equal(lines[1].entry.cause.message, 'two');
});

test('serializeError follows the cause chain', () => {
    const serialized = serializeError(new Error('outer', { cause: new Error('inner') }));
    assert.equal(serialized.cause.message, 'inner');
});

test('failure logs expected 4xx at warn and anything else at error', () => {
    const { logger, lines } = capture();
    logger.failure('refused', Object.assign(new Error('bad input'), { status: 400 }));
    logger.failure('broken', Object.assign(new Error('bad gateway'), { status: 502 }));
    logger.failure('bug', new Error('no status'));
    assert.deepEqual(lines.map(({ level }) => level), ['warn', 'error', 'error']);
});

test('secrets are redacted at any depth, but other fields are untouched', () => {
    const { logger, lines } = capture();
    logger.info('sensitive', {
        password: 'hunter2',
        accessToken: 'abc',
        nested: { Authorization: 'Bearer xyz', sessionCookie: 'sid', keep: 'visible' },
        list: [{ secret: 's' }],
        collectionId: 'c1',
        emptyToken: null
    });
    const { entry } = lines[0];
    assert.equal(entry.password, '[REDACTED]');
    assert.equal(entry.accessToken, '[REDACTED]');
    assert.equal(entry.nested.Authorization, '[REDACTED]');
    assert.equal(entry.nested.sessionCookie, '[REDACTED]');
    assert.equal(entry.nested.keep, 'visible');
    assert.equal(entry.list[0].secret, '[REDACTED]');
    assert.equal(entry.collectionId, 'c1');
    assert.equal(entry.emptyToken, null);
    assert.doesNotMatch(JSON.stringify(entry), /hunter2|xyz/);
});

test('presigned url signatures are stripped from strings and error messages', () => {
    const { logger, lines } = capture();
    const url = 'https://bucket.s3.example/key?X-Amz-Credential=AKIA%2F2026&X-Amz-Signature=deadbeef&X-Amz-Expires=300';
    logger.info('signed', { url });
    logger.error('with error', new Error(`request to ${url} failed`));
    for (const { entry } of lines) {
        assert.doesNotMatch(JSON.stringify(entry), /deadbeef|AKIA/);
    }
    assert.match(lines[0].entry.url, /X-Amz-Expires=300/);
});

test('huge strings and arrays are truncated, buffers are summarized, cycles survive', () => {
    const { logger, lines } = capture();
    const cyclic = { name: 'loop' };
    cyclic.self = cyclic;
    logger.info('big', {
        text: 'x'.repeat(5000),
        items: Array.from({ length: 100 }, (_, i) => i),
        data: Buffer.alloc(2048),
        cyclic,
        when: new Date('2026-11-03T10:00:00Z'),
        fn() {}
    });
    const { entry } = lines[0];
    assert.ok(entry.text.length < 1100);
    assert.equal(entry.items.length, 21);
    assert.equal(entry.data, '[Buffer 2048 bytes]');
    assert.equal(entry.cyclic.self, '[Circular]');
    assert.equal(entry.when, '2026-11-03T10:00:00.000Z');
    assert.ok(!('fn' in entry));
});

test('the async context (requestId) is attached to every entry, even after an await', async () => {
    const { logger, lines } = capture();
    await runWithContext({ requestId: 'req-1' }, async () => {
        logger.info('before');
        await new Promise(resolve => setTimeout(resolve, 5));
        logger.info('after');
    });
    logger.info('outside');
    assert.equal(lines[0].entry.requestId, 'req-1');
    assert.equal(lines[1].entry.requestId, 'req-1');
    assert.ok(!('requestId' in lines[2].entry));
});

test('pretty format is a readable single line with the stack below', () => {
    const lines = [];
    const logger = createLogger({ level: 'debug', format: 'pretty', color: false, write: (level, line) => lines.push(line) });
    logger.child('s3').warn('Slow call', { key: 'a.jpg' });
    logger.error('Crashed', new Error('boom'));
    assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d{3} WARN {2}\[s3\] Slow call \{ key: 'a\.jpg' \}$/);
    assert.match(lines[1], /ERROR Crashed/);
    assert.match(lines[1], /\n.*Error: boom/);
});

// ---------------------------------------------------------------------------
// Middleware HTTP : vraie requête sur un vrai serveur Express.
// ---------------------------------------------------------------------------

const withServer = async (middleware, handler, fn) => {
    const app = express();
    app.use(middleware);
    handler(app);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    try {
        return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
};

const request = (url) => new Promise((resolve, reject) => {
    http.get(url, (res) => {
        res.resume();
        res.on('end', () => resolve(res));
    }).on('error', reject);
});

test('request logger: sets X-Request-Id, tags handler logs with it, and masks the client token', async () => {
    const { logger, lines } = capture();
    const res = await withServer(createRequestLogger(logger.child('http')), (app) => {
        app.get('/client/:token', async (req, res) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            logger.info('inside handler'); // pas passé par le middleware : seul le contexte async le relie
            res.json({ ok: true });
        });
        app.get('/boom', (req, res) => res.status(500).json({}));
        app.get('/missing', (req, res) => res.status(404).json({}));
    }, async (base) => {
        const first = await request(`${base}/client/SUPER-SECRET-TOKEN`);
        await request(`${base}/boom`);
        await request(`${base}/missing`);
        await request(`${base}/client/SUPER-SECRET-TOKEN/unknown-route`);
        return first;
    });

    const requestId = res.headers['x-request-id'];
    assert.match(requestId, /^[0-9a-f-]{36}$/);

    const inside = lines.find(({ entry }) => entry.msg === 'inside handler');
    assert.equal(inside.entry.requestId, requestId);

    const completed = lines.filter(({ entry }) => entry.msg === 'Request completed');
    assert.deepEqual(completed.map(({ entry }) => [entry.status, entry.level]), [[200, 'info'], [500, 'error'], [404, 'warn'], [404, 'warn']]);
    assert.equal(completed[0].entry.route, '/client/:token');
    assert.equal(completed[0].entry.requestId, requestId);
    assert.equal(completed[3].entry.route, '/client/:token/unknown-route'); // route non reconnue : le jeton reste masqué
    assert.equal(typeof completed[0].entry.durationMs, 'number');
    assert.doesNotMatch(JSON.stringify(lines), /SUPER-SECRET-TOKEN/);
});
