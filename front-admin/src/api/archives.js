import { apiFetch } from './http.js'

const failure = async (response, fallback) => {
    const data = await response.json().catch(() => ({}))
    const error = new Error(data.error || fallback)
    error.status = response.status
    return error
}

// Status of both pre-generated ZIPs of a collection: { SELECTION_HD, DELIVERED }, each one
// { kind, status, sizeBytes, photoCount, error } or null when it does not exist.
export const getCollectionArchives = async (collectionId) => {
    const response = await apiFetch(`/collections/${collectionId}/archives`)
    if (!response.ok) throw await failure(response, 'Impossible de lire l’état des ZIP')
    return response.json()
}

// Asks for the retouching ZIP. The server builds it in the background: the answer is
// { state: 'ready', url } (navigate to it), { state: 'pending', status } or { state: 'failed' }.
export const requestSelectionHdDownload = async (collectionId) => {
    const response = await apiFetch(`/collections/${collectionId}/download-selection-hd`)
    const data = await response.json().catch(() => ({}))
    if (response.status === 200 && data.url) return { state: 'ready', url: data.url }
    if (response.status === 202) return { state: 'pending', status: data.status }
    if (response.status === 409 && data.status === 'FAILED') return { state: 'failed' }
    const error = new Error(data.error || 'Le téléchargement de la sélection HD a échoué')
    error.status = response.status
    throw error
}

export const retryArchive = async (collectionId, kind) => {
    const response = await apiFetch(`/collections/${collectionId}/archives/${kind}/retry`, { method: 'POST' })
    if (!response.ok) throw await failure(response, 'Impossible de relancer le ZIP')
    return response.json()
}
