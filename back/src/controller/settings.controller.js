import { getSettings, updateSettings, resetWatermark, resetLogo, getUploadUrl, confirmUpload } from '../services/settings.service.js';
import { generateWatermarkSample } from '../services/image-processing.service.js';

const sendError = (res, error, fallbackMessage) => {
    if (!error.status) {
        console.error(`${fallbackMessage}:`, error);
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : fallbackMessage });
};

export const getGallerySettings = async (req, res) => {
    try {
        res.json(await getSettings());
    } catch (error) {
        sendError(res, error, 'Failed to fetch settings');
    }
};

export const updateGallerySettings = async (req, res) => {
    try {
        res.json(await updateSettings(req.body));
    } catch (error) {
        sendError(res, error, 'Failed to update settings');
    }
};

export const createAssetUploadUrl = async (req, res) => {
    try {
        const { contentType } = req.body ?? {};
        res.json(await getUploadUrl(req.params.kind, contentType));
    } catch (error) {
        sendError(res, error, 'Failed to generate upload url');
    }
};

export const confirmAssetUpload = async (req, res) => {
    try {
        const { key } = req.body ?? {};
        res.status(201).json(await confirmUpload(req.params.kind, key));
    } catch (error) {
        sendError(res, error, 'Failed to confirm upload');
    }
};

export const previewWatermark = async (req, res) => {
    try {
        const buffer = await generateWatermarkSample(req.body);
        res.set('Cache-Control', 'no-store');
        res.type('image/jpeg').send(buffer);
    } catch (error) {
        sendError(res, error, 'Failed to generate preview');
    }
};

export const resetWatermarkSettings = async (req, res) => {
    try {
        res.json(await resetWatermark());
    } catch (error) {
        sendError(res, error, 'Failed to reset watermark');
    }
};

export const resetLogoSettings = async (req, res) => {
    try {
        res.json(await resetLogo());
    } catch (error) {
        sendError(res, error, 'Failed to remove logo');
    }
};
