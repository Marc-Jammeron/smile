import test from 'node:test'
import assert from 'node:assert/strict'
import {
    groupFilesForUpload,
    chunkGroupsIntoBatches,
    partitionGroupsByExisting,
    countGroupFiles,
} from '../src/utils/photoGrouping.js'

const file = (name, size = 100, type = '') => ({ name, size, type })
const photo = (originalFilename, { size = 100, status = 'PENDING', id = originalFilename } = {}) => ({ id, originalFilename, size, status })

test('groupFilesForUpload: regroupe JPEG + CR2 + XMP par basename', () => {
    const groups = groupFilesForUpload([file('A.jpg'), file('A.CR2'), file('A.xmp'), file('B.jpg')])
    assert.equal(groups.length, 2)
    const a = groups.find((group) => group.stem === 'A')
    assert.equal(a.mainFile.name, 'A.jpg')
    assert.deepEqual(a.attachmentFiles.map((f) => f.name), ['A.CR2', 'A.xmp'])
})

test('groupFilesForUpload: attachments seuls sans photo existante = orphelin non envoyable', () => {
    const [group] = groupFilesForUpload([file('A.CR2')])
    assert.equal(group.isOrphanAttachment, true)
    assert.equal(group.uploadable, false)
})

test('groupFilesForUpload: attachments seuls rattachés à la photo existante', () => {
    const [group] = groupFilesForUpload([file('A.CR2')], [photo('A.jpg')])
    assert.equal(group.existingPhoto.originalFilename, 'A.jpg')
    assert.equal(group.uploadable, true)
})

test('groupFilesForUpload: la photo existante préférée est de la famille du statut cible', () => {
    const existing = [photo('A.jpg', { status: 'DELIVERED', id: 'delivered' }), photo('A.jpg', { status: 'SELECTED', id: 'original' })]
    // L'original est le dernier de la liste : sans préférence il gagnerait toujours.
    const [forDelivered] = groupFilesForUpload([file('A.tif')], existing, 'DELIVERED')
    assert.equal(forDelivered.existingPhoto.id, 'delivered')
    const [forPending] = groupFilesForUpload([file('A.CR2')], existing, 'PENDING')
    assert.equal(forPending.existingPhoto.id, 'original')
})

test('groupFilesForUpload: en DELIVERED, repli sur l\'original si aucune retouche n\'existe', () => {
    const [group] = groupFilesForUpload([file('A.tif')], [photo('A.jpg', { status: 'SELECTED', id: 'original' })], 'DELIVERED')
    assert.equal(group.existingPhoto.id, 'original')
    assert.equal(group.uploadable, true)
})

test('groupFilesForUpload: un doublon de nom dans le lot est signalé, pas écrasé', () => {
    const first = file('A.jpg', 100)
    const second = file('A.jpg', 200)
    const [group] = groupFilesForUpload([first, second, file('A.CR2'), file('A.cr2')])
    assert.equal(group.mainFile, first)
    assert.deepEqual(group.conflictFiles.map((f) => f.name), ['A.jpg', 'A.cr2'])
    assert.equal(group.attachmentFiles.length, 1)
})

test('groupFilesForUpload: ignore les fichiers système et vides', () => {
    const groups = groupFilesForUpload([file('.DS_Store'), file('Thumbs.db'), file('empty.jpg', 0), file('ok.jpg')])
    assert.deepEqual(groups.map((group) => group.stem), ['ok'])
})

test('chunkGroupsIntoBatches: ne coupe jamais un groupe et respecte le maximum', () => {
    const triplet = (n) => ({ mainFile: file(`${n}.jpg`), attachmentFiles: [file(`${n}.CR2`), file(`${n}.xmp`)] })
    const groups = [1, 2, 3, 4, 5].map(triplet)
    const batches = chunkGroupsIntoBatches(groups, 10)
    assert.deepEqual(batches.map((batch) => batch.length), [3, 2])
    for (const batch of batches) {
        assert.ok(batch.reduce((sum, group) => sum + countGroupFiles(group), 0) <= 10)
    }
    assert.equal(batches.flat().length, 5)
})

test('chunkGroupsIntoBatches: un groupe plus gros que le maximum part seul', () => {
    const big = { mainFile: file('big.jpg'), attachmentFiles: Array.from({ length: 14 }, (_, i) => file(`big${i}.raw`)) }
    const small = { mainFile: file('s.jpg'), attachmentFiles: [] }
    const batches = chunkGroupsIntoBatches([small, big, small], 10)
    assert.deepEqual(batches.map((batch) => batch.length), [1, 1, 1])
})

test('chunkGroupsIntoBatches: liste vide et lot unique', () => {
    assert.deepEqual(chunkGroupsIntoBatches([], 10), [])
    const one = { mainFile: file('a.jpg'), attachmentFiles: [] }
    assert.deepEqual(chunkGroupsIntoBatches([one], 10), [[one]])
})

test('partitionGroupsByExisting: nom + taille, insensible à la casse', () => {
    const groups = [
        { mainFile: file('IMG_1.JPG', 100), attachmentFiles: [] },
        { mainFile: file('IMG_2.jpg', 100), attachmentFiles: [] },
    ]
    const { toUpload, skipped } = partitionGroupsByExisting(groups, [photo('img_1.jpg', { size: 100 })])
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0].group.mainFile.name, 'IMG_1.JPG')
    assert.deepEqual(toUpload.map((g) => g.mainFile.name), ['IMG_2.jpg'])
})

test('partitionGroupsByExisting: même nom mais taille différente = pas un doublon', () => {
    const groups = [{ mainFile: file('IMG_1.jpg', 100), attachmentFiles: [] }]
    const { toUpload, skipped } = partitionGroupsByExisting(groups, [photo('IMG_1.jpg', { size: 999 })])
    assert.equal(skipped.length, 0)
    assert.equal(toUpload.length, 1)
})

test('partitionGroupsByExisting: taille inconnue (null) = comparaison sur le nom seul', () => {
    const groups = [{ mainFile: file('IMG_1.jpg', 100), attachmentFiles: [] }]
    assert.equal(partitionGroupsByExisting(groups, [photo('IMG_1.jpg', { size: null })]).skipped.length, 1)
})

test('partitionGroupsByExisting: une retouche n\'est pas ignorée parce que l\'original existe (et inversement)', () => {
    const groups = [{ mainFile: file('IMG_1.jpg', 100), attachmentFiles: [] }]
    const original = [photo('IMG_1.jpg', { status: 'SELECTED' })]
    assert.equal(partitionGroupsByExisting(groups, original, 'DELIVERED').skipped.length, 0)
    const delivered = [photo('IMG_1.jpg', { status: 'DELIVERED' })]
    assert.equal(partitionGroupsByExisting(groups, delivered, 'DELIVERED').skipped.length, 1)
    assert.equal(partitionGroupsByExisting(groups, delivered, 'PENDING').skipped.length, 0)
})

test('partitionGroupsByExisting: les attachments seuls ne sont jamais ignorés', () => {
    const groups = [{ mainFile: null, attachmentFiles: [file('IMG_1.CR2')], existingPhoto: photo('IMG_1.jpg') }]
    const { toUpload, skipped } = partitionGroupsByExisting(groups, [photo('IMG_1.jpg')])
    assert.equal(skipped.length, 0)
    assert.equal(toUpload.length, 1)
})
