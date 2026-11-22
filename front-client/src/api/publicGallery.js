const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

const publicFetch = (path, options = {}) =>
    fetch(`${API_BASE_URL}${path}`, options)

export const getClientGallery = async (token) => {
    const response = await publicFetch(`/client/${token}`)
    if (!response.ok) {
        const error = new Error('Failed to load gallery')
        error.status = response.status
        throw error
    }
    return response.json()
}

export const updateClientPhotoSelection = async (token, photoId, status) => {
    const response = await publicFetch(`/client/${token}/photos/${photoId}/selection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
    })
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update photo selection')
    }
    return response.json()
}

// Asks for the "download all" ZIP. The server builds it in the background, so the answer is
// one of: { state: 'ready', url } (navigate to it), { state: 'pending', status } (being
// prepared, ask again later) or { state: 'failed' }. No file goes through this request.
export const downloadAllDeliveredPhotos = async (token) => {
    const response = await publicFetch(`/client/${token}/download-all`)
    const data = await response.json().catch(() => ({}))
    if (response.status === 200 && data.url) {
        return { state: 'ready', url: data.url }
    }
    if (response.status === 202) {
        return { state: 'pending', status: data.status }
    }
    if (response.status === 409 && data.status === 'FAILED') {
        return { state: 'failed' }
    }
    const error = new Error(data.error || 'Impossible de préparer le téléchargement. Réessayez plus tard.')
    error.status = response.status
    throw error
}

// Light status of the ZIP, for the polling (the gallery itself is far too heavy to reload).
// Resolves to { status, sizeBytes, photoCount }, or null when there is nothing to download.
export const getClientArchiveStatus = async (token) => {
    const response = await publicFetch(`/client/${token}/archive`)
    if (!response.ok) {
        const error = new Error('Failed to read the archive status')
        error.status = response.status
        throw error
    }
    const data = await response.json()
    return data.archive ?? null
}

export const validateClientSelection = async (token) => {
    const response = await publicFetch(`/client/${token}/validate`, {
        method: 'POST'
    })
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to validate selection')
    }
    return response.json()
}
