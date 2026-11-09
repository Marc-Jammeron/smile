import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as migration from '../src/migrations/20261109000001-add-unique-keys-to-photos-and-attachments.js';

const fakeContext = ({ photoDuplicates = [], attachmentDuplicates = [], failSecondIndex = false } = {}) => {
    const calls = { indexes: [], removed: [], queries: [], transactions: 0 };
    const transaction = { id: 'tx' };
    const sequelize = {
        transaction: async (callback) => { calls.transactions += 1; return callback(transaction); },
        query: async (sql) => {
            calls.queries.push(sql);
            return sql.includes('FROM "PhotoAttachments"') ? attachmentDuplicates : photoDuplicates;
        },
    };
    const queryInterface = {
        sequelize,
        addIndex: async (table, fields, options) => {
            if (failSecondIndex && calls.indexes.length === 1) throw new Error('index build failed');
            calls.indexes.push({ table, fields, options });
        },
        removeIndex: async (table, name) => { calls.removed.push({ table, name }); },
    };
    return { calls, transaction, context: { context: queryInterface } };
};

test('up creates both unique indexes in one transaction when there are no duplicates', async () => {
    const { calls, transaction, context } = fakeContext();
    await migration.up(context);

    assert.equal(calls.transactions, 1);
    assert.deepEqual(calls.indexes.map(({ table, fields, options }) => [table, fields, options.unique, options.name, options.transaction]), [
        ['Photos', ['collectionId', 'key'], true, 'photos_collection_id_key_unique', transaction],
        ['PhotoAttachments', ['s3Key'], true, 'photo_attachments_s3_key_unique', transaction],
    ]);
});

test('up refuses duplicate photos with a readable report (counts + ids) and creates nothing', async () => {
    const { calls, context } = fakeContext({
        photoDuplicates: [{ collectionId: 'c1', key: 'uploads/c1/uuid-a.jpg', count: 2, ids: [10, 11], statuses: ['PENDING', 'SELECTED'] }],
    });

    await assert.rejects(() => migration.up(context), (error) => {
        assert.match(error.message, /NOTHING was deleted or changed/);
        assert.match(error.message, /Duplicate photos .*: 1 group/);
        assert.match(error.message, /collection c1, key uploads\/c1\/uuid-a\.jpg: 2 rows, ids \[10, 11\], statuses \[PENDING, SELECTED\]/);
        assert.match(error.message, /check-duplicates/);
        return true;
    });
    assert.equal(calls.indexes.length, 0);
});

test('up refuses duplicate attachments with their ids and photo ids', async () => {
    const { calls, context } = fakeContext({
        attachmentDuplicates: [{ s3Key: 'attachments/c1/uuid-a.CR2', count: 3, ids: [1, 2, 3], photoIds: [7, 7, 8] }],
    });

    await assert.rejects(() => migration.up(context), (error) => {
        assert.match(error.message, /Duplicate attachments .*: 1 group/);
        assert.match(error.message, /s3Key attachments\/c1\/uuid-a\.CR2: 3 rows, ids \[1, 2, 3\], photoIds \[7, 7, 8\]/);
        return true;
    });
    assert.equal(calls.indexes.length, 0);
});

test('the duplicate report is capped but still states how many groups remain', () => {
    const photos = Array.from({ length: 25 }, (_, index) => ({ collectionId: 'c', key: `k${index}`, count: 2, ids: [index, index + 100], statuses: ['PENDING', 'PENDING'] }));
    const report = migration.describeDuplicates({ photos, attachments: [] });
    assert.match(report, /25 group\(s\)/);
    assert.match(report, /and 5 more group\(s\)/);
    assert.equal(report.split('\n').filter((line) => line.startsWith('  - ')).length, 20);
});

test('a failure while building the second index propagates (the transaction rolls the first one back)', async () => {
    const { context } = fakeContext({ failSecondIndex: true });
    await assert.rejects(() => migration.up(context), /index build failed/);
});

test('down removes both indexes', async () => {
    const { calls, context } = fakeContext();
    await migration.down(context);
    assert.deepEqual(calls.removed, [
        { table: 'PhotoAttachments', name: 'photo_attachments_s3_key_unique' },
        { table: 'Photos', name: 'photos_collection_id_key_unique' },
    ]);
});

test('the migration source never deletes, updates or drops data', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/migrations/20261109000001-add-unique-keys-to-photos-and-attachments.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /\b(DELETE\s+FROM|DROP\s+TABLE|TRUNCATE|UPDATE\s+")/i);
    assert.doesNotMatch(source, /\.(destroy|bulkDelete|dropTable)\(/);
});
