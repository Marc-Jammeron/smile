import { useState, useEffect } from 'react'
import Photo from 'front-shared/src/Photo.jsx'
import PhotoLightbox from 'front-shared/src/PhotoLightbox.jsx'
import { STATUS } from 'front-shared/src/constants/collectionStatus.js'
import ClientGalleryHeader from 'front-shared/src/ClientGalleryHeader.jsx'
import { buildBrandingStyle } from 'front-shared/src/brandingStyle.js'
import { ARCHIVE_POLL_INTERVAL_MS, ARCHIVE_STATUS, isArchivePending, describeDownloadAllButton } from 'front-shared/src/archiveStatus.js'
import { getClientGallery, updateClientPhotoSelection, validateClientSelection, downloadAllDeliveredPhotos, getClientArchiveStatus } from '../api/publicGallery.js'
import ReviewCard from './ReviewCard.jsx'
import '../App.css'

const galleryLoadedState = (data) => ({
    loading: false, notFound: false, error: null, collection: data.collection, photos: data.photos, photographerName: data.photographerName, branding: data.branding ?? null, archive: data.archive ?? null
})

const galleryErrorState = (error) => ({
    loading: false,
    notFound: error.status === 404,
    error: error.status === 404 ? null : 'Impossible de charger la galerie. Réessayez plus tard.',
    collection: null,
    photos: []
})

export default function PublicGallery({ token }) {
    const [state, setState] = useState({ loading: true, notFound: false, error: null, collection: null, photos: [], photographerName: null, branding: null, archive: null })
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

    // The ZIP is prepared by the server in the background. While it is, the page asks for its
    // status every few seconds; the button only comes alive once the file is there.
    const archiveStatus = state.archive?.status
    useEffect(() => {
        if (!isArchivePending(archiveStatus)) return undefined
        let cancelled = false
        const timer = setInterval(async () => {
            try {
                const archive = await getClientArchiveStatus(token)
                if (!cancelled) setState(current => ({ ...current, archive }))
            } catch {
                // A failed poll changes nothing: the next one will tell.
            }
        }, ARCHIVE_POLL_INTERVAL_MS)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [archiveStatus, token])

    const handleDownloadAll = async () => {
        setDownloadingAll(true)
        setDownloadAllError(null)
        try {
            const result = await downloadAllDeliveredPhotos(token)
            if (result.state === 'ready') {
                // The browser downloads straight from storage (the URL forces a download, so the
                // page stays where it is): no fetch, no CORS, no multi-gigabyte blob in memory.
                window.location.assign(result.url)
            } else {
                // Not ready (the content changed, or the ZIP was lost and is being rebuilt) or
                // failed: show it, and the polling takes over.
                const status = result.state === 'failed' ? ARCHIVE_STATUS.FAILED : result.status
                setState(current => ({ ...current, archive: { ...current.archive, status } }))
            }
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

    const { collection, photos, photographerName, branding } = state
    const downloadAllButton = describeDownloadAllButton(state.archive, { downloading: downloadingAll, photographerName })
    const isSelecting = collection.status === STATUS.SELECTING
    const isReady = collection.status === STATUS.READY
    const isValidated = collection.status === STATUS.EDITING
    const selectedCount = photos.filter(photo => photo.status === 'SELECTED').length
    const canValidate = selectedCount >= collection.maxPhotos

    return (
        <div className="client-gallery" style={buildBrandingStyle(branding)}>
            {isSelecting && (
                <div
                    className={`client-selection-counter${canValidate ? ' is-complete' : ''}`}
                    role="status"
                    aria-live="polite"
                >
                    <span className="client-selection-counter-value">{selectedCount} / {collection.maxPhotos}</span>
                    <span className="client-selection-counter-label">sélectionnée{selectedCount > 1 ? 's' : ''}</span>
                </div>
            )}
            <ClientGalleryHeader
                branding={branding}
                photographerName={photographerName}
                title={collection.name}
                showWelcome={isSelecting}
                clientMessage={isSelecting ? collection.clientMessage : isReady ? collection.finalMessage : null}
                subtitle={isSelecting
                    ? null
                    : isReady
                        ? 'Vos photos retouchées sont prêtes — cliquez sur une photo pour l\'agrandir ou téléchargez-les'
                        : 'Votre sélection a été validée — cette galerie est en lecture seule'}
            />

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
                            disabled={downloadAllButton.disabled}
                        >
                            {downloadAllButton.label}
                        </button>
                    </div>
                )}

                {isReady && <ReviewCard variant="ready" />}
                {isValidated && <ReviewCard variant="validated" />}
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
