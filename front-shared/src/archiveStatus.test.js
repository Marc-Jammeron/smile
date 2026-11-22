import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isArchivePending, formatArchiveSize, describeDownloadAllButton, describeSelectionHdButton } from './archiveStatus.js'

const GO = 1024 ** 3

test('QUEUED and PROCESSING are pending, DONE and FAILED are not', () => {
    assert.equal(isArchivePending('QUEUED'), true)
    assert.equal(isArchivePending('PROCESSING'), true)
    assert.equal(isArchivePending('DONE'), false)
    assert.equal(isArchivePending('FAILED'), false)
    assert.equal(isArchivePending(undefined), false)
})

test('sizes are written in French units, with a decimal comma for the large ones', () => {
    assert.equal(formatArchiveSize(1.4 * GO), '1,4 Go')
    assert.equal(formatArchiveSize(5 * GO), '5 Go')
    assert.equal(formatArchiveSize(850 * 1024 ** 2), '850 Mo')
    assert.equal(formatArchiveSize(12 * 1024), '12 Ko')
    assert.equal(formatArchiveSize(2.25 * 1024 ** 4), '2,3 To')
    assert.equal(formatArchiveSize(512), '512 o')
})

test('an unknown size is null', () => {
    for (const value of [null, undefined, 0, -5, NaN, '1500']) {
        assert.equal(formatArchiveSize(value), null)
    }
})

test('while the ZIP is prepared the button is disabled and says so', () => {
    for (const status of ['QUEUED', 'PROCESSING']) {
        assert.deepEqual(describeDownloadAllButton({ status }), { label: 'Préparation de votre ZIP…', disabled: true, failed: false })
    }
})

test('once the ZIP is DONE the button is active and shows the size', () => {
    const button = describeDownloadAllButton({ status: 'DONE', sizeBytes: 1.4 * GO, photoCount: 187 })
    assert.deepEqual(button, { label: 'Télécharger tout, 1,4 Go', disabled: false, failed: false })
})

test('a DONE ZIP of unknown size still downloads', () => {
    assert.deepEqual(describeDownloadAllButton({ status: 'DONE', sizeBytes: null }), { label: 'Télécharger tout', disabled: false, failed: false })
})

test('a FAILED ZIP disables the button and points to the photographer', () => {
    assert.deepEqual(describeDownloadAllButton({ status: 'FAILED' }, { photographerName: 'Emma' }), {
        label: 'ZIP indisponible, contactez Emma', disabled: true, failed: true
    })
    assert.match(describeDownloadAllButton({ status: 'FAILED' }).label, /contactez votre photographe/)
})

test('without archive info the button is usable: the click asks the server, which queues the ZIP', () => {
    assert.deepEqual(describeDownloadAllButton(null), { label: 'Télécharger tout', disabled: false, failed: false })
    assert.deepEqual(describeDownloadAllButton(undefined), { label: 'Télécharger tout', disabled: false, failed: false })
})

test('while the click is being answered the button waits, whatever the state', () => {
    assert.equal(describeDownloadAllButton({ status: 'DONE', sizeBytes: GO }, { downloading: true }).disabled, true)
})

// --- retouching ZIP (admin) ---------------------------------------------------------------------

test('retouching ZIP: with no ZIP yet the button is usable, a click queues it', () => {
    const button = describeSelectionHdButton(null, { selectedCount: 187 })
    assert.deepEqual(button, { label: 'Télécharger la sélection HD (187 photos)', disabled: false, busy: false, failed: false, title: undefined })
})

test('retouching ZIP: singular for one photo', () => {
    assert.equal(describeSelectionHdButton(null, { selectedCount: 1 }).label, 'Télécharger la sélection HD (1 photo)')
})

test('retouching ZIP: while it is prepared the button is disabled and busy', () => {
    for (const status of ['QUEUED', 'PROCESSING']) {
        assert.deepEqual(describeSelectionHdButton({ status }, { selectedCount: 5 }), {
            label: 'Préparation du ZIP…', disabled: true, busy: true, failed: false, title: undefined
        })
    }
})

test('retouching ZIP: once DONE the button shows the size', () => {
    const button = describeSelectionHdButton({ status: 'DONE', sizeBytes: 1.4 * GO }, { selectedCount: 187 })
    assert.equal(button.label, 'Télécharger la sélection HD (187 photos, 1,4 Go)')
    assert.equal(button.disabled, false)
})

test('retouching ZIP: a FAILED ZIP is flagged and carries the error as a tooltip', () => {
    const button = describeSelectionHdButton({ status: 'FAILED', error: 'NoSuchKey: uploads/x.jpg' }, { selectedCount: 5 })
    assert.equal(button.failed, true)
    assert.equal(button.disabled, true)
    assert.equal(button.title, 'NoSuchKey: uploads/x.jpg')
})

test('retouching ZIP: nothing selected disables the button, whatever the ZIP says', () => {
    const button = describeSelectionHdButton({ status: 'DONE', sizeBytes: GO }, { selectedCount: 0 })
    assert.equal(button.disabled, true)
    assert.equal(button.title, 'Aucune photo sélectionnée')
})

test('retouching ZIP: while the click is answered the button waits', () => {
    assert.deepEqual(describeSelectionHdButton({ status: 'DONE' }, { selectedCount: 5, downloading: true }).busy, true)
})
