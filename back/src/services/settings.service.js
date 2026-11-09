import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import db from '../repository/db.repository.js';
import s3Repository from '../repository/s3.repository.js';
import {
    WATERMARK_POSITIONS,
    WATERMARK_OPACITY_MIN,
    WATERMARK_OPACITY_MAX,
    WATERMARK_SIZE_MIN,
    WATERMARK_SIZE_MAX,
    WATERMARK_STEP,
    MAX_BRANDING_FILE_BYTES,
    MAX_BRANDING_DIMENSION,
    FONT_IDS,
    BRAND_MODES,
    WATERMARK_TEXT_MAX_LINES,
    WATERMARK_TEXT_MAX_LINE_LENGTH,
    WATERMARK_TEXT_DEFAULT_SIZE,
    getOriginalWatermarkValues
} from './settings.constants.js';
import { renderWatermarkText } from './watermark-text.service.js';
import logger from '../logger.js';

const log = logger.child('settings.service');


const SETTINGS_ID = 1;
const WATERMARK_FIELDS = ['watermarkKey', 'watermarkText', 'watermarkPosition', 'watermarkOpacity', 'watermarkSize'];
const BRANDING_FIELDS = ['logoKey', 'displayName', 'tagline', 'welcomeMessage', 'fontId', 'colorBg', 'brandMode', 'showTagline'];
const SETTINGS_FIELDS = [...WATERMARK_FIELDS, ...BRANDING_FIELDS];

const ASSET_KEY_FIELDS = ['watermarkKey', 'logoKey'];

const TEXT_LIMITS = { displayName: 40, tagline: 40, welcomeMessage: 280 };
const TEXT_LABELS = { displayName: "Nom affiché", tagline: "Sous-titre", welcomeMessage: "Message d'accueil" };
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WATERMARK_KEY_REGEX = new RegExp(`^branding/watermark/${UUID_PATTERN}\\.png$`);
const LOGO_KEY_REGEX = new RegExp(`^branding/logo/${UUID_PATTERN}\\.(png|jpg|webp)$`);

const ASSET_KINDS = {
    watermark: {
        contentTypes: ['image/png'],
        formats: { png: 'png' },
        formatError: 'Le fichier doit être un PNG'
    },
    logo: {
        contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
        formats: { png: 'png', jpeg: 'jpg', webp: 'webp' },
        formatError: 'Le fichier doit être un PNG, un JPEG ou un WebP'
    }
};

const createError = (status, message) => Object.assign(new Error(message), { status });
const badRequest = (message) => createError(400, message);

const isSteppedInteger = (value, min, max) =>
    Number.isInteger(value) && value >= min && value <= max && value % WATERMARK_STEP === 0;

const validateText = (field, value) => {
    if (value === null) {
        return null;
    }
    const label = TEXT_LABELS[field];
    if (typeof value !== 'string') {
        throw badRequest(`${label} invalide`);
    }
    if (CONTROL_CHARACTERS.test(value)) {
        throw badRequest(`${label} : caractères non autorisés`);
    }
    const trimmed = value.trim();
    // Points de code, pas unités UTF-16 : un emoji compte pour un caractère.
    if ([...trimmed].length > TEXT_LIMITS[field]) {
        throw badRequest(`${label} trop long (${TEXT_LIMITS[field]} caractères maximum)`);
    }
    return trimmed === '' ? null : trimmed;
};

const validateWatermarkText = (value) => {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw badRequest('Texte du watermark invalide');
    }
    if (CONTROL_CHARACTERS.test(value.replace(/\r?\n/g, ''))) {
        throw badRequest('Texte du watermark : caractères non autorisés');
    }
    const lines = value.split(/\r?\n/).map(line => line.trim());
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) {
        return null;
    }
    if (lines.length > WATERMARK_TEXT_MAX_LINES) {
        throw badRequest(`Texte du watermark : ${WATERMARK_TEXT_MAX_LINES} lignes maximum`);
    }
    if (lines.some(line => [...line].length > WATERMARK_TEXT_MAX_LINE_LENGTH)) {
        throw badRequest(`Texte du watermark : ${WATERMARK_TEXT_MAX_LINE_LENGTH} caractères maximum par ligne`);
    }
    return lines.join('\n');
};

