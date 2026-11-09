import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { planPhotoPurge, formatPlan, applyPurge, parsePurgeArgs } from '../src/scripts/lib/duplicates.js';

const group = (ids, statuses, key = 'uploads/c1/uuid-a.jpg') => ({ collectionId: 'c1', key, count: ids.length, ids, statuses });

test('planPhotoPurge keeps the lowest id when the statuses are equal', () => {
    const [plan] = planPhotoPurge([group([4, 9, 12], ['PENDING', 'PENDING', 'PENDING'])]);
    assert.deepEqual(plan, { collectionId: 'c1', key: 'uploads/c1/uuid-a.jpg', action: 'dedupe', keep: 4, keepStatus: 'PENDING', remove: [9, 12] });
});

test('planPhotoPurge keeps the row that carries a client decision or a delivery', () => {
    assert.equal(planPhotoPurge([group([1, 2], ['PENDING', 'SELECTED'])])[0].keep, 2);
    assert.equal(planPhotoPurge([group([1, 2], ['PENDING', 'REJECTED'])])[0].keep, 2);
    assert.equal(planPhotoPurge([group([1, 2, 3], ['SELECTED', 'DELIVERED', 'PENDING'])])[0].keep, 2);
    assert.equal(planPhotoPurge([group([1, 2], ['ARCHIVED', 'PENDING'])])[0].keep, 2);
    assert.deepEqual(planPhotoPurge([group([1, 2], ['SELECTED', 'PENDING'])])[0].remove, [2]);
});

test('planPhotoPurge leaves conflicting client decisions to a human', () => {
    const [plan] = planPhotoPurge([group([1, 2], ['SELECTED', 'REJECTED'])]);
    assert.equal(plan.action, 'review');
    assert.match(plan.reason, /conflicting statuses/);
    assert.equal(plan.keep, undefined);
    assert.equal(plan.remove, undefined);
});

test('two rows with the same best decision are not a conflict', () => {
    const [plan] = planPhotoPurge([group([3, 5], ['SELECTED', 'SELECTED'])]);
    assert.equal(plan.action, 'dedupe');
    assert.equal(plan.keep, 3);
});

test('formatPlan spells out what is kept, deleted and left for review, and that only the database is touched', () => {
    const photoPlan = planPhotoPurge([group([1, 2], ['PENDING', 'SELECTED']), group([5, 6], ['SELECTED', 'REJECTED'], 'uploads/c1/uuid-b.jpg')]);
    const text = formatPlan({
        photoPlan,
        attachmentGroups: [{ s3Key: 'attachments/c1/uuid-x.CR2', count: 2, ids: [8, 9], photoIds: [1, 2] }],
        sameFilename: [{}],
    });
    assert.match(text, /KEEP id 2 \(SELECTED\), DELETE rows \[1\] \(database only/);
    assert.match(text, /REVIEW \(will not be touched\).*uuid-b\.jpg/);
    assert.match(text, /attachments\/c1\/uuid-x\.CR2: ids \[8, 9\] on photos \[1, 2\]/);
    assert.match(text, /Info only/);
});

test('parsePurgeArgs is a dry-run unless --apply is given explicitly', () => {
    assert.deepEqual(parsePurgeArgs([]), { apply: false });
    assert.deepEqual(parsePurgeArgs(['--dry-run']), { apply: false });
    assert.deepEqual(parsePurgeArgs(['--appl']), { apply: false });
    assert.deepEqual(parsePurgeArgs(['--apply']), { apply: true });
});

const fakeSequelize = ({ deletedPhotosPerCall, remainingAttachmentDuplicates = [] } = {}) => {
    const executed = [];
    let photoDeletes = 0;
    const sequelize = {
        transaction: async (callback) => callback({ id: 'tx' }),
        query: async (sql, options = {}) => {
            executed.push({ sql: sql.replace(/\s+/g, ' ').trim(), replacements: options.replacements });
            if (sql.includes('UPDATE "PhotoAttachments"')) return [{ id: 1 }, { id: 2 }];
            if (sql.includes('DELETE FROM "PhotoAttachments"')) return [{ id: 9 }];
            if (sql.includes('DELETE FROM "Photos"')) {
                const count = deletedPhotosPerCall?.[photoDeletes] ?? options.replacements.remove.length;
                photoDeletes += 1;
                return Array.from({ length: count }, (_, index) => ({ id: index }));
            }
            if (sql.includes('FROM "PhotoAttachments"')) return remainingAttachmentDuplicates;
            return [];
        },
    };
    return { sequelize, executed };
};

test('applyPurge moves attachments first, then removes duplicate attachments, then the loser photos, in one transaction', async () => {
    const { sequelize, executed } = fakeSequelize();
    const plan = planPhotoPurge([group([1, 2], ['PENDING', 'SELECTED'])]);

    const report = await applyPurge(sequelize, plan);

    assert.deepEqual(report, { movedAttachments: 2, deletedAttachments: 1, deletedPhotos: 1 });
    const kinds = executed.map(({ sql }) => sql.split(' ').slice(0, 3).join(' '));
    assert.deepEqual(kinds.slice(0, 3), ['UPDATE "PhotoAttachments" SET', 'DELETE FROM "PhotoAttachments"', 'DELETE FROM "Photos"']);
    assert.deepEqual(executed[0].replacements, { keep: 2, remove: [1] });
});

test('applyPurge never touches the groups flagged for review', async () => {
    const { sequelize, executed } = fakeSequelize();
    const plan = planPhotoPurge([group([1, 2], ['SELECTED', 'REJECTED'])]);

    const report = await applyPurge(sequelize, plan);

    assert.equal(report.deletedPhotos, 0);
    assert.ok(executed.every(({ sql }) => !sql.startsWith('DELETE FROM "Photos"')));
});

test('applyPurge aborts (rollback) when a delete does not remove exactly the planned rows', async () => {
    const { sequelize } = fakeSequelize({ deletedPhotosPerCall: [0] });
    const plan = planPhotoPurge([group([1, 2], ['PENDING', 'SELECTED'])]);
    await assert.rejects(() => applyPurge(sequelize, plan), /rolling back/);
});

test('applyPurge aborts (rollback) when duplicate attachments remain afterwards', async () => {
    const { sequelize } = fakeSequelize({ remainingAttachmentDuplicates: [{ s3Key: 'x', count: 2, ids: [1, 2], photoIds: [1, 1] }] });
    await assert.rejects(() => applyPurge(sequelize, []), /remain after the purge: rolling back/);
});

test('the maintenance scripts are database-only: they import no S3 / AWS code and no db.repository (which runs migrations)', async () => {
    for (const file of ['check-duplicates.js', 'purge-duplicates.js', 'lib/duplicates.js', 'lib/connect.js']) {
        const source = await readFile(fileURLToPath(new URL(`../src/scripts/${file}`, import.meta.url)), 'utf8');
        const imports = source.split('\n').filter((line) => /^\s*import\b/.test(line)).join('\n');
        assert.doesNotMatch(imports, /s3|aws/i, file);
        assert.doesNotMatch(imports, /db\.repository/, file);
    }
});

test('check-duplicates only issues SELECT statements', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/scripts/check-duplicates.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /applyPurge|DELETE|UPDATE|INSERT/);
});
