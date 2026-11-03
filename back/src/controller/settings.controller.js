import { getSettings, updateSettings, resetWatermark, resetLogo, getUploadUrl, confirmUpload } from '../services/settings.service.js';
import { generateWatermarkSample } from '../services/image-processing.service.js';
import logger from '../logger.js';

const log = logger.child('settings.controller');

const sendError = (res, error, fallbackMessage) => {
    log.failure(fallbackMessage, error);
    res.status(error.status || 500).json({ error: error.status ? error.message : fallbackMessage });
};

export const getGallerySettings = async (req, res) => {
    try {
        const settings = await getSettings();
        log.debug('Settings fetched');
        res.json(settings);
    } catch (error) {
        sendError(res, error, 'Failed to fetch settings');
    }
};

export const updateGallerySettings = async (req, res) => {
    try {
        const settings = await updateSettings(req.body);
        log.info('Settings updated', { fields: Object.keys(req.body ?? {}) });
        res.json(settings);
    } catch (error) {
        sendError(res, error, 'Failed to update settings');
    }
};

export const createAssetUploadUrl = async (req, res) => {
    try {
        const { contentType } = req.body ?? {};
        const upload = await getUploadUrl(req.params.kind, contentType);
        log.info('Branding upload url generated', { kind: req.params.kind, contentType });
        res.json(upload);
    } catch (error) {
        sendError(res, error, 'Failed to generate upload url');
    }
};

export const confirmAssetUpload = async (req, res) => {
    try {
        const { key } = req.body ?? {};
        const confirmed = await confirmUpload(req.params.kind, key);
        log.info('Branding asset upload confirmed', { kind: req.params.kind, key: confirmed.key });
        res.status(201).json(confirmed);
    } catch (error) {
        sendError(res, error, 'Failed to confirm upload');
    }
};

export const previewWatermark = async (req, res) => {
    try {
        const buffer = await generateWatermarkSample(req.body);
        log.debug('Watermark preview generated', { bytes: buffer.length });
        res.set('Cache-Control', 'no-store');
        res.type('image/jpeg').send(buffer);
    } catch (error) {
        sendError(res, error, 'Failed to generate preview');
    }
};

export const resetWatermarkSettings = async (req, res) => {
    try {
        const settings = await resetWatermark();
        log.info('Watermark settings reset');
        res.json(settings);
    } catch (error) {
        sendError(res, error, 'Failed to reset watermark');
    }
};

export const resetLogoSettings = async (req, res) => {
    try {
        const settings = await resetLogo();
        log.info('Logo removed');
        res.json(settings);
    } catch (error) {
        sendError(res, error, 'Failed to remove logo');
    }
};
