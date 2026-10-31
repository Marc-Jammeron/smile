// Ce que l'en-tête de la vue client affiche. Identifiants dupliqués dans
// back/src/services/settings.constants.js (BRAND_MODES) : maintenir les deux listes.
// Pas de mode choisi (null) : le logo s'il existe, sinon le nom.

export const BRAND_MODE_LABELS = {
    logo: 'Logo seul',
    name: 'Nom seul',
    both: 'Logo et nom'
}

// Ce qu'il faut afficher pour un mode et un logo disponible ou non.
// Un mode « logo » sans logo retombe sur le nom, pour ne pas laisser l'en-tête vide.
export const resolveBrandDisplay = (brandMode, hasLogo) => {
    switch (brandMode) {
        case 'logo': return { showLogo: hasLogo, showName: !hasLogo }
        case 'name': return { showLogo: false, showName: true }
        case 'both': return { showLogo: hasLogo, showName: true }
        default: return { showLogo: hasLogo, showName: !hasLogo }
    }
}
