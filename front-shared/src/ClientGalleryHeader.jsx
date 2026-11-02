import ReactMarkdown from 'react-markdown'
import { resolveBrandDisplay } from './constants/brandMode.js'
import './clientGallery.css'

// Le message par galerie est du markdown limité à du texte courant (pas de titres, images ni HTML brut) ;
// les éléments non listés sont remplacés par leur contenu texte. react-markdown n'interprète pas le HTML
// et neutralise les URL `javascript:`.
const MESSAGE_MARKDOWN_ELEMENTS = ['p', 'strong', 'em', 'del', 'br', 'ul', 'ol', 'li', 'blockquote', 'a']
const MESSAGE_MARKDOWN_COMPONENTS = {
    a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
}

// En-tête de la vue client : marque (logo et/ou nom, séparateur, sous-titre), titre, message d'accueil, texte de statut.
// Rendu par front-client et par l'aperçu de front-admin : à modifier ici seulement.
// `branding` suit la forme du bloc `branding` de GET /client/:token (champs nullables bruts).
export default function ClientGalleryHeader({ branding, photographerName, title, subtitle, showWelcome, clientMessage }) {
    const logoUrl = branding?.logoUrl ?? null
    const brandName = branding?.displayName ?? photographerName
    const brandTag = branding?.tagline ?? 'Photographe'
    const showTagline = branding?.showTagline !== false
    const { showLogo, showName } = resolveBrandDisplay(branding?.brandMode, Boolean(logoUrl))
    const displayedName = showName ? brandName : null
    const welcomeMessage = branding?.welcomeMessage

    return (
        <div className={`client-gallery-header${subtitle ? '' : ' client-gallery-header-compact'}`}>
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
            {clientMessage && (
                <div className="client-gallery-message">
                    <ReactMarkdown
                        allowedElements={MESSAGE_MARKDOWN_ELEMENTS}
                        unwrapDisallowed
                        components={MESSAGE_MARKDOWN_COMPONENTS}
                    >
                        {clientMessage}
                    </ReactMarkdown>
                </div>
            )}
            {subtitle && <p className="client-gallery-subtitle">{subtitle}</p>}
        </div>
    )
}
