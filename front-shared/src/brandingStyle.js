import { getFont } from './constants/fonts.js'
import { HEX_COLOR_REGEX } from './constants/clientColors.js'

// Variables CSS à poser sur `.client-gallery`, uniquement pour les réglages présents et valides.
// Aucune valeur du réseau n'est injectée telle quelle : la couleur est revalidée, la police
// vient d'une table de code indexée par identifiant.
export const buildBrandingStyle = (branding) => {
    const style = {}
    if (typeof branding?.colorBg === 'string' && HEX_COLOR_REGEX.test(branding.colorBg)) {
        style['--color-bg'] = branding.colorBg
    }
    const font = getFont(branding?.fontId)
    if (font) {
        style['--font-heading'] = font.heading
        style['--font-body'] = font.body
    }
    return style
}
