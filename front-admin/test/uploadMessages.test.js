import test from 'node:test'
import assert from 'node:assert/strict'
import { describeFailure, summarizeReport, isCleanReport, listNames, formatBytes } from '../src/utils/uploadMessages.js'

const emptyReport = () => ({
    sentPhotos: 0, sentAttachments: 0, skipped: [], recovered: [], failed: [], retryGroups: [], fatal: null, aborted: false,
})

test('aucun message ne contient "Failed to fetch"', () => {
    const kinds = ['presign', 'put', 'confirm', 'confirm-uncertain', 'attachment', 'not-attempted', 'reload']
    for (const kind of kinds) {
        const message = describeFailure({ kind, filenames: ['A.jpg'], cause: { kind: 'network' }, batch: 1, batchCount: 2 })
        assert.ok(!/failed to fetch/i.test(message), kind)
    }
})

test('échec de PUT : liste les fichiers et la cause', () => {
    const message = describeFailure({ kind: 'put', filenames: ['A.CR2', 'A.xmp'], cause: { kind: 'timeout' } })
    assert.match(message, /A\.CR2, A\.xmp/)
    assert.match(message, /délai dépassé/)
})

test('presign : réseau vs galerie modifiée vs session expirée', () => {
    assert.match(describeFailure({ kind: 'presign', filenames: ['A.jpg'], cause: { kind: 'network' }, batch: 2, batchCount: 9 }), /groupe 2\/9/)
    assert.match(describeFailure({ kind: 'presign', filenames: [], cause: { kind: 'conflict' } }), /changé de statut/)
    assert.match(describeFailure({ kind: 'presign', filenames: [], cause: { kind: 'auth' } }), /Session expirée/)
})

test('confirm ambigu : parle de résultat incertain', () => {
    assert.match(describeFailure({ kind: 'confirm-uncertain', filenames: ['A.jpg'], cause: { kind: 'network' } }), /Résultat incertain/)
})

test('listNames tronque les longues listes', () => {
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.jpg`)
    assert.match(listNames(names), /… et 4 autre\(s\)$/)
})

test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 Mo')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 Mo')
    assert.equal(formatBytes(3 * 1024 ** 3), '3.0 Go')
})

test('récapitulatif : envoyées / ignorées / en échec, avec la mention RAW/XMP non revérifiés', () => {
    const report = {
        ...emptyReport(),
        sentPhotos: 12,
        skipped: [{ filename: 'A.jpg' }, { filename: 'B.jpg' }, { filename: 'C.jpg' }],
        failed: [{ kind: 'put', filenames: ['D.jpg', 'E.jpg'], cause: { kind: 'network' } }],
    }
    const { headline, lines } = summarizeReport(report)
    assert.match(headline, /12 photos envoyées/)
    assert.match(headline, /3 ignorées \(déjà présentes\)/)
    assert.match(headline, /2 en échec/)
    assert.ok(lines.some((line) => line.includes('RAW/XMP des photos déjà présentes non revérifiés')))
    assert.ok(lines.some((line) => line.includes('D.jpg, E.jpg')))
})

test('isCleanReport : propre seulement si tout est envoyé sans rien à signaler', () => {
    assert.equal(isCleanReport({ ...emptyReport(), sentPhotos: 3 }), true)
    assert.equal(isCleanReport({ ...emptyReport(), sentPhotos: 3, skipped: [{ filename: 'A.jpg' }] }), false)
    assert.equal(isCleanReport({ ...emptyReport(), sentPhotos: 3, aborted: true }), false)
    assert.equal(isCleanReport({ ...emptyReport(), sentPhotos: 3, failed: [{ kind: 'put', filenames: [] }] }), false)
    assert.equal(isCleanReport(emptyReport()), false)
})
