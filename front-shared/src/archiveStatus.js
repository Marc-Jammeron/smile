// State of a pre-generated ZIP (the "download all" button of the client, the retouching ZIP
// of the admin). The server builds it in the background: the page polls its status, and
// downloads it by navigating to a presigned URL once it is DONE.
export const ARCHIVE_STATUS = {
    QUEUED: 'QUEUED',
    PROCESSING: 'PROCESSING',
    DONE: 'DONE',
    FAILED: 'FAILED'
}

export const ARCHIVE_POLL_INTERVAL_MS = 5000

// Being prepared: the page keeps polling, the button waits.
export const isArchivePending = (status) =>
    status === ARCHIVE_STATUS.QUEUED || status === ARCHIVE_STATUS.PROCESSING

const UNITS = [
    { label: 'To', size: 1024 ** 4, decimals: 1 },
    { label: 'Go', size: 1024 ** 3, decimals: 1 },
    { label: 'Mo', size: 1024 ** 2, decimals: 0 },
    { label: 'Ko', size: 1024, decimals: 0 }
]

// 1 503 238 553 -> "1,4 Go". Null when the size is not known.
export const formatArchiveSize = (bytes) => {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
    const unit = UNITS.find(({ size }) => bytes >= size)
    if (!unit) return `${bytes} o`
    const value = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: unit.decimals }).format(bytes / unit.size)
    return `${value} ${unit.label}`
}

// The three states of the client's "Télécharger tout" button, plus the one in between
// (the click is being answered). `archive` is null when the server sent none: the button is
// then usable, a click asks the server which queues the ZIP if needed.
export const describeDownloadAllButton = (archive, { downloading = false, photographerName = null } = {}) => {
    if (downloading) {
        return { label: 'Un instant…', disabled: true, failed: false }
    }
    if (isArchivePending(archive?.status)) {
        return { label: 'Préparation de votre ZIP…', disabled: true, failed: false }
    }
    if (archive?.status === ARCHIVE_STATUS.FAILED) {
        return { label: `ZIP indisponible, contactez ${photographerName || 'votre photographe'}`, disabled: true, failed: true }
    }
    const size = archive?.status === ARCHIVE_STATUS.DONE ? formatArchiveSize(archive.sizeBytes) : null
    return { label: size ? `Télécharger tout, ${size}` : 'Télécharger tout', disabled: false, failed: false }
}

// The retouching ZIP of the admin (selection in original quality, RAW/XMP included). Same
// states as the client's button, plus the failure, which the admin can retry. `selectedCount`
// is the number of photos the ZIP is made of.
export const describeSelectionHdButton = (archive, { downloading = false, selectedCount = 0 } = {}) => {
    const photos = `${selectedCount} photo${selectedCount > 1 ? 's' : ''}`
    if (selectedCount === 0) {
        return { label: `Télécharger la sélection HD (${photos})`, disabled: true, busy: false, failed: false, title: 'Aucune photo sélectionnée' }
    }
    if (downloading) {
        return { label: 'Un instant…', disabled: true, busy: true, failed: false, title: undefined }
    }
    if (isArchivePending(archive?.status)) {
        return { label: 'Préparation du ZIP…', disabled: true, busy: true, failed: false, title: undefined }
    }
    if (archive?.status === ARCHIVE_STATUS.FAILED) {
        return { label: 'Échec de la préparation du ZIP', disabled: true, busy: false, failed: true, title: archive.error ?? undefined }
    }
    const size = archive?.status === ARCHIVE_STATUS.DONE ? formatArchiveSize(archive.sizeBytes) : null
    const detail = size ? `${photos}, ${size}` : photos
    return { label: `Télécharger la sélection HD (${detail})`, disabled: false, busy: false, failed: false, title: undefined }
}
