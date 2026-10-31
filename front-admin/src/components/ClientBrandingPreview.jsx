import ClientGalleryHeader from 'front-shared/src/ClientGalleryHeader.jsx'
import { buildBrandingStyle } from 'front-shared/src/brandingStyle.js'

const SAMPLE_TITLE = 'Mariage de Léa & Tom'
const SAMPLE_SUBTITLE = "Choisissez 20 photos parmi la sélection ci-dessous — 3 sélectionnées pour l'instant"
const TILE_COUNT = 3

// Aperçu de la vue client en cours de sélection (le seul statut où tout est visible).
// Même composant d'en-tête et mêmes variables CSS que front-client : voir ClientGalleryHeader.
export default function ClientBrandingPreview({ branding, photographerName }) {
    return (
        <div className="client-preview">
            <p className="upload-file-count">Aperçu de la vue client (pendant la sélection)</p>
            <div className="client-gallery client-preview-frame" style={buildBrandingStyle(branding)}>
                <ClientGalleryHeader
                    branding={branding}
                    photographerName={photographerName}
                    title={SAMPLE_TITLE}
                    subtitle={SAMPLE_SUBTITLE}
                    showWelcome
                />
                <div className="client-preview-tiles" aria-hidden="true">
                    {Array.from({ length: TILE_COUNT }, (_, index) => (
                        <div key={index} className="client-preview-tile" />
                    ))}
                </div>
            </div>
        </div>
    )
}
