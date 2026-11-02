import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

// Police embarquée : l'image Docker (Alpine) n'a aucune police système.
const FONT_FILE = fileURLToPath(new URL('../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url));
const FONT = 'DejaVu Sans Bold 60';
const LETTER_SPACING = 2048; // 1/1024 de point (unité Pango)
const SHADOW_PADDING = 16;
const SHADOW_BLUR = 3;
const SHADOW_OPACITY = 0.8;

const escapeMarkup = (text) =>
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Texte blanc avec une ombre sombre, lisible sur fond clair comme sombre. Rendu à une
// taille arbitraire : buildPreview le redimensionne ensuite comme n'importe quelle image.
export const renderWatermarkText = async (text) => {
    const markup = `<span foreground="white" letter_spacing="${LETTER_SPACING}">${escapeMarkup(text)}</span>`;
    const glyphs = await sharp({
        text: { text: markup, rgba: true, align: 'center', font: FONT, fontfile: FONT_FILE, dpi: 72, spacing: 10 }
    }).png().toBuffer();

    const shadow = await sharp(glyphs)
        .linear([0, 0, 0, SHADOW_OPACITY], [0, 0, 0, 0])
        .extend({
            top: SHADOW_PADDING, bottom: SHADOW_PADDING, left: SHADOW_PADDING, right: SHADOW_PADDING,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .blur(SHADOW_BLUR)
        .png()
        .toBuffer();

    return sharp(shadow)
        .composite([{ input: glyphs, left: SHADOW_PADDING, top: SHADOW_PADDING }])
        .png()
        .toBuffer();
};