export const validateSettingsValues = async (values, allowedFields = SETTINGS_FIELDS) => {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        throw badRequest('Requête invalide');
    }

    const unknownKeys = Object.keys(values).filter(key => !allowedFields.includes(key));
    if (unknownKeys.length > 0) {
        throw badRequest(`Réglage inconnu : ${unknownKeys.join(', ')}`);
    }

    const validated = {};

    if ('watermarkKey' in values) {
        const { watermarkKey } = values;
        if (watermarkKey !== null) {
            if (typeof watermarkKey !== 'string' || !WATERMARK_KEY_REGEX.test(watermarkKey)) {
                throw badRequest('Image de watermark invalide');
            }
            if (!(await s3Repository.objectExists(watermarkKey))) {
                throw badRequest('Image de watermark introuvable');
            }
        }
        validated.watermarkKey = watermarkKey;
    }

    if ('watermarkText' in values) {
        validated.watermarkText = validateWatermarkText(values.watermarkText);
    }

    if ('watermarkPosition' in values) {
        const { watermarkPosition } = values;
        if (watermarkPosition !== null && !WATERMARK_POSITIONS.includes(watermarkPosition)) {
            throw badRequest('Position du watermark invalide');
        }
        validated.watermarkPosition = watermarkPosition;
    }

    if ('watermarkOpacity' in values) {
        const { watermarkOpacity } = values;
        if (watermarkOpacity !== null && !isSteppedInteger(watermarkOpacity, WATERMARK_OPACITY_MIN, WATERMARK_OPACITY_MAX)) {
            throw badRequest(`Opacité invalide (de ${WATERMARK_OPACITY_MIN} à ${WATERMARK_OPACITY_MAX}, par pas de ${WATERMARK_STEP})`);
        }
        validated.watermarkOpacity = watermarkOpacity;
    }

    if ('watermarkSize' in values) {
        const { watermarkSize } = values;
        if (watermarkSize !== null && !isSteppedInteger(watermarkSize, WATERMARK_SIZE_MIN, WATERMARK_SIZE_MAX)) {
            throw badRequest(`Taille invalide (de ${WATERMARK_SIZE_MIN} à ${WATERMARK_SIZE_MAX}, par pas de ${WATERMARK_STEP})`);
        }
        validated.watermarkSize = watermarkSize;
    }

    if ('logoKey' in values) {
        const { logoKey } = values;
        if (logoKey !== null) {
            if (typeof logoKey !== 'string' || !LOGO_KEY_REGEX.test(logoKey)) {
                throw badRequest('Logo invalide');
            }
            if (!(await s3Repository.objectExists(logoKey))) {
                throw badRequest('Logo introuvable');
            }
        }
        validated.logoKey = logoKey;
    }

    for (const field of Object.keys(TEXT_LIMITS)) {
        if (field in values) {
            validated[field] = validateText(field, values[field]);
        }
    }

    if ('fontId' in values) {
        const { fontId } = values;
        if (fontId !== null && !FONT_IDS.includes(fontId)) {
            throw badRequest('Police invalide');
        }
        validated.fontId = fontId;
    }

    if ('colorBg' in values) {
        const { colorBg } = values;
        if (colorBg !== null && (typeof colorBg !== 'string' || !COLOR_REGEX.test(colorBg))) {
            throw badRequest('Couleur de fond invalide (format #rrggbb)');
        }
        validated.colorBg = colorBg === null ? null : colorBg.toLowerCase();
    }

    if ('brandMode' in values) {
        const { brandMode } = values;
        if (brandMode !== null && !BRAND_MODES.includes(brandMode)) {
            throw badRequest("Affichage de l'en-tête invalide");
        }
        validated.brandMode = brandMode;
    }

    if ('showTagline' in values) {
        const { showTagline } = values;
        if (showTagline !== null && typeof showTagline !== 'boolean') {
            throw badRequest('Affichage du sous-titre invalide');
        }
        validated.showTagline = showTagline;
    }

    return validated;
};

export const validateWatermarkValues = (values) => validateSettingsValues(values, WATERMARK_FIELDS);

const findRow = () => db.GallerySettings.findByPk(SETTINGS_ID);

