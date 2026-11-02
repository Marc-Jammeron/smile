export const WATERMARK_POSITIONS = ['northwest', 'northeast', 'center', 'southwest', 'southeast'];

export const WATERMARK_OPACITY_MIN = 10;
export const WATERMARK_OPACITY_MAX = 100;
export const WATERMARK_SIZE_MIN = 10;
export const WATERMARK_SIZE_MAX = 100;
export const WATERMARK_STEP = 5;

export const WATERMARK_TEXT_MAX_LINES = 3;
export const WATERMARK_TEXT_MAX_LINE_LENGTH = 40;
export const WATERMARK_TEXT_DEFAULT_SIZE = 30;

export const FONT_IDS = ['cormorant', 'playfair', 'lora', 'montserrat', 'dm-sans'];

export const BRAND_MODES = ['logo', 'name', 'both'];

export const MAX_BRANDING_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BRANDING_DIMENSION = 2000;


export const getOriginalWatermarkValues = () => ({
    assetPath: process.env.WATERMARK_ASSET_PATH || './assets/watermark-placeholder.png',
    opacity: Number(process.env.WATERMARK_OPACITY || 0.6),
    position: process.env.WATERMARK_POSITION || 'southeast',
    margin: Number(process.env.WATERMARK_MARGIN || 24)
});
