const MAIN_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg'])

// Known noise only (blacklist, not whitelist): a whitelist of RAW extensions would
// need updating for every new camera body. See spec's "opaque attachment" principle.
const SYSTEM_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

const getExtension = (filename) => {
    const match = /\.[^./\\]+$/.exec(filename || '')
    return match ? match[0].toLowerCase() : ''
}

// Extension matching is case-insensitive (`.CR2` and `.cr2` are the same file kind),
// consistently applied here and server-side.
export const isMainPhotoFilename = (filename) => MAIN_PHOTO_EXTENSIONS.has(getExtension(filename))

export const isBlacklistedFile = (file) => {
    if (file.size === 0) return true
    if (file.name.startsWith('.')) return true
    return SYSTEM_BASENAMES.has(file.name.toLowerCase())
}

const getStem = (filename) => {
    const extension = getExtension(filename)
    return extension ? filename.slice(0, -extension.length) : filename
}

export const statusFamily = (status) => (status === 'DELIVERED' ? 'DELIVERED' : 'ORIGINAL')

export function groupFilesForUpload(files, existingPhotos = [], targetStatus = 'PENDING') {
    const usableFiles = files.filter((file) => !isBlacklistedFile(file))
    const family = statusFamily(targetStatus)

    const existingSameFamilyByStem = new Map()
    const existingAnyByStem = new Map()
    for (const photo of existingPhotos) {
        if (!photo.originalFilename) continue
        const stem = getStem(photo.originalFilename)
        existingAnyByStem.set(stem, photo)
        if (statusFamily(photo.status) === family) {
            existingSameFamilyByStem.set(stem, photo)
        }
    }

    const groupsByStem = new Map()
    for (const file of usableFiles) {
        const stem = getStem(file.name)
        if (!groupsByStem.has(stem)) {
            groupsByStem.set(stem, { stem, mainFile: null, attachmentFiles: [], conflictFiles: [] })
        }
        const group = groupsByStem.get(stem)
        if (isMainPhotoFilename(file.name)) {
            if (group.mainFile) {
                group.conflictFiles.push(file)
            } else {
                group.mainFile = file
            }
        } else if (group.attachmentFiles.some((other) => other.name.toLowerCase() === file.name.toLowerCase())) {
            group.conflictFiles.push(file)
        } else {
            group.attachmentFiles.push(file)
        }
    }

    return Array.from(groupsByStem.values()).map((group) => {
        const existingPhoto = existingSameFamilyByStem.get(group.stem) || existingAnyByStem.get(group.stem) || null
        const isOrphanAttachment = !group.mainFile && group.attachmentFiles.length > 0 && !existingPhoto
        return {
            ...group,
            existingPhoto,
            isOrphanAttachment,
            uploadable: !isOrphanAttachment,
        }
    })
}

export const countGroupFiles = (group) => (group.mainFile ? 1 : 0) + group.attachmentFiles.length

export function chunkGroupsIntoBatches(groups, maxFiles = 10) {
    const batches = []
    let current = []
    let currentCount = 0
    for (const group of groups) {
        const count = countGroupFiles(group)
        if (current.length > 0 && currentCount + count > maxFiles) {
            batches.push(current)
            current = []
            currentCount = 0
        }
        current.push(group)
        currentCount += count
    }
    if (current.length > 0) batches.push(current)
    return batches
}

export function partitionGroupsByExisting(groups, existingPhotos = [], targetStatus = 'PENDING') {
    const family = statusFamily(targetStatus)
    const candidates = existingPhotos.filter(
        (photo) => photo.originalFilename && statusFamily(photo.status) === family
    )

    const toUpload = []
    const skipped = []
    for (const group of groups) {
        if (!group.mainFile) {
            toUpload.push(group)
            continue
        }
        const name = group.mainFile.name.toLowerCase()
        const match = candidates.find((photo) =>
            photo.originalFilename.toLowerCase() === name
            && (photo.size === null || photo.size === undefined || Number(photo.size) === group.mainFile.size)
        )
        if (match) {
            skipped.push({ group, photo: match })
        } else {
            toUpload.push(group)
        }
    }
    return { toUpload, skipped }
}

const compareFilenames = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

export const sortGroupsForUpload = (groups) =>
    [...groups].sort((a, b) => compareFilenames(a.mainFile?.name ?? a.stem, b.mainFile?.name ?? b.stem))
