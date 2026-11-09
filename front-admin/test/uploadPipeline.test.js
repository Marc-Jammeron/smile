import test from 'node:test'
import assert from 'node:assert/strict'
import { runUpload } from '../src/utils/uploadPipeline.js'
import { groupFilesForUpload } from '../src/utils/photoGrouping.js'
import { StepError } from '../src/utils/uploadErrors.js'

const file = (name, size = 100, type = '') => ({ name, size, type })
const triplet = (n) => [file(`IMG_${n}.jpg`, 1000 + Number(n), 'image/jpeg'), file(`IMG_${n}.CR2`, 5000), file(`IMG_${n}.xmp`, 10)]
const filesFor = (count) => Array.from({ length: count }, (_, i) => triplet(String(i + 1).padStart(3, '0'))).flat()

function makeApi({ existing = [], putFail = {}, confirmImpl, presignImpl } = {}) {
    const calls = []
    let keyCounter = 0
    let photoCounter = 0
    const state = { existing: [...existing], putAttempts: {} }
    const api = {
        calls,
        state,
        presign: async (args) => {
            calls.push(`presign:${args.files.length}`)
            if (presignImpl) return presignImpl(args, calls)
            return args.files.map((f) => ({ filename: f.filename, url: `https://s3/${f.filename}/${keyCounter}`, key: `k${keyCounter++}/${f.filename}` }))
        },
        put: async ({ url, file: f, contentType }) => {
            const name = f.name
            state.putAttempts[name] = (state.putAttempts[name] ?? 0) + 1
            calls.push(`put:${name}`)
            api.lastPutContentType = { ...(api.lastPutContentType ?? {}), [name]: contentType }
            const fail = putFail[name]
            if (fail) {
                const error = fail(state.putAttempts[name], url)
                if (error) throw error
            }
        },
        confirm: async (args) => {
            calls.push(`confirm:${args.photos.length}${args.attachmentsToExistingPhotos.length ? '+att' : ''}`)
            if (confirmImpl) return confirmImpl(args, state)
            const created = args.photos.map((p) => ({ id: `p${photoCounter++}`, key: p.key, originalFilename: p.filename, size: p.size, status: args.targetStatus }))
            state.existing.push(...created)
            return { created, failed: [], createdAttachments: [], failedAttachments: [] }
        },
        fetchPhotos: async () => {
            calls.push('list')
            return [...state.existing]
        },
    }
    return api
}

const baseOptions = (api, overrides = {}) => ({
    collectionId: 7,
    api,
    sleep: async () => {},
    random: () => 0,
    log: () => {},
    ...overrides,
})

const net = () => new StepError('net', { kind: 'network', retryable: true })
const expired = () => new StepError('403', { kind: 'expired', status: 403 })

test('séquence stricte : presign -> PUT -> confirm -> groupe suivant, jamais de chevauchement', async () => {
    const api = makeApi()
    const groups = groupFilesForUpload(filesFor(4)) // 12 fichiers -> batches de 3 + 1 photos
    const report = await runUpload(baseOptions(api, { groups }))

    assert.equal(report.sentPhotos, 4)
    assert.equal(report.sentAttachments, 8)
    assert.equal(report.failed.length, 0)

    const kinds = api.calls.map((call) => call.split(':')[0])
    assert.equal(kinds[0], 'list')
    const firstPresign = kinds.indexOf('presign')
    const firstConfirm = kinds.indexOf('confirm')
    const secondPresign = kinds.indexOf('presign', firstPresign + 1)
    assert.ok(firstPresign < kinds.indexOf('put'))
    assert.ok(kinds.lastIndexOf('put', firstConfirm) > 0)
    // Aucun PUT du batch 2 avant le confirm du batch 1.
    assert.ok(firstConfirm < secondPresign)
    assert.deepEqual(api.calls.filter((c) => c.startsWith('presign')), ['presign:9', 'presign:3'])
})

