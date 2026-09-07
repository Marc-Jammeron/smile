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

export const downloadAllDeliveredPhotos = async (token) => {
    const response = await publicFetch(`/client/${token}/download-all`)
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        const error = new Error(data.error || 'Failed to download all photos')
        error.status = response.status
        throw error
    }
    return response
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