export const loadSavedWatermarkValues = async () => {
    const row = await findRow();
    return {
        watermarkKey: row?.watermarkKey ?? null,
        watermarkText: row?.watermarkText ?? null,
        watermarkPosition: row?.watermarkPosition ?? null,
        watermarkOpacity: row?.watermarkOpacity ?? null,
        watermarkSize: row?.watermarkSize ?? null
    };
};

export const buildWatermarkConfig = async (values) => {
    const original = getOriginalWatermarkValues();
    let image = original.assetPath;
    let size = values.watermarkSize ?? null;
    let source = 'default-asset';
    if (values.watermarkText) {
        image = await renderWatermarkText(values.watermarkText);
        size ??= WATERMARK_TEXT_DEFAULT_SIZE;
        source = 'text';
    } else if (values.watermarkKey) {
        image = await s3Repository.getObject(values.watermarkKey);
        source = 'custom-image';
    }
    log.debug('Watermark config built', {
        source,
        position: values.watermarkPosition ?? original.position,
        opacity: values.watermarkOpacity ?? Math.round(original.opacity * 100),
        size
    });

    return {
        image,
        position: values.watermarkPosition ?? original.position,
        opacity: values.watermarkOpacity != null ? values.watermarkOpacity / 100 : original.opacity,
        size,
        margin: original.margin
    };
};

// Saved watermark settings resolved into what buildPreview consumes. Loaded once per
// confirm request (not per photo): one DB query and at most one S3 GET / text render.
export const loadWatermarkConfig = async () => buildWatermarkConfig(await loadSavedWatermarkValues());

const toSettingsDTO = async (row) => {
    const original = getOriginalWatermarkValues();
    return {
        watermarkKey: row?.watermarkKey ?? null,
        watermarkText: row?.watermarkText ?? null,
        watermarkPosition: row?.watermarkPosition ?? original.position,
        watermarkOpacity: row?.watermarkOpacity ?? Math.round(original.opacity * 100),
        watermarkSize: row?.watermarkSize ?? null,
        logoKey: row?.logoKey ?? null,
        displayName: row?.displayName ?? null,
        tagline: row?.tagline ?? null,
        welcomeMessage: row?.welcomeMessage ?? null,
        fontId: row?.fontId ?? null,
        colorBg: row?.colorBg ?? null,
        brandMode: row?.brandMode ?? null,
        showTagline: row?.showTagline ?? null,
        logoUrl: row?.logoKey ? await s3Repository.getSignedDownloadUrl(row.logoKey) : null,
        photographerName: process.env.PHOTOGRAPHER_DISPLAY_NAME || null,
        updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null
    };
};

export const getSettings = async () => toSettingsDTO(await findRow());

export const getClientBranding = async () => {
    const row = await findRow();
    return {
        logoUrl: row?.logoKey ? await s3Repository.getSignedDownloadUrl(row.logoKey) : null,
        displayName: row?.displayName ?? null,
        tagline: row?.tagline ?? null,
        welcomeMessage: row?.welcomeMessage ?? null,
        fontId: row?.fontId ?? null,
        colorBg: row?.colorBg ?? null,
        brandMode: row?.brandMode ?? null,
        showTagline: row?.showTagline ?? null
    };
};

const deleteObjectQuietly = async (key) => {
    try {
        await s3Repository.deleteObject(key);
    } catch (error) {
        log.error('Could not delete S3 object (orphaned file, safe to remove manually)', error, { key });
    }
};

const writeSettings = async (values) => {
    const row = await findRow();
    const previousKeys = Object.fromEntries(ASSET_KEY_FIELDS.map(field => [field, row?.[field] ?? null]));

    if (row) {
        await row.update(values);
    } else {
        log.info('Creating the gallery settings row', { fields: Object.keys(values) });
        await db.GallerySettings.create({ id: SETTINGS_ID, ...values });
    }
    log.debug('Settings saved', { fields: Object.keys(values) });

    for (const field of ASSET_KEY_FIELDS) {
        const previousKey = previousKeys[field];
        if (field in values && previousKey && previousKey !== values[field]) {
            log.info('Replacing a branding asset, deleting the previous file', { field, previousKey });
            await deleteObjectQuietly(previousKey);
        }
    }

    return getSettings();
};