test('confirm par chunks de 3 photos (10 JPEG = un seul batch de 10 fichiers)', async () => {
    const api = makeApi()
    const groups = groupFilesForUpload(Array.from({ length: 10 }, (_, i) => file(`P${String(i).padStart(2, '0')}.jpg`)))
    await runUpload(baseOptions(api, { groups }))
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 1)
    assert.deepEqual(api.calls.filter((c) => c.startsWith('confirm')), ['confirm:3', 'confirm:3', 'confirm:3', 'confirm:1'])
})

test('les photos sont confirmées dans l\'ordre des noms de fichiers', async () => {
    const api = makeApi()
    const seen = []
    const original = api.confirm
    api.confirm = async (args) => {
        seen.push(...args.photos.map((p) => p.filename))
        return original(args)
    }
    const names = ['IMG_10.jpg', 'IMG_2.jpg', 'IMG_1.jpg']
    await runUpload(baseOptions(api, { groups: groupFilesForUpload(names.map((n) => file(n))) }))
    assert.deepEqual(seen, ['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg'])
})

test('Content-Type vide normalisé en application/octet-stream, identique au presign et au PUT', async () => {
    const api = makeApi()
    const presigned = []
    const original = api.presign
    api.presign = async (args) => {
        presigned.push(...args.files)
        return original(args)
    }
    await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg', 10, 'image/jpeg'), file('A.CR2', 10, '')]) }))
    const cr2Presign = presigned.find((f) => f.filename === 'A.CR2')
    assert.equal(cr2Presign.contentType, 'application/octet-stream')
    assert.equal(api.lastPutContentType['A.CR2'], 'application/octet-stream')
    assert.equal(api.lastPutContentType['A.jpg'], 'image/jpeg')
})

test('PUT en 403 : un seul re-presign, et le confirm reçoit la clé réellement uploadée', async () => {
    const urlsUsed = []
    const api = makeApi({
        putFail: {
            'A.jpg': (attempt, url) => {
                urlsUsed.push(url)
                return attempt === 1 ? expired() : null
            },
        },
    })
    let confirmed
    const original = api.confirm
    api.confirm = async (args) => {
        confirmed = args.photos
        return original(args)
    }
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg')]) }))

    assert.equal(report.sentPhotos, 1)
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 2) // batch + re-presign
    assert.equal(urlsUsed.length, 2)
    assert.notEqual(urlsUsed[0], urlsUsed[1])
    assert.equal(confirmed[0].key, 'k1/A.jpg') // la seconde clé, pas la première (k0)
})

test('PUT en 403 deux fois de suite : pas de second re-presign, le fichier est en échec', async () => {
    const api = makeApi({ putFail: { 'A.jpg': () => expired() } })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg')]) }))
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 2)
    assert.equal(api.state.putAttempts['A.jpg'], 2)
    assert.equal(report.sentPhotos, 0)
    assert.equal(report.failed[0].kind, 'put')
    assert.deepEqual(report.failed[0].filenames, ['A.jpg'])
    assert.equal(report.retryGroups.length, 1)
    assert.match(report.failed[0].message, /A\.jpg/)
})

test('URL trop vieille au démarrage du PUT : re-presign préventif de ce seul fichier', async () => {
    let clock = 0
    const api = makeApi()
    const originalPut = api.put
    api.put = async (args) => {
        await originalPut(args)
        clock += 300_000 // un gros fichier : 5 min d'upload, l'URL du fichier suivant a expiré
    }
    const groups = groupFilesForUpload([file('A.jpg'), file('B.jpg')])
    const report = await runUpload(baseOptions(api, { groups, concurrency: 1, now: () => clock }))
    assert.equal(report.sentPhotos, 2)
    // presign du batch + re-presign de B uniquement (A est parti avec une URL fraîche)
    assert.deepEqual(api.calls.filter((c) => c.startsWith('presign')), ['presign:2', 'presign:1'])
})

