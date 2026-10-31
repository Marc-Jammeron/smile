import { resolveBrandDisplay } from './constants/brandMode.js'
import './clientGallery.css'

// En-tête de la vue client : marque (logo et/ou nom, séparateur, sous-titre), titre, message d'accueil, texte de statut.
// Rendu par front-client et par l'aperçu de front-admin : à modifier ici seulement.
// `branding` suit la forme du bloc `branding` de GET /client/:token (champs nullables bruts).
export default function ClientGalleryHeader({ branding, photographerName, title, subtitle, showWelcome }) {
    const logoUrl = branding?.logoUrl ?? null
    const brandName = branding?.displayName ?? photographerName
    const brandTag = branding?.tagline ?? 'Photographe'
    const showTagline = branding?.showTagline !== false
    const { showLogo, showName } = resolveBrandDisplay(branding?.brandMode, Boolean(logoUrl))
    const displayedName = showName ? brandName : null
    const welcomeMessage = branding?.welcomeMessage

    return (
        <div className="client-gallery-header">
            {(showLogo || displayedName) && (
                <div className="client-gallery-brand">
                    {showLogo && (
                        <img className="client-gallery-brand-logo" src={logoUrl} alt={brandName ?? ''} />
                    )}
                    {displayedName && <span className="client-gallery-brand-name">{displayedName}</span>}
                    <span className="client-gallery-brand-divider" />
                    {showTagline && <span className="client-gallery-brand-tag">{brandTag}</span>}
                </div>
            )}
            <h1 className="client-gallery-title">{title}</h1>
            {showWelcome && welcomeMessage && (
                <p className="client-gallery-welcome">{welcomeMessage}</p>
            )}
            <p className="client-gallery-subtitle">{subtitle}</p>
        </div>
    )
}
