export const WATERMARK_POSITIONS = ['northwest', 'northeast', 'center', 'southwest', 'southeast'];

export const WATERMARK_OPACITY_MIN = 10;
export const WATERMARK_OPACITY_MAX = 80;
export const WATERMARK_SIZE_MIN = 10;
export const WATERMARK_SIZE_MAX = 50;
export const WATERMARK_STEP = 5;

export const MAX_BRANDING_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BRANDING_DIMENSION = 2000;


export const getOriginalWatermarkValues = () => ({
    assetPath: process.env.WATERMARK_ASSET_PATH || './assets/watermark-placeholder.png',
    opacity: Number(process.env.WATERMARK_OPACITY || 0.6),
    position: process.env.WATERMARK_POSITION || 'southeast',
    margin: Number(process.env.WATERMARK_MARGIN || 24)
});