test('erreurs réseau sur PUT : 3 tentatives au total, puis échec nommé, les autres groupes continuent', async () => {
    const api = makeApi({ putFail: { 'B.jpg': () => net() } })
    const groups = groupFilesForUpload([file('A.jpg'), file('B.jpg'), file('B.CR2'), file('C.jpg')])
    const report = await runUpload(baseOptions(api, { groups }))

    assert.equal(api.state.putAttempts['B.jpg'], 3)
    assert.equal(report.sentPhotos, 2)
    assert.equal(report.failed.length, 1)
    assert.deepEqual(report.failed[0].filenames, ['B.jpg'])
    assert.equal(report.failed[0].cause.kind, 'network')
    assert.match(report.failed[0].message, /connexion interrompue/)
    assert.deepEqual(report.retryGroups.map((g) => g.stem), ['B'])
})

test('PUT en 4xx (hors 403) : aucun retry', async () => {
    const api = makeApi({ putFail: { 'A.jpg': () => new StepError('bad', { kind: 'client', status: 400 }) } })
    await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg')]) }))
    assert.equal(api.state.putAttempts['A.jpg'], 1)
})

test('attachment en échec : la photo est confirmée, l\'attachment est relancé vers la photo créée', async () => {
    const api = makeApi({ putFail: { 'A.CR2': () => net() } })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg'), file('A.CR2'), file('A.xmp')]) }))

    assert.equal(report.sentPhotos, 1)
    assert.equal(report.sentAttachments, 1) // le XMP
    assert.equal(report.failed[0].kind, 'put')
    assert.deepEqual(report.failed[0].filenames, ['A.CR2'])
    assert.equal(report.retryGroups.length, 1)
    const [retry] = report.retryGroups
    assert.equal(retry.mainFile, null)
    assert.deepEqual(retry.attachmentFiles.map((f) => f.name), ['A.CR2'])
    assert.equal(retry.existingPhoto.id, 'p0')
})

test('failedAttachments renvoyés par le confirm : relance vers la photo créée', async () => {
    const api = makeApi({
        confirmImpl: (args) => {
            const created = args.photos.map((p, i) => ({ id: `p${i}`, key: p.key, originalFilename: p.filename }))
            return {
                created,
                failed: [],
                createdAttachments: [],
                failedAttachments: [{ key: args.photos[0].attachments[0].key, error: 'x', photoId: 'p0' }],
            }
        },
    })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg'), file('A.CR2'), file('A.xmp')]) }))
    assert.equal(report.sentPhotos, 1)
    assert.equal(report.sentAttachments, 1)
    assert.equal(report.failed[0].kind, 'attachment')
    assert.deepEqual(report.retryGroups[0].attachmentFiles.map((f) => f.name), ['A.CR2'])
    assert.equal(report.retryGroups[0].existingPhoto.id, 'p0')
})

test('photo refusée par le back (failed[]) : échec définitif, relançable', async () => {
    const api = makeApi({
        confirmImpl: (args) => ({ created: [], failed: args.photos.map((p) => ({ key: p.key, error: 'x' })), createdAttachments: [], failedAttachments: [] }),
    })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg')]) }))
    assert.equal(report.sentPhotos, 0)
    assert.equal(report.failed[0].kind, 'confirm')
    assert.equal(report.retryGroups.length, 1)
})

