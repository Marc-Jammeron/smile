// Polices de la vue client, choisies par identifiant. Les identifiants sont dupliqués dans
// back/src/services/settings.constants.js (FONT_IDS, back n'est pas un workspace) : la liste
// doit être maintenue aux deux endroits. Aucune chaîne `font-family` ne vient de l'API.
// Une police ajoutée ici doit aussi être embarquée (@fontsource) dans front-client/src/main.jsx.

export const DEFAULT_FONT_ID = 'cormorant'

const SOURCE_SANS = "'Source Sans 3', system-ui, sans-serif"

export const FONTS = {
    // Défaut : texte courant identique au CSS d'origine (« Work Sans » n'est pas chargée, rendu system-ui).
    cormorant: { label: 'Cormorant Garamond', heading: "'Cormorant Garamond', serif", body: "'Work Sans', var(--sans)" },
    playfair: { label: 'Playfair Display', heading: "'Playfair Display', serif", body: SOURCE_SANS },
    lora: { label: 'Lora', heading: "'Lora', serif", body: SOURCE_SANS },
    montserrat: { label: 'Montserrat', heading: "'Montserrat', sans-serif", body: "'Montserrat', sans-serif" },
    'dm-sans': { label: 'DM Sans', heading: "'DM Sans', sans-serif", body: "'DM Sans', sans-serif" }
}

export const FONT_IDS = Object.keys(FONTS)

export const getFont = (fontId) =>
    typeof fontId === 'string' && Object.hasOwn(FONTS, fontId) ? FONTS[fontId] : null
