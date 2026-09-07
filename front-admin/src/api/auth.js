import { apiFetch } from './http.js'

export const login = async (email, password) => {
    const response = await apiFetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    })
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Identifiants invalides')
    }
    return response.json()
}

export const logout = async () => {
    const response = await apiFetch('/auth/logout', { method: 'POST' })
    if (!response.ok) {
        throw new Error('Échec de la déconnexion')
    }
}

export const getCurrentPhotographer = async () => {
    const response = await apiFetch('/auth/me')
    if (!response.ok) {
        return null
    }
    return response.json()
}