test('confirm ambigu : jamais de retry, arrêt, attente, rechargement, réconciliation', async () => {
    let confirmCalls = 0
    const sleeps = []
    const api = makeApi({
        confirmImpl: (args, state) => {
            confirmCalls += 1
            // Le back a en fait créé la première photo avant de couper la connexion.
            state.existing.push({ id: 'px', originalFilename: args.photos[0].filename, size: args.photos[0].size, status: 'PENDING' })
            throw net()
        },
    })
    const groups = groupFilesForUpload(filesFor(5)) // 2 batches ; le premier échoue
    const report = await runUpload(baseOptions(api, { groups, sleep: async (ms) => sleeps.push(ms) }))

    assert.equal(confirmCalls, 1)
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 1) // pas de batch suivant
    assert.ok(sleeps.includes(8000)) // attente avant le rechargement
    assert.equal(api.calls.filter((c) => c === 'list').length, 2) // liste initiale + rechargement

    assert.deepEqual(report.recovered.map((r) => r.filename), ['IMG_001.jpg'])
    assert.equal(report.sentPhotos, 1)
    const uncertain = report.failed.find((f) => f.kind === 'confirm-uncertain')
    assert.deepEqual(uncertain.filenames, ['IMG_002.jpg', 'IMG_003.jpg'])
    assert.match(uncertain.message, /incertain/)
    const notAttempted = report.failed.find((f) => f.kind === 'not-attempted')
    assert.ok(notAttempted.filenames.includes('IMG_005.jpg'))
    assert.ok(report.fatal)
    // Tout ce qui n'est pas confirmé reste relançable.
    assert.deepEqual(report.retryGroups.map((g) => g.stem).sort(), ['IMG_002', 'IMG_003', 'IMG_004', 'IMG_005'])
})

test('confirm ambigu + rechargement impossible : résultat incertain pour tout le chunk', async () => {
    const api = makeApi({ confirmImpl: () => { throw new StepError('timeout', { kind: 'timeout', retryable: true }) } })
    let listCalls = 0
    api.fetchPhotos = async () => {
        listCalls += 1
        if (listCalls > 1) throw net()
        return []
    }
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg'), file('B.jpg')]) }))
    const uncertain = report.failed.find((f) => f.kind === 'confirm-uncertain')
    assert.deepEqual(uncertain.filenames, ['A.jpg', 'B.jpg'])
    assert.equal(uncertain.reloadFailed, true)
    assert.match(uncertain.message, /n'a pas pu être rechargée/)
})

test('409 au presign : arrêt, message dédié, rien d\'autre n\'est tenté', async () => {
    const api = makeApi({ presignImpl: () => { throw new StepError('conflict', { kind: 'conflict', status: 409 }) } })
    const groups = groupFilesForUpload(filesFor(5))
    const report = await runUpload(baseOptions(api, { groups }))
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 1)
    assert.equal(api.calls.filter((c) => c.startsWith('put')).length, 0)
    assert.match(report.failed[0].message, /changé de statut/)
    assert.equal(report.retryGroups.length, 5)
    assert.equal(report.fatal.kind, 'conflict')
})

test('presign en erreur réseau : 3 tentatives puis arrêt, tout reste relançable', async () => {
    const api = makeApi({ presignImpl: () => { throw net() } })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg'), file('B.jpg')]) }))
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 3)
    assert.equal(report.failed[0].kind, 'presign')
    assert.equal(report.retryGroups.length, 2)
})

test('dédup : les photos déjà présentes sont ignorées et comptées, pas envoyées', async () => {
    const api = makeApi({ existing: [{ id: 'e1', originalFilename: 'IMG_001.jpg', size: 1001, status: 'PENDING' }] })
    const groups = groupFilesForUpload(filesFor(2))
    const report = await runUpload(baseOptions(api, { groups }))
    assert.deepEqual(report.skipped, [{ filename: 'IMG_001.jpg' }])
    assert.equal(report.sentPhotos, 1)
    assert.ok(!api.calls.includes('put:IMG_001.jpg'))
    assert.ok(!api.calls.includes('put:IMG_001.CR2'))
})

test('dédup DELIVERED : une retouche n\'est pas ignorée parce que l\'original existe', async () => {
    const api = makeApi({ existing: [{ id: 'e1', originalFilename: 'IMG_001.jpg', size: 1001, status: 'SELECTED' }] })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('IMG_001.jpg', 1001, 'image/jpeg')], [], 'DELIVERED'), targetStatus: 'DELIVERED' }))
    assert.equal(report.skipped.length, 0)
    assert.equal(report.sentPhotos, 1)
})

test('tout est déjà présent : rien n\'est envoyé, aucun presign', async () => {
    const api = makeApi({ existing: [{ id: 'e1', originalFilename: 'A.jpg', size: 100, status: 'PENDING' }] })
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg', 100)]) }))
    assert.equal(report.skipped.length, 1)
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 0)
})

