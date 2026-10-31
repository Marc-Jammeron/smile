import express from 'express';
import { getGallerySettings, updateGallerySettings, createAssetUploadUrl, confirmAssetUpload, previewWatermark, resetWatermarkSettings, resetLogoSettings } from '../controller/settings.controller.js';

export const settingsRouter = express.Router();

settingsRouter.get('/', getGallerySettings);
settingsRouter.put('/', updateGallerySettings);
settingsRouter.post('/assets/:kind/upload-url', createAssetUploadUrl);
settingsRouter.post('/assets/:kind/confirm', confirmAssetUpload);
settingsRouter.post('/watermark/preview', previewWatermark);
settingsRouter.delete('/watermark', resetWatermarkSettings);
settingsRouter.delete('/logo', resetLogoSettings);
