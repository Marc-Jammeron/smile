import { apiFetch } from './http.js'
import { StepError, classifyHttpStatus } from '../utils/uploadErrors.js'

const PRESIGN_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 30_000

const CONFIRM_TIMEOUT_MS = 180_000
const PUT_IDLE_TIMEOUT_MS = 60_000

async function requestJson(path, { method = 'GET', body, timeoutMs }) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, timeoutMs)

    try {
        let response
        try {
            response = await apiFetch(path, {
                method,
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            })
        } catch (error) {
            throw timedOut
                ? new StepError('Request timed out', { kind: 'timeout', retryable: true, cause: error })
                : new StepError('Network error', { kind: 'network', retryable: true, cause: error })
        }

        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new StepError(data.error || `HTTP ${response.status}`, {
                ...classifyHttpStatus(response.status),
                status: response.status,
                serverMessage: data.error ?? null,
            })
        }

        try {
            return await response.json()
        } catch (error) {
            throw new StepError('Unreadable response', { kind: 'server', status: response.status, retryable: true, cause: error })
        }
    } finally {
        clearTimeout(timer)
    }
}

export async function presignFiles({ collectionId, targetStatus, files }) {
    const targets = await requestJson('/photos/batch', {
        method: 'POST',
        body: { collectionId, files, targetStatus },
        timeoutMs: PRESIGN_TIMEOUT_MS,
    })
    if (!Array.isArray(targets) || targets.length !== files.length) {
        throw new StepError('Unexpected presign response', { kind: 'server', retryable: true })
    }
    return targets
}

export function confirmBatch({ targetStatus, photos, attachmentsToExistingPhotos }) {
    return requestJson('/photos/confirm/batch', {
        method: 'POST',
        body: { targetStatus, photos, attachmentsToExistingPhotos },
        timeoutMs: CONFIRM_TIMEOUT_MS,
    })
}

export function fetchCollectionPhotos(collectionId) {
    return requestJson(`/photos/collection/${collectionId}`, { timeoutMs: LIST_TIMEOUT_MS })
}

export function putToStorage({ url, file, contentType, onProgress, idleTimeoutMs = PUT_IDLE_TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        let idleTimer = null
        let timedOut = false

        const armIdleTimer = () => {
            clearTimeout(idleTimer)
            idleTimer = setTimeout(() => {
                timedOut = true
                xhr.abort()
            }, idleTimeoutMs)
        }
        const settle = (callback) => {
            clearTimeout(idleTimer)
            callback()
        }

        xhr.open('PUT', url)
        xhr.setRequestHeader('Content-Type', contentType)
        xhr.upload.onprogress = (event) => {
            armIdleTimer()
            onProgress?.(event.loaded, event.total)
        }
        xhr.onload = () => settle(() => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve()
            } else if (xhr.status === 403) {
                reject(new StepError('Storage refused the upload (403)', { kind: 'expired', status: 403, retryable: false }))
            } else {
                reject(new StepError(`Storage responded ${xhr.status}`, { ...classifyHttpStatus(xhr.status), status: xhr.status }))
            }
        })
        xhr.onerror = () => settle(() => reject(new StepError('Network error during upload', { kind: 'network', retryable: true })))
        xhr.onabort = () => settle(() => reject(
            timedOut
                ? new StepError('Upload stalled', { kind: 'timeout', retryable: true })
                : new StepError('Upload aborted', { kind: 'aborted', retryable: false })
        ))

        armIdleTimer()
        xhr.send(file)
    })
}
