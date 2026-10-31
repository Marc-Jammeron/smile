import { apiFetch } from './http.js'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const readError = async (response, fallback) => {
    const data = await response.json().catch(() => ({}))
    return new Error(data.error || fallback)
}

const requestJson = async (path, options, fallback) => {
    const response = await apiFetch(path, options)
    if (!response.ok) {
        throw await readError(response, fallback)
    }
    return response.json()
}

const postJson = (path, body, fallback) =>
    requestJson(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }, fallback)

export const getSettings = () =>
    requestJson('/settings', {}, 'Impossible de charger les réglages')

export const updateSettings = (values) =>
    requestJson('/settings', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(values) }, "Impossible d'enregistrer les réglages")

export const requestUploadUrl = (kind, contentType) =>
    postJson(`/settings/assets/${kind}/upload-url`, { contentType }, "Impossible de préparer l'envoi du fichier")

export const confirmUpload = (kind, key) =>
    postJson(`/settings/assets/${kind}/confirm`, { key }, 'Fichier refusé')

// Envoie le fichier à l'URL présignée, puis le fait valider par le back. Renvoie la clé finale.
export const uploadAsset = async (kind, file) => {
    const { url, key } = await requestUploadUrl(kind, file.type)
    const putResponse = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file
    })
    if (!putResponse.ok) {
        throw new Error("Échec de l'envoi du fichier")
    }
    const confirmed = await confirmUpload(kind, key)
    return confirmed.key
}

// Renvoie le JPEG de l'aperçu sous forme de Blob.
export const previewWatermark = async (values, signal) => {
    const response = await apiFetch('/settings/watermark/preview', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(values),
        signal
    })
    if (!response.ok) {
        throw await readError(response, "Impossible de générer l'aperçu")
    }
    return response.blob()
}

export const resetWatermark = () =>
    requestJson('/settings/watermark', { method: 'DELETE' }, 'Impossible de revenir au watermark par défaut')

export const deleteLogo = () =>
    requestJson('/settings/logo', { method: 'DELETE' }, 'Impossible de retirer le logo')
