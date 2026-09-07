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

// Groups dropped files by basename (`IMG_1234.CR2` + `IMG_1234.xmp` + `IMG_1234.jpg`
// -> one group), resolving against already-loaded Photos of the collection so a
// same-basename CR2/XMP dropped days after its JPEG attaches to the existing Photo
// instead of creating a duplicate. A group made only of attachments with neither a
// JPEG in this drop nor a matching existing Photo has nothing to attach to: it is
// surfaced as a non-uploadable anomaly rather than silently dropped.
export function groupFilesForUpload(files, existingPhotos = []) {
    const usableFiles = files.filter((file) => !isBlacklistedFile(file))

    const existingByStem = new Map()
    for (const photo of existingPhotos) {
        if (!photo.originalFilename) continue
        existingByStem.set(getStem(photo.originalFilename), photo)
    }

    const groupsByStem = new Map()
    for (const file of usableFiles) {
        const stem = getStem(file.name)
        if (!groupsByStem.has(stem)) {
            groupsByStem.set(stem, { stem, mainFile: null, attachmentFiles: [] })
        }
        const group = groupsByStem.get(stem)
        if (isMainPhotoFilename(file.name)) {
            group.mainFile = file
        } else {
            group.attachmentFiles.push(file)
        }
    }

    return Array.from(groupsByStem.values()).map((group) => {
        const existingPhoto = existingByStem.get(group.stem) || null
        const isOrphanAttachment = !group.mainFile && group.attachmentFiles.length > 0 && !existingPhoto
        return {
            ...group,
            existingPhoto,
            isOrphanAttachment,
            uploadable: !isOrphanAttachment,
        }
    })
}