export const updateSettings = async (partial) => {
    const values = await validateSettingsValues(partial);
    if (Object.keys(values).length === 0) {
        log.debug('Settings update contains nothing to change');
        return getSettings();
    }
    return writeSettings(values);
};

export const resetWatermark = async () => {
    const row = await findRow();
    if (!row) {
        log.debug('Watermark reset skipped: no settings row yet');
        return getSettings();
    }
    log.info('Resetting watermark to the original values');
    return writeSettings({
        watermarkKey: null,
        watermarkText: null,
        watermarkPosition: null,
        watermarkOpacity: null,
        watermarkSize: null
    });
};

export const resetLogo = async () => {
    const row = await findRow();
    if (!row) {
        log.debug('Logo reset skipped: no settings row yet');
        return getSettings();
    }
    log.info('Removing the logo');
    return writeSettings({ logoKey: null });
};

const getAssetKind = (kind) => {
    const config = Object.hasOwn(ASSET_KINDS, kind) ? ASSET_KINDS[kind] : null;
    if (!config) {
        log.warn('Unknown branding asset kind requested', { kind });
        throw badRequest('Type de fichier inconnu');
    }
    return config;
};

export const getUploadUrl = async (kind, contentType) => {
    const config = getAssetKind(kind);
    if (!config.contentTypes.includes(contentType)) {
        throw badRequest(config.formatError);
    }
    log.debug('Creating a branding upload url', { kind, contentType });
    return s3Repository.getSignedBrandingUploadUrl(kind, contentType);
};

export const confirmUpload = async (kind, key) => {
    const config = getAssetKind(kind);

    const rawKeyRegex = new RegExp(`^branding/${kind}/raw/${UUID_PATTERN}$`);
    if (typeof key !== 'string' || !rawKeyRegex.test(key)) {
        log.warn('Branding upload refused: invalid key', { kind });
        throw badRequest('Fichier invalide');
    }

    log.debug('Confirming branding upload', { kind, key });
    try {
        const head = await s3Repository.headObject(key);
        if (!head) {
            throw badRequest("Fichier introuvable, relancez l'envoi");
        }
        if (head.size > MAX_BRANDING_FILE_BYTES) {
            throw badRequest('Fichier trop lourd (2 Mo maximum)');
        }

        const raw = await s3Repository.getObject(key);
        log.debug('Validating uploaded image', { kind, key, bytes: raw.length });

        let metadata;
        try {
            metadata = await sharp(raw).metadata();
        } catch (cause) {
            log.warn('Uploaded branding file is not a readable image', { kind, key, reason: cause.message });
            throw badRequest('Fichier illisible');
        }
        const extension = Object.hasOwn(config.formats, metadata.format) ? config.formats[metadata.format] : null;
        if (!extension) {
            throw badRequest(config.formatError);
        }
        if (metadata.width > MAX_BRANDING_DIMENSION || metadata.height > MAX_BRANDING_DIMENSION) {
            throw badRequest(`Image trop grande (${MAX_BRANDING_DIMENSION} × ${MAX_BRANDING_DIMENSION} px maximum)`);
        }

        let reencoded;
        try {
            reencoded = await sharp(raw, { limitInputPixels: MAX_BRANDING_DIMENSION * MAX_BRANDING_DIMENSION })
                .toFormat(metadata.format)
                .toBuffer();
        } catch (cause) {
            log.warn('Uploaded branding image could not be re-encoded', { kind, key, reason: cause.message });
            throw badRequest('Fichier illisible');
        }

        const finalKey = `branding/${kind}/${randomUUID()}.${extension}`;
        await s3Repository.putObject(finalKey, reencoded, `image/${metadata.format}`);
        await s3Repository.deleteObject(key);
        log.info('Branding asset uploaded', { kind, key: finalKey, format: metadata.format, width: metadata.width, height: metadata.height, bytes: reencoded.length });
        return { key: finalKey };
    } catch (error) {
        if (error.status) {
            log.debug('Removing the rejected raw upload', { kind, key, reason: error.message });
            await deleteObjectQuietly(key);
        }
        throw error;
    }
};
