import { useEffect, useState } from 'react'
import { PhotoSelectionButtons } from './Photo.jsx'

function LightboxImage({ src, alt }) {
    const [loaded, setLoaded] = useState(false)

    return (
        <>
            {!loaded && <div className="lightbox-spinner" aria-label="Chargement..." />}
            <img
                src={src}
                alt={alt}
                className="lightbox-image"
                style={{ visibility: loaded ? 'visible' : 'hidden' }}
                onLoad={() => setLoaded(true)}
            />
        </>
    )
}

export default function PhotoLightbox({ photos, currentIndex, onClose, onNavigate, onUpdateStatus }) {
    const photo = photos[currentIndex]
    const src = photo.previewUrl || photo.thumbnailUrl || photo.url

    useEffect(() => {
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'ArrowLeft') onNavigate(-1)
            if (event.key === 'ArrowRight') onNavigate(1)
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [onClose, onNavigate])

    return (
        <div className="lightbox-overlay" onClick={onClose}>
            <div className="lightbox-content" onClick={(event) => event.stopPropagation()}>
                <button type="button" className="lightbox-close-button" onClick={onClose} aria-label="Fermer">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>

                <button
                    type="button"
                    className="lightbox-nav-button lightbox-prev-button"
                    onClick={() => onNavigate(-1)}
                    disabled={currentIndex === 0}
                    aria-label="Photo précédente"
                >
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                </button>

                <div className="lightbox-image-wrapper">
                    <LightboxImage key={src} src={src} alt={photo.description || ''} />
                    {onUpdateStatus && (
                        <PhotoSelectionButtons photo={photo} onUpdateStatus={onUpdateStatus} allowReset={false} />
                    )}
                </div>

                <button
                    type="button"
                    className="lightbox-nav-button lightbox-next-button"
                    onClick={() => onNavigate(1)}
                    disabled={currentIndex === photos.length - 1}
                    aria-label="Photo suivante"
                >
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                    </svg>
                </button>
            </div>
        </div>
    )
}
