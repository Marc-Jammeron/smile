import { runWithConcurrency } from './concurrency.js'
import { withRetry, computeBackoffDelay, defaultSleep } from './retry.js'
import { isAmbiguousKind } from './uploadErrors.js'
import {
    sortGroupsForUpload,
    chunkGroupsIntoBatches,
    partitionGroupsByExisting,
    countGroupFiles,
} from './photoGrouping.js'
import { describeFailure } from './uploadMessages.js'

export const contentTypeOf = (file) => file.type || 'application/octet-stream'

const namesOf = (group) => [group.mainFile?.name, ...group.attachmentFiles.map((file) => file.name)].filter(Boolean)

const causeOf = (error) => ({ kind: error?.kind ?? 'unknown', status: error?.status ?? null })

const toAttachmentPayload = (entry) => ({
    key: entry.target.key,
    contentType: entry.contentType,
    size: entry.file.size,
    filename: entry.file.name,
})

const PROGRESS_THROTTLE_MS = 150

export async function runUpload(options) {
    const {
        collectionId,
        groups: inputGroups,
        targetStatus = 'PENDING',
        description = null,
        api,
        onProgress,
        onPhotosCreated,
        onPhotosReloaded,
        signal,
        concurrency = 4,
        maxFilesPerBatch = 10,
        confirmChunkSize = 3,
        putAttempts = 3,
        presignAttempts = 3,
        urlMaxAgeMs = 240_000,
        ambiguousReloadDelayMs = 8_000,
        sleep = defaultSleep,
        random = Math.random,
        now = Date.now,
        log = console.error,
    } = options

    const report = {
        sentPhotos: 0,
        sentAttachments: 0,
        skipped: [],
        recovered: [],
        failed: [],
        retryGroups: [],
        fatal: null,
        aborted: false,
    }
    const retryOptions = { sleep, random }

    let batchCount = 0
    const progress = { phase: 'preparing', batchIndex: 0, batchCount: 0, bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0 }
    let lastEmit = 0
    const emit = (force = true) => {
        const time = now()
        if (!force && time - lastEmit < PROGRESS_THROTTLE_MS) return
        lastEmit = time
        onProgress?.({ ...progress })
    }
    const trackBytes = (entry, loaded) => {
        progress.bytesDone += loaded - entry.bytesCounted
        entry.bytesCounted = loaded
        emit(false)
    }

    const recordFailure = (failure) => {
        report.failed.push({ batchCount, ...failure })
    }
    const addRetryGroup = (group) => {
        if (!report.retryGroups.includes(group)) report.retryGroups.push(group)
    }
    const setFatal = (cause) => {
        if (!report.fatal) report.fatal = cause
    }

    const attachmentRetryByPhotoId = new Map()
    const queueAttachmentRetry = (photo, file) => {
        let group = attachmentRetryByPhotoId.get(photo.id)
        if (!group) {
            group = {
                stem: photo.originalFilename ?? file.name,
                mainFile: null,
                attachmentFiles: [],
                conflictFiles: [],
                existingPhoto: { id: photo.id, originalFilename: photo.originalFilename ?? null },
                isOrphanAttachment: false,
                uploadable: true,
            }
            attachmentRetryByPhotoId.set(photo.id, group)
            addRetryGroup(group)
        }
        group.attachmentFiles.push(file)
    }

    const finish = () => {
        for (const failure of report.failed) failure.message = describeFailure(failure)
        return report
    }

    const reload = async () => {
        const photos = await withRetry(() => api.fetchPhotos(collectionId), { ...retryOptions, maxAttempts: 3 })
        onPhotosReloaded?.(photos)
        return photos
    }

    const markNotAttempted = (groups) => {
        if (groups.length === 0) return
        recordFailure({ kind: 'not-attempted', filenames: groups.flatMap(namesOf), cause: report.fatal })
        groups.forEach(addRetryGroup)
    }

    let existingPhotos
    try {
        existingPhotos = await reload()
    } catch (error) {
        log('Rechargement de la liste des photos impossible', error)
        recordFailure({ kind: 'reload', filenames: [], cause: causeOf(error) })
        setFatal(causeOf(error))
        inputGroups.forEach(addRetryGroup)
        return finish()
    }

    const sortedGroups = sortGroupsForUpload(inputGroups)
    const { toUpload, skipped } = partitionGroupsByExisting(sortedGroups, existingPhotos, targetStatus)
    report.skipped = skipped.map(({ group }) => ({ filename: group.mainFile.name }))

    const batches = chunkGroupsIntoBatches(toUpload, maxFilesPerBatch)
    batchCount = batches.length
    progress.batchCount = batchCount
    progress.filesTotal = toUpload.reduce((sum, group) => sum + countGroupFiles(group), 0)
    progress.bytesTotal = toUpload.reduce(
        (sum, group) => sum + (group.mainFile?.size ?? 0) + group.attachmentFiles.reduce((acc, file) => acc + file.size, 0),
        0
    )
    emit()

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        if (signal?.aborted) {
            report.aborted = true
            markNotAttempted(batches.slice(batchIndex).flat())
            break
        }
        progress.batchIndex = batchIndex + 1
        const { stop } = await processBatch(batches[batchIndex], batchIndex + 1)
        if (stop) {
            markNotAttempted(batches.slice(batchIndex + 1).flat())
            break
        }
    }

    progress.phase = 'done'
    emit()
    return finish()


    async function uploadEntry(entry) {
        const descriptor = { filename: entry.file.name, contentType: entry.contentType, type: entry.type }
        let reissued = false
        let lastError = null

        const represign = async () => {
            const [target] = await withRetry(
                () => api.presign({ collectionId, targetStatus, files: [descriptor] }),
                { ...retryOptions, maxAttempts: presignAttempts }
            )
            entry.target = { ...target, presignedAt: now() }
            reissued = true
        }

        for (let attempt = 1; attempt <= putAttempts; attempt += 1) {
            try {
                if (!reissued && now() - entry.target.presignedAt > urlMaxAgeMs) await represign()
                trackBytes(entry, 0)
                await api.put({
                    url: entry.target.url,
                    file: entry.file,
                    contentType: entry.contentType,
                    onProgress: (loaded) => trackBytes(entry, loaded),
                })
                entry.ok = true
                lastError = null
                break
            } catch (error) {
                lastError = error
                if (attempt >= putAttempts) break
                if (error?.kind === 'expired' && !reissued) {
                    try {
                        await represign()
                    } catch (represignError) {
                        lastError = represignError
                        break
                    }
                    continue
                }
                if (!error?.retryable) break
                await sleep(computeBackoffDelay(attempt, { random }))
            }
        }

        if (!entry.ok) {
            entry.error = lastError
            log(`Échec du PUT de ${entry.file.name}`, lastError)
        }
        trackBytes(entry, entry.file.size)
        progress.filesDone += 1
        emit()
        return { ok: entry.ok }
    }

    async function processBatch(batch, batchNumber) {
        const makeEntry = (file, type) => ({
            file,
            type,
            contentType: contentTypeOf(file),
            target: null,
            bytesCounted: 0,
            ok: false,
            error: null,
        })
        const members = batch.map((group) => ({
            group,
            main: group.mainFile ? makeEntry(group.mainFile, 'photo') : null,
            attachments: group.attachmentFiles.map((file) => makeEntry(file, 'attachment')),
        }))
        const entries = members.flatMap(({ main, attachments }) => [main, ...attachments].filter(Boolean))

        progress.phase = 'presigning'
        emit()
        let targets
        try {
            targets = await withRetry(
                () => api.presign({
                    collectionId,
                    targetStatus,
                    files: entries.map((entry) => ({ filename: entry.file.name, contentType: entry.contentType, type: entry.type })),
                }),
                { ...retryOptions, maxAttempts: presignAttempts }
            )
        } catch (error) {
            log(`Presign impossible (groupe ${batchNumber})`, error)
            const cause = causeOf(error)
            recordFailure({ kind: 'presign', filenames: batch.flatMap(namesOf), cause, batch: batchNumber })
            batch.forEach(addRetryGroup)
            if (cause.kind === 'client') return { stop: false }
            setFatal(cause)
            return { stop: true }
        }
        const presignedAt = now()
        entries.forEach((entry, index) => {
            entry.target = { ...targets[index], presignedAt }
        })

        progress.phase = 'uploading'
        emit()
        const results = await runWithConcurrency(entries, concurrency, uploadEntry)
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                entries[index].ok = false
                entries[index].error = result.reason
            }
        })

        const photoItems = []
        const attachmentOnlyItems = []
        for (const { group, main, attachments } of members) {
            const uploadedAttachments = attachments.filter((entry) => entry.ok)
            const failedAttachments = attachments.filter((entry) => !entry.ok)
            const failedEntries = [main, ...failedAttachments].filter((entry) => entry && !entry.ok)
            if (failedEntries.length > 0) {
                recordFailure({
                    kind: 'put',
                    filenames: failedEntries.map((entry) => entry.file.name),
                    cause: causeOf(failedEntries[0].error),
                    batch: batchNumber,
                })
            }

            if (group.mainFile) {
                if (!main.ok) {
                    addRetryGroup(group)
                    continue
                }
                photoItems.push({
                    group,
                    uploadedAttachments,
                    failedAttachments,
                    payload: {
                        collectionId,
                        key: main.target.key,
                        contentType: main.contentType,
                        size: main.file.size,
                        filename: main.file.name,
                        description,
                        attachments: uploadedAttachments.map(toAttachmentPayload),
                    },
                })
            } else {
                failedAttachments.forEach((entry) => queueAttachmentRetry(group.existingPhoto, entry.file))
                if (uploadedAttachments.length > 0) attachmentOnlyItems.push({ group, uploadedAttachments })
            }
        }

        progress.phase = 'confirming'
        emit()
        let stopped = false
        for (let index = 0; index < photoItems.length; index += confirmChunkSize) {
            const chunk = photoItems.slice(index, index + confirmChunkSize)
            const outcome = await confirmChunk(chunk, batchNumber)
            if (outcome.stop) {
                stopped = true
                const unconfirmed = photoItems.slice(index + confirmChunkSize)
                if (unconfirmed.length > 0) {
                    recordFailure({ kind: 'not-attempted', filenames: unconfirmed.map((item) => item.group.mainFile.name), cause: report.fatal })
                    unconfirmed.forEach((item) => addRetryGroup(item.group))
                }
                break
            }
        }

        if (stopped) {
            for (const item of attachmentOnlyItems) {
                recordFailure({ kind: 'not-attempted', filenames: item.uploadedAttachments.map((entry) => entry.file.name), cause: report.fatal })
                item.uploadedAttachments.forEach((entry) => queueAttachmentRetry(item.group.existingPhoto, entry.file))
            }
            return { stop: true }
        }

        if (attachmentOnlyItems.length > 0) {
            return confirmAttachmentsOnly(attachmentOnlyItems, batchNumber)
        }
        return { stop: false }
    }

    async function confirmChunk(chunk, batchNumber) {
        let result
        try {
            result = await api.confirm({
                targetStatus,
                photos: chunk.map((item) => item.payload),
                attachmentsToExistingPhotos: [],
            })
        } catch (error) {
            log(`Confirm en échec (groupe ${batchNumber})`, error)
            const cause = causeOf(error)
            setFatalIfStopping(cause)
            if (isAmbiguousKind(cause.kind)) {
                setFatal(cause)
                await reconcileUncertainChunk(chunk, cause, batchNumber)
                return { stop: true }
            }
            recordFailure({ kind: 'confirm', filenames: chunk.map((item) => item.group.mainFile.name), cause, batch: batchNumber })
            chunk.forEach((item) => addRetryGroup(item.group))
            return { stop: cause.kind === 'auth' || cause.kind === 'conflict' }
        }

        const createdByKey = new Map((result.created ?? []).map((photo) => [photo.key, photo]))
        const failedAttachmentKeys = new Set((result.failedAttachments ?? []).map((failure) => failure.key))
        for (const item of chunk) {
            const created = createdByKey.get(item.payload.key)
            if (!created) {
                const reason = (result.failed ?? []).find((failure) => failure.key === item.payload.key)
                log(`Photo non enregistrée par le serveur : ${item.group.mainFile.name}`, reason)
                recordFailure({ kind: 'confirm', filenames: [item.group.mainFile.name], cause: { kind: 'client', status: null }, batch: batchNumber })
                addRetryGroup(item.group)
                continue
            }
            report.sentPhotos += 1
            const rejected = item.uploadedAttachments.filter((entry) => failedAttachmentKeys.has(entry.target.key))
            report.sentAttachments += item.uploadedAttachments.length - rejected.length
            if (rejected.length > 0) {
                recordFailure({ kind: 'attachment', filenames: rejected.map((entry) => entry.file.name), cause: { kind: 'client', status: null }, batch: batchNumber })
            }
            const toRetry = [...rejected, ...item.failedAttachments]
            toRetry.forEach((entry) => queueAttachmentRetry(created, entry.file))
        }
        if (result.created?.length > 0) onPhotosCreated?.(result.created)
        emit()
        return { stop: false }
    }

    function setFatalIfStopping(cause) {
        if (cause.kind === 'auth' || cause.kind === 'conflict') setFatal(cause)
    }

    async function reconcileUncertainChunk(chunk, cause, batchNumber) {
        await sleep(ambiguousReloadDelayMs)
        const groups = chunk.map((item) => item.group)
        let reloadFailed = false
        let absent = groups
        try {
            const fresh = await reload()
            const { toUpload: stillAbsent, skipped: present } = partitionGroupsByExisting(groups, fresh, targetStatus)
            absent = stillAbsent
            for (const { group, photo } of present) {
                report.recovered.push({ filename: group.mainFile.name })
                report.sentPhotos += 1
                const item = chunk.find((candidate) => candidate.group === group)
                item.failedAttachments.forEach((entry) => queueAttachmentRetry(photo, entry.file))
            }
        } catch (error) {
            log('Rechargement impossible après un confirm incertain', error)
            reloadFailed = true
        }
        if (absent.length > 0) {
            recordFailure({
                kind: 'confirm-uncertain',
                filenames: absent.map((group) => group.mainFile.name),
                cause,
                reloadFailed,
                batch: batchNumber,
            })
            absent.forEach(addRetryGroup)
        }
    }

    async function confirmAttachmentsOnly(items, batchNumber) {
        const allFiles = items.flatMap((item) => item.uploadedAttachments.map((entry) => entry.file.name))
        let result
        try {
            result = await api.confirm({
                targetStatus,
                photos: [],
                attachmentsToExistingPhotos: items.map((item) => ({
                    photoId: item.group.existingPhoto.id,
                    attachments: item.uploadedAttachments.map(toAttachmentPayload),
                })),
            })
        } catch (error) {
            log(`Confirm des fichiers associés en échec (groupe ${batchNumber})`, error)
            const cause = causeOf(error)
            if (isAmbiguousKind(cause.kind)) {

                recordFailure({ kind: 'confirm-uncertain', attachmentsOnly: true, filenames: allFiles, cause, batch: batchNumber })
                setFatal(cause)
                return { stop: true }
            }
            recordFailure({ kind: 'confirm', filenames: allFiles, cause, batch: batchNumber })
            items.forEach((item) => item.uploadedAttachments.forEach((entry) => queueAttachmentRetry(item.group.existingPhoto, entry.file)))
            setFatalIfStopping(cause)
            return { stop: cause.kind === 'auth' || cause.kind === 'conflict' }
        }

        const failedKeys = new Set((result.failedAttachments ?? []).map((failure) => failure.key))
        for (const item of items) {
            const rejected = item.uploadedAttachments.filter((entry) => failedKeys.has(entry.target.key))
            report.sentAttachments += item.uploadedAttachments.length - rejected.length
            if (rejected.length > 0) {
                recordFailure({ kind: 'attachment', filenames: rejected.map((entry) => entry.file.name), cause: { kind: 'client', status: null }, batch: batchNumber })
                rejected.forEach((entry) => queueAttachmentRetry(item.group.existingPhoto, entry.file))
            }
        }
        emit()
        return { stop: false }
    }
}
