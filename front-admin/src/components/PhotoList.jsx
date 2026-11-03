import { useState } from 'react'
import Photo from 'front-shared/src/Photo.jsx'
import PhotoUploadForm from './PhotoUploadForm.jsx'
import ClientMessageBox from './ClientMessageBox.jsx'
import { apiFetch } from '../api/http.js'


const extractZipFilename =(contentDisposition, fallback) => {
    const match = contentDisposition?.match(/filename="?([^";]+)"?/)
    return match ? match[1] : fallback
}

const MESSAGE_LABEL = (title) =>
    `${title} (optionnel, markdown : **gras**, *italique*, listes, [liens](https://…)) — n'hésite pas à demander à ChatGPT de mettre ton texte au format md avant de le copier-coller`

export default function PhotoList({ collection, photos, loading, onBack, onAddPhotos, onDeletePhoto, onDeleteDeliveredPhoto, onUpdatePhotoStatus, onRevokeAccess, onUpdateMessage, onMarkReady, onDeleteCollection }) {
    const [showForm, setShowForm] = useState(false)
    const [showDeliveredForm, setShowDeliveredForm] = useState(false)
    const [copied, setCopied] = useState(false)
    const [revoking, setRevoking] = useState(false)
    const [downloadingSelection, setDownloadingSelection] = useState(false)
    const [downloadError, setDownloadError] = useState(null)
    const [markingReady, setMarkingReady] = useState(false)
    const [markReadyError, setMarkReadyError] = useState(null)
    const [deleting, setDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState(null)
    const canSelect = collection.status === 'SELECTING'
    const canAddPhotos = !['EDITING', 'READY', 'ARCHIVED'].includes(collection.status)
    const isEditing = collection.status === 'EDITING'
    const isReady = collection.status === 'READY'
    const selectedCount = photos.filter(photo => photo.status === 'SELECTED').length
    // A collection created straight in EDITING (final photos uploaded directly) never had a client selection.
    const hasSelection = collection.maxPhotos > 0 || selectedCount > 0
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
        const countMismatchNote = hasSelection && deliveredPhotos.length !== selectedCount
            ? ` (${deliveredPhotos.length} photo${deliveredPhotos.length > 1 ? 's' : ''} livrée${deliveredPhotos.length > 1 ? 's' : ''} pour ${selectedCount} sélectionnée${selectedCount > 1 ? 's' : ''} par le client)`
            : ''
        const confirmed = window.confirm(
            hasSelection
                ? `Cette action est définitive : les photos non retenues (sélection, rejetées) seront supprimées et ne pourront pas être récupérées.${countMismatchNote}\n\nMarquer la collection comme prête ?`
                : `Le lien client sera activé et le client pourra télécharger les ${deliveredPhotos.length} photo${deliveredPhotos.length > 1 ? 's' : ''} livrée${deliveredPhotos.length > 1 ? 's' : ''}.\n\nMarquer la collection comme prête ?`
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

    const handleDeleteCollection = async () => {
        const photoCount = photos.length
        const confirmed = window.confirm(
            `⚠️ Suppression définitive de la galerie « ${collection.name} »\n\n` +
            `Seront supprimés sans possibilité de récupération :\n` +
            `• les ${photoCount} photo${photoCount > 1 ? 's' : ''} (originaux, miniatures, aperçus, fichiers RAW/XMP) stockées sur S3\n` +
            `• le lien client, qui ne fonctionnera plus\n` +
            `• la sélection et l'historique de la galerie\n\n` +
            `Supprimer cette galerie ?`
        )
        if (!confirmed) return

        setDeleting(true)
        setDeleteError(null)
        try {
            await onDeleteCollection(collection.id)
        } catch (error) {
            console.error('Error deleting collection:', error)
            setDeleteError(error.message)
            setDeleting(false)
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
                {!loading && (
                    <span className="selection-counter">
                        {photos.length} photo{photos.length > 1 ? 's' : ''} au total
                    </span>
                )}
                {hasSelection && (
                    <span className="selection-counter">
                        {selectedCount} / {collection.maxPhotos} sélectionnée{selectedCount > 1 ? 's' : ''}
                    </span>
                )}
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
                <button
                    type="button"
                    className="button-outline button-outline-danger"
                    onClick={handleDeleteCollection}
                    disabled={deleting}
                >
                    {deleting ? 'Suppression...' : 'Supprimer la galerie'}
                </button>
                {collection.status === 'EDITING' && hasSelection && (
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
            {deleteError && (
                <div className="toast toast-error" role="alert">
                    <span>{deleteError}</span>
                    <button type="button" className="toast-dismiss" onClick={() => setDeleteError(null)} aria-label="Fermer">×</button>
                </div>
            )}
            {downloadError && (
                <div className="toast toast-error" role="alert">
                    <span>{downloadError}</span>
                    <button type="button" className="toast-dismiss" onClick={() => setDownloadError(null)} aria-label="Fermer">×</button>
                </div>
            )}
            {collection.status === 'SELECTING' && canViewAsClient && (
                <ClientMessageBox
                    id="client-message"
                    label={MESSAGE_LABEL('Message pour le client')}
                    placeholder="Affiché en haut de la galerie du client pendant la sélection"
                    savedValue={collection.clientMessage}
                    onSave={(text) => onUpdateMessage(collection.id, 'clientMessage', text)}
                />
            )}
            {isReady && canViewAsClient && (
                <ClientMessageBox
                    id="final-message"
                    label={MESSAGE_LABEL('Message final pour le client')}
                    placeholder="Affiché en haut de la galerie du client une fois les photos livrées"
                    savedValue={collection.finalMessage}
                    onSave={(text) => onUpdateMessage(collection.id, 'finalMessage', text)}
                />
            )}
            {(collection.status === 'SELECTING' || isReady) && clientGalleryUrl && (
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
                                {hasSelection
                                    ? `${deliveredPhotos.length} uploadée${deliveredPhotos.length > 1 ? 's' : ''} / ${selectedCount} sélectionnée${selectedCount > 1 ? 's' : ''}`
                                    : `${deliveredPhotos.length} uploadée${deliveredPhotos.length > 1 ? 's' : ''}`}
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
                !isReady && !(isEditing && !hasSelection) && <p className="status-message">Aucune photo dans cette collection</p>
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
