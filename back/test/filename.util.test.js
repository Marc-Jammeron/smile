import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugifyCollectionName, archiveDownloadFilename } from '../src/services/filename.util.js';

test('slugifyCollectionName strips accents and punctuation', () => {
    assert.equal(slugifyCollectionName('Mariage Léa & Hugo !'), 'mariage-lea-hugo');
    assert.equal(slugifyCollectionName('  --Séance   été--  '), 'seance-ete');
});

test('slugifyCollectionName falls back to "collection" when nothing is left', () => {
    assert.equal(slugifyCollectionName('???'), 'collection');
    assert.equal(slugifyCollectionName(''), 'collection');
    assert.equal(slugifyCollectionName(undefined), 'collection');
});

test('archiveDownloadFilename: <slug>-HD-<date>.zip for the selection, <slug>-<date>.zip for the delivered photos', () => {
    const now = new Date('2026-11-21T10:00:00Z');
    assert.equal(archiveDownloadFilename('Mariage Dupont', 'SELECTION_HD', now), 'mariage-dupont-HD-20261121.zip');
    assert.equal(archiveDownloadFilename('Mariage Dupont', 'DELIVERED', now), 'mariage-dupont-20261121.zip');
});
