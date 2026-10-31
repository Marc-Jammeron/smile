// Équivalents hex des couleurs `oklch(...)` de `.client-gallery` dans front-client/src/App.css,
// pour le sélecteur de couleur et l'avertissement de contraste de l'admin.
// À recalculer si ces couleurs changent dans le CSS.

export const DEFAULT_CLIENT_BG = '#f9f6f2' // oklch(97.5% 0.006 80)
export const CLIENT_TEXT = '#13110f' // oklch(18% 0.005 80)
export const CLIENT_TEXT_SECONDARY = '#58554f' // oklch(45% 0.01 80)

export const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/

// Rapport de contraste WCAG entre deux couleurs #rrggbb.
export const contrastRatio = (hexA, hexB) => {
    const luminance = (hex) => {
        const [r, g, b] = [1, 3, 5].map((i) => {
            const channel = parseInt(hex.slice(i, i + 2), 16) / 255
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a)
    return (lighter + 0.05) / (darker + 0.05)
}
