import { useState, useEffect } from 'react'
import Photo from 'front-shared/src/Photo.jsx'
import PhotoLightbox from 'front-shared/src/PhotoLightbox.jsx'
import { STATUS } from 'front-shared/src/constants/collectionStatus.js'
import { getClientGallery, updateClientPhotoSelection, validateClientSelection, downloadAllDeliveredPhotos } from '../api/publicGallery.js'
import '../App.css'

const extractZipFilename = (contentDisposition, fallback) => {
    const match = contentDisposition?.match(/filename="?([^";]+)"?/)
    return match ? match[1] : fallback
}

const galleryLoadedState = (data) => ({
    loading: false, notFound: false, error: null, collection: data.collection, photos: data.photos, photographerName: data.photographerName
})

const galleryErrorState = (error) => ({
    loading: false,
    notFound: error.status === 404,
    error: error.status === 404 ? null : 'Impossible de charger la galerie. Réessayez plus tard.',
    collection: null,
    photos: []
})

export default function PublicGallery({ token }) {
    const [state, setState] = useState({ loading: true, notFound: false, error: null, collection: null, photos: [], photographerName: null })
    const [validating, setValidating] = useState(false)
    const [validationError, setValidationError] = useState(null)
    const [lightboxIndex, setLightboxIndex] = useState(null)
    const [downloadingAll, setDownloadingAll] = useState(false)
    const [downloadAllError, setDownloadAllError] = useState(null)

    useEffect(() => {
        getClientGallery(token)
            .then(data => setState(galleryLoadedState(data)))
            .catch(error => setState(galleryErrorState(error)))
    }, [token])

    const loadGallery = async () => {
        try {
            const data = await getClientGallery(token)
            setState(galleryLoadedState(data))
        } catch (error) {
            setState(galleryErrorState(error))
        }
    }

    const handleUpdateStatus = async (photoId, status) => {
        await updateClientPhotoSelection(token, photoId, status)
        setState(current => ({
            ...current,
            photos: current.photos.map(photo => photo.id === photoId ? { ...photo, status } : photo)
        }))
    }

    const handleDownloadAll = async () => {
        setDownloadingAll(true)
        setDownloadAllError(null)
        try {
            const response = await downloadAllDeliveredPhotos(token)
            const blob = await response.blob()
            const filename = extractZipFilename(response.headers.get('Content-Disposition'), `${state.collection.name}.zip`)

            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = filename
            document.body.appendChild(link)
            link.click()
            link.remove()
            URL.revokeObjectURL(url)
        } catch (error) {
            setDownloadAllError(error.message)
        } finally {
            setDownloadingAll(false)
        }
    }

    const handleValidate = async () => {
        setValidating(true)
        setValidationError(null)
        try {
            await validateClientSelection(token)
            await loadGallery()
        } catch (error) {
            setValidationError(error.message)
        } finally {
            setValidating(false)
        }
    }

    if (state.loading) {
        return (
            <div className="client-gallery">
                <p className="status-message">Chargement...</p>
            </div>
        )
    }

    if (state.notFound) {
        return (
            <div className="client-gallery">
                <p className="status-message">Ce lien n'est plus valide.</p>
            </div>
        )
    }

    if (state.error) {
        return (
            <div className="client-gallery">
                <p className="status-message">{state.error}</p>
                <div className="client-gallery-actions">
                    <button type="button" className="button-outline" onClick={loadGallery}>Réessayer</button>
                </div>
            </div>
        )
    }

    const { collection, photos, photographerName } = state
    const isSelecting = collection.status === STATUS.SELECTING
    const isReady = collection.status === STATUS.READY
    const selectedCount = photos.filter(photo => photo.status === 'SELECTED').length
    const canValidate = selectedCount >= collection.maxPhotos

    return (
        <div className="client-gallery">
            <div className="client-gallery-header">
                {photographerName && (
                    <div className="client-gallery-brand">
                        <span className="client-gallery-brand-name">{photographerName}</span>
                        <span className="client-gallery-brand-divider" />
                        <span className="client-gallery-brand-tag">Photographe</span>
                    </div>
                )}
                <h1 className="client-gallery-title">{collection.name}</h1>
                <p className="client-gallery-subtitle">
                    {isSelecting
                        ? `Choisissez ${collection.maxPhotos} photos parmi la sélection ci-dessous — ${selectedCount} sélectionnée${selectedCount > 1 ? 's' : ''} pour l'instant`
                        : isReady
                            ? 'Vos photos retouchées sont prêtes — cliquez sur une photo pour l\'agrandir ou téléchargez-les'
                            : 'Votre sélection a été validée — cette galerie est en lecture seule'}
                </p>
            </div>

            <div className="client-gallery-body">
                {photos.length === 0 ? (
                    <p className="status-message">Aucune photo dans cette collection</p>
                ) : (
                    <div className="client-photo-grid">
                        {photos.map((photo, index) => (
                            <Photo
                                key={photo.id}
                                photo={photo}
                                onUpdateStatus={isSelecting ? handleUpdateStatus : null}
                                onOpen={() => setLightboxIndex(index)}
                                allowReset={false}
                                downloadUrl={isReady ? photo.url : undefined}
                                downloadFilename={isReady ? (photo.originalFilename || undefined) : undefined}
                            />
                        ))}
                    </div>
                )}

                {isSelecting && (
                    <div className="client-gallery-actions">
                        {validationError && <p className="form-error">{validationError}</p>}
                        <button
                            type="button"
                            className="client-validate-button"
                            onClick={handleValidate}
                            disabled={!canValidate || validating}
                        >
                            {validating ? 'Validation...' : 'Valider ma sélection'}
                        </button>
                    </div>
                )}

                {isReady && photos.length > 0 && (
                    <div className="client-gallery-actions">
                        {downloadAllError && <p className="form-error">{downloadAllError}</p>}
                        <button
                            type="button"
                            className="client-validate-button"
                            onClick={handleDownloadAll}
                            disabled={downloadingAll}
                        >
                            {downloadingAll ? 'Génération du ZIP…' : 'Télécharger tout'}
                        </button>
                    </div>
                )}
            </div>

            {lightboxIndex !== null && (
                <PhotoLightbox
                    photos={photos}
                    currentIndex={lightboxIndex}
                    onClose={() => setLightboxIndex(null)}
                    onNavigate={(delta) => setLightboxIndex(current =>
                        Math.min(Math.max(current + delta, 0), photos.length - 1)
                    )}
                    onUpdateStatus={isSelecting ? handleUpdateStatus : null}
                />
            )}
        </div>
    )
}
