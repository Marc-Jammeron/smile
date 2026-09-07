import { useState } from 'react'

export function PhotoSelectionButtons({ photo, onUpdateStatus, allowReset = true }) {
    const [updatingStatus, setUpdatingStatus] = useState(false)

    const handleSetStatus = async (status) => {
        if (photo.status === status && !allowReset) return
        const nextStatus = photo.status === status ? 'PENDING' : status
        setUpdatingStatus(true)
        try {
            await onUpdateStatus(photo.id, nextStatus)
        } catch (error) {
            console.error('Error updating photo status:', error)
            alert('La mise à jour du statut a échoué')
        } finally {
            setUpdatingStatus(false)
        }
    }

    return (
        <div className="photo-selection-actions">
            <button
                type="button"
                className={`photo-select-button ${photo.status === 'SELECTED' ? 'active' : ''}`}
                onClick={() => handleSetStatus('SELECTED')}
                disabled={updatingStatus}
                aria-label="Sélectionner la photo"
            >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            </button>
            <button
                type="button"
                className={`photo-reject-button ${photo.status === 'REJECTED' ? 'active' : ''}`}
                onClick={() => handleSetStatus('REJECTED')}
                disabled={updatingStatus}
                aria-label="Rejeter la photo"
            >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            </button>
        </div>
    )
}

export default function Photo({ photo, onDelete, onUpdateStatus, onOpen, allowReset = true, downloadUrl, downloadFilename }) {
    const [deleting, setDeleting] = useState(false)
    const [downloading, setDownloading] = useState(false)

    const handleDelete = async () => {
        if (!window.confirm('Supprimer cette photo ?')) return
        setDeleting(true)
        try {
            await onDelete(photo.id)
        } catch (error) {
            console.error('Error deleting photo:', error)
            alert('La suppression de la photo a échoué')
            setDeleting(false)
        }
    }

    // A plain <a download> is ignored by the browser here because downloadUrl is a
    // cross-origin (S3) presigned URL: the `download` attribute only forces a save
    // for same-origin links, so a cross-origin one just opens/navigates instead.
    // Fetching the bytes and downloading the resulting same-origin blob: URL works
    // regardless of origin, same trick as the "download all" ZIP button.
    const handleDownload = async (event) => {
        event.stopPropagation()
        setDownloading(true)
        try {
            const response = await fetch(downloadUrl)
            if (!response.ok) {
                throw new Error('Failed to download photo')
            }
            const blob = await response.blob()
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = downloadFilename || ''
            document.body.appendChild(link)
            link.click()
            link.remove()
            URL.revokeObjectURL(url)
        } catch (error) {
            console.error('Error downloading photo:', error)
            alert('Le téléchargement de la photo a échoué')
        } finally {
            setDownloading(false)
        }
    }

    return (
        <div className={`photo photo-status-${photo.status.toLowerCase()}`}>
            <img
                src={photo.thumbnailUrl || photo.url}
                alt={photo.description || ''}
                onClick={onOpen}
                style={onOpen ? { cursor: 'zoom-in' } : undefined}
            />
            {onUpdateStatus && (
                <PhotoSelectionButtons photo={photo} onUpdateStatus={onUpdateStatus} allowReset={allowReset} />
            )}
            {downloadUrl && (
                <button
                    type="button"
                    className="photo-download-button"
                    onClick={handleDownload}
                    disabled={downloading}
                    aria-label="Télécharger la photo"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v12" />
                        <polyline points="7 10 12 15 17 10" />
                        <path d="M5 19h14" />
                    </svg>
                </button>
            )}
            {onDelete && (
                <button
                    type="button"
                    className="photo-delete-button"
                    onClick={handleDelete}
                    disabled={deleting}
                    aria-label="Supprimer la photo"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                </button>
            )}
        </div>
    )
}
