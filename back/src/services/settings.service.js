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
    getOriginalWatermarkValues
} from './settings.constants.js';


const SETTINGS_ID = 1;
const WATERMARK_FIELDS = ['watermarkKey', 'watermarkPosition', 'watermarkOpacity', 'watermarkSize'];

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WATERMARK_KEY_REGEX = new RegExp(`^branding/watermark/${UUID_PATTERN}\\.png$`);

// Un seul type de fichier au lot 1. Le lot 2 ajoutera `logo` ici.
const ASSET_KINDS = {
    watermark: { contentType: 'image/png', format: 'png', formatError: 'Le fichier doit être un PNG' }
};

const createError = (status, message) => Object.assign(new Error(message), { status });
const badRequest = (message) => createError(400, message);

const isSteppedInteger = (value, min, max) =>
    Number.isInteger(value) && value >= min && value <= max && value % WATERMARK_STEP === 0;

export const validateWatermarkValues = async (values) => {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        throw badRequest('Requête invalide');
    }

    const unknownKeys = Object.keys(values).filter(key => !WATERMARK_FIELDS.includes(key));
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

    return validated;
};

const findRow = () => db.GallerySettings.findByPk(SETTINGS_ID);

export const loadSavedWatermarkValues = async () => {
    const row = await findRow();
    return {
        watermarkKey: row?.watermarkKey ?? null,
        watermarkPosition: row?.watermarkPosition ?? null,
        watermarkOpacity: row?.watermarkOpacity ?? null,
        watermarkSize: row?.watermarkSize ?? null
    };
};

// Config consommée par buildPreview. `values` suit la forme de loadSavedWatermarkValues.
export const buildWatermarkConfig = async (values) => {
    const original = getOriginalWatermarkValues();
    const image = values.watermarkKey
        ? await s3Repository.getObject(values.watermarkKey)
        : original.assetPath;

    return {
        image,
        position: values.watermarkPosition ?? original.position,
        opacity: values.watermarkOpacity != null ? values.watermarkOpacity / 100 : original.opacity,
        size: values.watermarkSize ?? null,
        margin: original.margin
    };
};

const toSettingsDTO = (row) => {
    const original = getOriginalWatermarkValues();
    return {
        watermarkKey: row?.watermarkKey ?? null,
        watermarkPosition: row?.watermarkPosition ?? original.position,
        watermarkOpacity: row?.watermarkOpacity ?? Math.round(original.opacity * 100),
        watermarkSize: row?.watermarkSize ?? null,
        updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null
    };
};

export const getSettings = async () => toSettingsDTO(await findRow());

const deleteObjectQuietly = async (key) => {
    try {
        await s3Repository.deleteObject(key);
    } catch (error) {
        console.error(`Could not delete S3 object ${key}:`, error);
    }
};

const writeSettings = async (values) => {
    const row = await findRow();
    const previousKey = row?.watermarkKey ?? null;

    if (row) {
        await row.update(values);
    } else {
        await db.GallerySettings.create({ id: SETTINGS_ID, ...values });
    }

    if ('watermarkKey' in values && previousKey && previousKey !== values.watermarkKey) {
        await deleteObjectQuietly(previousKey);
    }

    return getSettings();
};

export const updateSettings = async (partial) => {
    const values = await validateWatermarkValues(partial);
    if (Object.keys(values).length === 0) {
        return getSettings();
    }
    return writeSettings(values);
};

export const resetWatermark = async () => {
    const row = await findRow();
    if (!row) {
        return getSettings();
    }
    return writeSettings({
        watermarkKey: null,
        watermarkPosition: null,
        watermarkOpacity: null,
        watermarkSize: null
    });
};

const getAssetKind = (kind) => {
    const config = Object.hasOwn(ASSET_KINDS, kind) ? ASSET_KINDS[kind] : null;
    if (!config) {
        throw badRequest('Type de fichier inconnu');
    }
    return config;
};

export const getUploadUrl = async (kind, contentType) => {
    const config = getAssetKind(kind);
    if (contentType !== config.contentType) {
        throw badRequest(config.formatError);
    }
    return s3Repository.getSignedBrandingUploadUrl(kind, contentType);
};

export const confirmUpload = async (kind, key) => {
    const config = getAssetKind(kind);

    const rawKeyRegex = new RegExp(`^branding/${kind}/raw/${UUID_PATTERN}$`);
    if (typeof key !== 'string' || !rawKeyRegex.test(key)) {
        throw badRequest('Fichier invalide');
    }

    try {
        const head = await s3Repository.headObject(key);
        if (!head) {
            throw badRequest("Fichier introuvable, relancez l'envoi");
        }
        if (head.size > MAX_BRANDING_FILE_BYTES) {
            throw badRequest('Fichier trop lourd (2 Mo maximum)');
        }

        const raw = await s3Repository.getObject(key);

        let metadata;
        try {
            metadata = await sharp(raw).metadata();
        } catch {
            throw badRequest('Fichier illisible');
        }
        if (metadata.format !== config.format) {
            throw badRequest(config.formatError);
        }
        if (metadata.width > MAX_BRANDING_DIMENSION || metadata.height > MAX_BRANDING_DIMENSION) {
            throw badRequest(`Image trop grande (${MAX_BRANDING_DIMENSION} × ${MAX_BRANDING_DIMENSION} px maximum)`);
        }

        let reencoded;
        try {
            reencoded = await sharp(raw, { limitInputPixels: MAX_BRANDING_DIMENSION * MAX_BRANDING_DIMENSION })
                .png()
                .toBuffer();
        } catch {
            throw badRequest('Fichier illisible');
        }

        const finalKey = `branding/${kind}/${randomUUID()}.png`;
        await s3Repository.putObject(finalKey, reencoded, 'image/png');
        await s3Repository.deleteObject(key);
        return { key: finalKey };
    } catch (error) {
        if (error.status) {
            await deleteObjectQuietly(key);
        }
        throw error;
    }
};
