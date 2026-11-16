import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';

// A tiny in-memory store stands in for the database so the rules (ARCHIVED photos are
// ignored, a FAILED photo blocks the send...) run through the real `where` clauses the
// service builds, instead of a canned count.
let collections = {};
let photos = [];
let updateCollectionCalls = [];

const matchesNotEqual = (condition, value) => (condition?.[Op.ne] === undefined ? true : value !== condition[Op.ne]);

mock.module('../src/repository/db.repository.js', {
    defaultExport: {
        Collection: {
            findByPk: async (id) => (collections[id] ? { ...collections[id] } : null),
            findAll: async ({ where }) => Object.values(collections)
                .filter((collection) => collection.sendRequestedAt !== null && where.sendRequestedAt[Op.ne] === null)
                .map(({ id }) => ({ id })),
            update: async (data, { where }) => {
                if (!collections[where.id]) return [0];
                collections[where.id] = { ...collections[where.id], ...data };
                return [1];
            },
        },
        Photo: {
            count: async ({ where }) => photos.filter((photo) =>
                photo.collectionId === where.collectionId
                && matchesNotEqual(where.status, photo.status)
                && matchesNotEqual(where.processingStatus, photo.processingStatus)
            ).length,
        },
    },
});

// The real updateCollection applies the transition rules and generates the access token
// (covered in collection.service.test.js); here it only has to behave like the manual action.
mock.module('../src/services/collection.service.js', {
    namedExports: {
        updateCollection: async (id, data) => {
            updateCollectionCalls.push({ id, data });
            collections[id] = { ...collections[id], ...data };
            return collections[id];
        },
    },
});

const { updateCollectionOrDeferSend, completeSendIfReady, sweepSendRequests, cancelSendRequest, SEND_DEFERRED_MESSAGE } = await import('../src/services/collection-send.service.js');

const setup = ({ collection = {}, photoStates = [] } = {}) => {
    collections = { 'col-1': { id: 'col-1', status: 'DRAFT', sendRequestedAt: null, accessToken: null, ...collection } };
    photos = photoStates.map((processingStatus, index) => ({ id: index + 1, collectionId: 'col-1', status: 'PENDING', processingStatus }));
    updateCollectionCalls = [];
};

const setProcessing = (id, processingStatus) => {
    photos.find((photo) => photo.id === id).processingStatus = processingStatus;
};

// --- the photographer's action -------------------------------------------------------

test('requesting the link when every photo is DONE moves to SELECTING immediately (200 path)', async () => {
    setup({ photoStates: ['DONE', 'DONE'] });

    const { collection, deferred } = await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

    assert.equal(deferred, false);
    assert.deepEqual(updateCollectionCalls, [{ id: 'col-1', data: { status: 'SELECTING', sendRequestedAt: null } }]);
    assert.equal(collection.status, 'SELECTING');
});

test('requesting the link on a collection without photos is immediate', async () => {
    setup({ photoStates: [] });

    const { deferred } = await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

    assert.equal(deferred, false);
});

for (const pendingState of ['QUEUED', 'PROCESSING']) {
    test(`requesting the link while a photo is ${pendingState} is deferred (202 path): the collection stays DRAFT`, async () => {
        setup({ photoStates: ['DONE', pendingState] });

        const { collection, deferred } = await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

        assert.equal(deferred, true);
        assert.equal(collection.status, 'DRAFT');
        assert.ok(collection.sendRequestedAt instanceof Date, 'the request is recorded');
        assert.deepEqual(updateCollectionCalls, [], 'no transition, hence no access token yet');
        assert.match(SEND_DEFERRED_MESSAGE, /dès que toutes les photos seront prêtes/);
    });
}

test('other fields sent with a deferred request are still applied, but not the status', async () => {
    setup({ photoStates: ['QUEUED'] });

    const { deferred } = await updateCollectionOrDeferSend('col-1', { status: 'SELECTING', name: 'Nouveau nom' });

    assert.equal(deferred, true);
    assert.deepEqual(updateCollectionCalls, [{ id: 'col-1', data: { name: 'Nouveau nom' } }]);
});

test('archived photos do not defer the request', async () => {
    setup({ photoStates: ['DONE'] });
    photos.push({ id: 99, collectionId: 'col-1', status: 'ARCHIVED', processingStatus: 'FAILED' });

    const { deferred } = await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

    assert.equal(deferred, false);
});

