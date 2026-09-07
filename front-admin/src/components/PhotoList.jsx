import { useState } from 'react'
import Photo from 'front-shared/src/Photo.jsx'
import PhotoUploadForm from './PhotoUploadForm.jsx'
import { apiFetch } from '../api/http.js'

const extractZipFilename = (contentDisposition, fallback) => {
    const match = contentDisposition?.match(/filename="?([^";]+)"?/)
    return match ? match[1] : fallback
}

export default function PhotoList({ collection, photos, loading, onBack, onAddPhotos, onDeletePhoto, onDeleteDeliveredPhoto, onUpdatePhotoStatus, onRevokeAccess, onMarkReady }) {
    const [showForm, setShowForm] = useState(false)
    const [showDeliveredForm, setShowDeliveredForm] = useState(false)
    const [copied, setCopied] = useState(false)
    const [revoking, setRevoking] = useState(false)
    const [downloadingSelection, setDownloadingSelection] = useState(false)
    const [downloadError, setDownloadError] = useState(null)
    const [markingReady, setMarkingReady] = useState(false)
    const [markReadyError, setMarkReadyError] = useState(null)
    const canSelect = collection.status === 'SELECTING'
    const canAddPhotos = !['EDITING', 'READY', 'ARCHIVED'].includes(collection.status)
    const isEditing = collection.status === 'EDITING'
    const isReady = collection.status === 'READY'
    const selectedCount = photos.filter(photo => photo.status === 'SELECTED').length
    const deliveredPhotos = photos.filter(photo => photo.status === 'DELIVERED')
    const otherPhotos = photos.filter(photo => photo.status !== 'DELIVERED')
    const clientGalleryUrl = collection.accessToken
        ? `${import.meta.env.VITE_CLIENT_BASE_URL}/gallery/${collection.accessToken}`
        : null

    const handleUpload = async (data, onProgress) => {
        await onAddPhotos(data, onProgress)
        setShowForm(false)
    }

    const handleUploadDelivered = async (data, onProgress) => {
        await onAddPhotos({ ...data, targetStatus: 'DELIVERED' }, onProgress)
        setShowDeliveredForm(false)
    }

    const handleMarkReady = async () => {
        const countMismatchNote = deliveredPhotos.length !== selectedCount
            ? ` (${deliveredPhotos.length} photo${deliveredPhotos.length > 1 ? 's' : ''} livrée${deliveredPhotos.length > 1 ? 's' : ''} pour ${selectedCount} sélectionnée${selectedCount > 1 ? 's' : ''} par le client)`
            : ''
        const confirmed = window.confirm(
            `Cette action est définitive : les photos non retenues (sélection, rejetées) seront supprimées et ne pourront pas être récupérées.${countMismatchNote}\n\nMarquer la collection comme prête ?`
        )
        if (!confirmed) return

        setMarkingReady(true)
        setMarkReadyError(null)
        try {
            await onMarkReady(collection.id)
        } catch (error) {
            console.error('Error marking collection as ready:', error)
            setMarkReadyError(error.message)
        } finally {
            setMarkingReady(false)
        }
    }

    const handleCopyLink = async () => {
        try {
            await navigator.clipboard.writeText(clientGalleryUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch (error) {
            console.error('Error copying link:', error)
            alert('Impossible de copier le lien')
        }
    }

    const handleRevoke = async () => {
        if (!window.confirm("Révoquer l'accès du client à cette galerie ?")) return
        setRevoking(true)
        try {
            await onRevokeAccess(collection.id)
        } catch (error) {
            console.error('Error revoking access:', error)
            alert("La révocation de l'accès a échoué")
        } finally {
            setRevoking(false)
        }
    }

    const handleDownloadSelection = async () => {
        setDownloadingSelection(true)
        setDownloadError(null)
        try {
            const response = await apiFetch(`/collections/${collection.id}/download-selection-hd`)
            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                throw new Error(data.error || 'Le téléchargement de la sélection HD a échoué')
            }
            const blob = await response.blob()
            const filename = extractZipFilename(response.headers.get('Content-Disposition'), `${collection.name}-HD.zip`)

            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = filename
            document.body.appendChild(link)
            link.click()
            link.remove()
            URL.revokeObjectURL(url)
        } catch (error) {
            console.error('Error downloading HD selection:', error)
            setDownloadError(error.message)
        } finally {
            setDownloadingSelection(false)
        }
    }

    const canViewAsClient = clientGalleryUrl && !collection.accessTokenRevokedAt

    return (
        <div className="photo-list">
            <div className="photo-list-header">
                <button className="back-button" onClick={onBack}>&larr; Retour aux collections</button>
                <h2>{collection.name}</h2>
                <span className="selection-counter">
                    {selectedCount} / {collection.maxPhotos} sélectionnée{selectedCount > 1 ? 's' : ''}
                </span>
                {!showForm && canAddPhotos && (
                    <button className="button-primary" onClick={() => setShowForm(true)}>
                        + Ajouter des photos
                    </button>
                )}
                {canViewAsClient && (
                    <a
                        className="button-outline button-outline-accent"
                        href={clientGalleryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Voir comme client
                    </a>
                )}
                {collection.status === 'EDITING' && (
                    <button
                        type="button"
                        className="button-primary"
                        onClick={handleDownloadSelection}
                        disabled={downloadingSelection || selectedCount === 0}
                        title={selectedCount === 0 ? 'Aucune photo sélectionnée' : undefined}
                    >
                        {downloadingSelection ? (
                            <>
                                <span className="button-spinner" />
                                Génération du ZIP…
                            </>
                        ) : (
                            `Télécharger la sélection HD (${selectedCount} photo${selectedCount > 1 ? 's' : ''})`
                        )}
                    </button>
                )}
            </div>
            {downloadError && (
                <div className="toast toast-error" role="alert">
                    <span>{downloadError}</span>
                    <button type="button" className="toast-dismiss" onClick={() => setDownloadError(null)} aria-label="Fermer">×</button>
                </div>
            )}
            {collection.status === 'SELECTING' && clientGalleryUrl && (
                <div className={`access-link-box${collection.accessTokenRevokedAt ? ' access-link-revoked' : ''}`}>
                    {collection.accessTokenRevokedAt ? (
                        <span>Accès client révoqué</span>
                    ) : (
                        <>
                            <span className="access-link-url">{clientGalleryUrl}</span>
                            <button type="button" className="button-outline" onClick={handleCopyLink}>
                                {copied ? 'Copié !' : 'Copier le lien'}
                            </button>
                            <button type="button" className="button-outline button-outline-danger" onClick={handleRevoke} disabled={revoking}>
                                {revoking ? 'Révocation...' : "Révoquer l'accès"}
                            </button>
                        </>
                    )}
                </div>
            )}
            {showForm && (
                <PhotoUploadForm onUpload={handleUpload} onCancel={() => setShowForm(false)} existingPhotos={photos} />
            )}
            {(isEditing || isReady) && (
                <div className="final-delivery-section">
                    <div className="final-delivery-header">
                        <h3>{isEditing ? 'Livraison finale' : 'Photos livrées'}</h3>
                        {isEditing && (
                            <span className="selection-counter">
                                {deliveredPhotos.length} uploadée{deliveredPhotos.length > 1 ? 's' : ''} / {selectedCount} sélectionnée{selectedCount > 1 ? 's' : ''}
                            </span>
                        )}
                        {isEditing && !showDeliveredForm && (
                            <button type="button" className="button-primary" onClick={() => setShowDeliveredForm(true)}>
                                + Ajouter les photos retouchées
                            </button>
                        )}
                        {isEditing && (
                            <button
                                type="button"
                                className="button-primary"
                                onClick={handleMarkReady}
                                disabled={deliveredPhotos.length === 0 || markingReady}
                                title={deliveredPhotos.length === 0 ? 'Aucune photo livrée uploadée' : undefined}
                            >
                                {markingReady ? 'Passage en cours...' : 'Marquer comme prêt'}
                            </button>
                        )}
                    </div>
                    {markReadyError && (
                        <div className="toast toast-error" role="alert">
                            <span>{markReadyError}</span>
                            <button type="button" className="toast-dismiss" onClick={() => setMarkReadyError(null)} aria-label="Fermer">×</button>
                        </div>
                    )}
                    {isEditing && showDeliveredForm && (
                        <PhotoUploadForm onUpload={handleUploadDelivered} onCancel={() => setShowDeliveredForm(false)} existingPhotos={photos} />
                    )}
                    {deliveredPhotos.length > 0 ? (
                        <div className="photo-grid">
                            {deliveredPhotos.map(photo => (
                                <Photo
                                    key={photo.id}
                                    photo={photo}
                                    onDelete={isEditing ? onDeleteDeliveredPhoto : null}
                                />
                            ))}
                        </div>
                    ) : (
                        <p className="status-message">Aucune photo livrée pour l'instant</p>
                    )}
                </div>
            )}
            {loading ? (
                <p className="status-message">Chargement des photos...</p>
            ) : otherPhotos.length === 0 ? (
                !isReady && <p className="status-message">Aucune photo dans cette collection</p>
            ) : (
                <div className="photo-grid">
                    {otherPhotos.map(photo => (
                        <Photo
                            key={photo.id}
                            photo={photo}
                            onDelete={onDeletePhoto}
                            onUpdateStatus={canSelect ? onUpdatePhotoStatus : null}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