test('rechargement initial impossible : rien n\'est envoyé, tout reste relançable', async () => {
    const api = makeApi()
    api.fetchPhotos = async () => { throw net() }
    const report = await runUpload(baseOptions(api, { groups: groupFilesForUpload([file('A.jpg')]) }))
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 0)
    assert.equal(report.failed[0].kind, 'reload')
    assert.equal(report.retryGroups.length, 1)
})

test('attachments seuls vers une photo existante : confirm séparé avec photoId', async () => {
    let received
    const api = makeApi({
        existing: [{ id: 'e1', originalFilename: 'A.jpg', size: 100, status: 'PENDING' }],
        confirmImpl: (args) => {
            received = args
            return { created: [], failed: [], createdAttachments: [], failedAttachments: [] }
        },
    })
    const groups = groupFilesForUpload([file('A.CR2'), file('A.xmp')], [{ id: 'e1', originalFilename: 'A.jpg', status: 'PENDING' }])
    const report = await runUpload(baseOptions(api, { groups }))
    assert.equal(report.sentPhotos, 0)
    assert.equal(report.sentAttachments, 2)
    assert.equal(received.photos.length, 0)
    assert.equal(received.attachmentsToExistingPhotos[0].photoId, 'e1')
    assert.equal(received.attachmentsToExistingPhotos[0].attachments.length, 2)
})

test('confirm ambigu sur des attachments seuls : pas de relance automatique proposée', async () => {
    const api = makeApi({ confirmImpl: () => { throw net() } })
    const groups = groupFilesForUpload([file('A.CR2')], [{ id: 'e1', originalFilename: 'A.jpg', status: 'PENDING' }])
    const report = await runUpload(baseOptions(api, { groups }))
    assert.equal(report.failed[0].kind, 'confirm-uncertain')
    assert.equal(report.failed[0].attachmentsOnly, true)
    assert.equal(report.retryGroups.length, 0)
})

test('interruption : le batch en cours va à son terme, les suivants ne démarrent pas', async () => {
    const controller = new AbortController()
    const api = makeApi()
    const original = api.confirm
    api.confirm = async (args) => {
        controller.abort() // l'utilisateur clique "Interrompre" pendant le premier confirm
        return original(args)
    }
    const groups = groupFilesForUpload(filesFor(5))
    const report = await runUpload(baseOptions(api, { groups, signal: controller.signal }))

    assert.equal(report.aborted, true)
    assert.equal(report.sentPhotos, 3) // le premier batch est confirmé en entier
    assert.equal(api.calls.filter((c) => c.startsWith('presign')).length, 1)
    assert.deepEqual(report.retryGroups.map((g) => g.stem), ['IMG_004', 'IMG_005'])
    assert.equal(report.failed[0].kind, 'not-attempted')
})

test('callbacks : photos créées et liste rechargée remontent à l\'UI', async () => {
    const api = makeApi()
    const created = []
    const reloads = []
    await runUpload(baseOptions(api, {
        groups: groupFilesForUpload([file('A.jpg'), file('B.jpg')]),
        onPhotosCreated: (photos) => created.push(...photos),
        onPhotosReloaded: (photos) => reloads.push(photos),
    }))
    assert.equal(created.length, 2)
    assert.equal(reloads.length, 1)
})

test('progression en octets : atteint 100 % à la fin, sans dépasser', async () => {
    const api = makeApi()
    const progresses = []
    await runUpload(baseOptions(api, {
        groups: groupFilesForUpload([file('A.jpg', 500), file('A.CR2', 1500)]),
        onProgress: (p) => progresses.push(p),
    }))
    const last = progresses.at(-1)
    assert.equal(last.bytesTotal, 2000)
    assert.equal(last.bytesDone, 2000)
    assert.equal(last.phase, 'done')
    assert.ok(progresses.every((p) => p.bytesDone <= p.bytesTotal))
})