test('requests other than DRAFT -> SELECTING go through updateCollection untouched', async () => {
    setup({ photoStates: ['QUEUED'] });

    await updateCollectionOrDeferSend('col-1', { status: 'EDITING' });
    await updateCollectionOrDeferSend('col-1', { name: 'Autre' });
    assert.deepEqual(updateCollectionCalls.map((call) => call.data), [{ status: 'EDITING' }, { name: 'Autre' }]);

    setup({ collection: { status: 'EDITING' }, photoStates: ['QUEUED'] });
    const { deferred } = await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });
    assert.equal(deferred, false, 'EDITING -> SELECTING is never deferred');
    assert.equal(collections['col-1'].sendRequestedAt, null);
});

test('an unknown collection resolves to a null collection', async () => {
    setup();
    const result = await updateCollectionOrDeferSend('missing', { status: 'SELECTING' });
    assert.deepEqual(result, { collection: null, deferred: false });
});

// --- completion by the worker --------------------------------------------------------

test('the transition fires once the last photo of the collection is DONE', async () => {
    setup({ photoStates: ['DONE', 'PROCESSING'] });
    await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

    assert.equal(await completeSendIfReady('col-1'), false, 'one photo is still processing');
    assert.equal(collections['col-1'].status, 'DRAFT');

    setProcessing(2, 'DONE');
    assert.equal(await completeSendIfReady('col-1'), true);

    // Same service as the manual action; the request flag is cleared by the same update.
    assert.deepEqual(updateCollectionCalls.at(-1), { id: 'col-1', data: { status: 'SELECTING', sendRequestedAt: null } });
    assert.equal(collections['col-1'].status, 'SELECTING');
    assert.equal(collections['col-1'].sendRequestedAt, null);
});

test('no transition while a photo is FAILED, then it fires when the photo is retried successfully', async () => {
    setup({ photoStates: ['DONE', 'FAILED'] });
    await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

    assert.equal(await completeSendIfReady('col-1'), false);
    assert.equal(await sweepSendRequests(), 0);
    assert.equal(collections['col-1'].status, 'DRAFT');
    assert.ok(collections['col-1'].sendRequestedAt, 'the request stays pending');

    setProcessing(2, 'QUEUED'); // retry
    assert.equal(await completeSendIfReady('col-1'), false);
    setProcessing(2, 'DONE');
    assert.equal(await completeSendIfReady('col-1'), true);
    assert.equal(collections['col-1'].status, 'SELECTING');
});

test('the transition also fires when the FAILED photo is deleted (archived)', async () => {
    setup({ photoStates: ['DONE', 'FAILED'] });
    await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });

    photos[1].status = 'ARCHIVED';

    assert.equal(await sweepSendRequests(), 1);
    assert.equal(collections['col-1'].status, 'SELECTING');
});

test('nothing happens for a collection without a pending request', async () => {
    setup({ photoStates: ['DONE'] });

    assert.equal(await completeSendIfReady('col-1'), false);
    assert.deepEqual(updateCollectionCalls, []);
});

test('a pending request is dropped when the collection was moved by hand in the meantime', async () => {
    setup({ collection: { status: 'EDITING', sendRequestedAt: new Date() }, photoStates: ['DONE'] });

    assert.equal(await completeSendIfReady('col-1'), false);

    assert.equal(collections['col-1'].sendRequestedAt, null);
    assert.deepEqual(updateCollectionCalls, []);
});

test('a failure of the transition never throws into the worker', async () => {
    setup({ collection: { sendRequestedAt: new Date() }, photoStates: ['DONE'] });
    collections['col-1'].status = 'DRAFT';
    const originalFindByPk = collections;
    collections = new Proxy(originalFindByPk, { get: () => { throw new Error('db down'); } });

    assert.equal(await completeSendIfReady('col-1'), false);
});

test('sweepSendRequests only looks at collections with a pending request', async () => {
    setup({ collection: { sendRequestedAt: new Date() }, photoStates: ['DONE'] });
    collections['col-2'] = { id: 'col-2', status: 'DRAFT', sendRequestedAt: null };

    assert.equal(await sweepSendRequests(), 1);
    assert.deepEqual(updateCollectionCalls.map((call) => call.id), ['col-1']);
});

// --- cancellation --------------------------------------------------------------------

test('the photographer can cancel the request: sendRequestedAt goes back to null and nothing is sent', async () => {
    setup({ photoStates: ['QUEUED'] });
    await updateCollectionOrDeferSend('col-1', { status: 'SELECTING' });
    assert.ok(collections['col-1'].sendRequestedAt);

    const collection = await cancelSendRequest('col-1');

    assert.equal(collection.sendRequestedAt, null);
    setProcessing(1, 'DONE');
    assert.equal(await completeSendIfReady('col-1'), false, 'a cancelled request is never fulfilled');
    assert.equal(collections['col-1'].status, 'DRAFT');
});

test('cancelling on an unknown collection returns null', async () => {
    setup();
    assert.equal(await cancelSendRequest('missing'), null);
});
