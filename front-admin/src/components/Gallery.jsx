import CollectionList from './CollectionList.jsx'
import PhotoList from './PhotoList.jsx'
import { useState, useEffect, useRef } from 'react'
import { runWithConcurrency } from '../utils/concurrency.js'
import { planListReload } from '../utils/processingPoll.js'
import { sortGroupsForUpload } from '../utils/photoGrouping.js'
import { apiFetch } from '../api/http.js'

const UPLOAD_CONCURRENCY = 4
const CONFIRM_CHUNK_SIZE = 20
const PROCESSING_POLL_INTERVAL_MS = 3000


export default function Gallery() {
    const [collections, setCollections] = useState([])
    const [photos, setPhotos] = useState([])
    const [selectedCollection, setSelectedCollection] = useState(null)
    const [loadingPhotos, setLoadingPhotos] = useState(false)
    // Counters of the background image processing of the selected collection (null until
    // the first poll answers). `pollNonce` restarts the polling after an action that
    // queues work (upload, retry, deferred send).
    const [processing, setProcessing] = useState(null)
    const [pollNonce, setPollNonce] = useState(0)
    const selectedCollectionRef = useRef(null)
    selectedCollectionRef.current = selectedCollection
    // Polling bookkeeping (see utils/processingPoll.js): last done/failed counters seen, whether
    // a change is waiting for a list reload, and when the list was last loaded.
    const lastCountsRef = useRef(null)
    const listDirtyRef = useRef(false)
    const lastListLoadAtRef = useRef(0)
    const selectedCollectionId = selectedCollection?.id ?? null

    const replaceCollection = (updatedCollection) => {
        setCollections(current => current.map(collection =>
            collection.id === updatedCollection.id ? updatedCollection : collection
        ))
        setSelectedCollection(current =>
            current && current.id === updatedCollection.id ? updatedCollection : current
        )
    }

    const fetchPhotos = async (collectionId) => {
        const response = await apiFetch(`/photos/collection/${collectionId}`)
        return response.json()
    }

    useEffect(() => {
        apiFetch('/collections')
            .then(response => response.json())
            .then(data => setCollections(data))
            .catch(error => console.error('Error fetching collections:', error))
    }, [])

    const handleCreateCollection = async (data) => {
        const response = await apiFetch('/collections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        if (!response.ok) {
            throw new Error('Failed to create collection')
        }
        const newCollection = await response.json()
        setCollections(current => [...current, newCollection])
    }

    const handleChangeCollectionStatus = async (collectionId, status) => {
        const response = await apiFetch(`/collections/${collectionId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        })
        if (!response.ok) {
            throw new Error('Failed to update collection status')
        }
        const body = await response.json()
        // 202: the link was requested while photos are still being processed. The
        // collection stays a DRAFT and the server sends the link by itself afterwards.
        if (response.status === 202) {
            setCollections(current => current.map(collection =>
                collection.id === collectionId ? body.collection : collection
            ))
            return { deferred: true, message: body.message }
        }
        setCollections(current => current.map(collection =>
            collection.id === collectionId ? body : collection
        ))
        return { deferred: false }
    }

    const handleBack = () => {
        setSelectedCollection(null)
        // The board is not polled: refresh it, a pending link may have been sent meanwhile.
        apiFetch('/collections')
            .then(response => response.json())
            .then(data => setCollections(data))
            .catch(error => console.error('Error fetching collections:', error))
    }

    const handleCancelSendRequest = async (collectionId) => {
        const response = await apiFetch(`/collections/${collectionId}/send-request`, { method: 'DELETE' })
        if (!response.ok) {
            throw new Error("Failed to cancel the link request")
        }
        const updatedCollection = await response.json()
        replaceCollection({ ...updatedCollection, Photos: selectedCollectionRef.current?.Photos })
    }

    const handleRetryPhoto = async (photoId) => {
        const response = await apiFetch(`/photos/${photoId}/retry`, { method: 'POST' })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to retry the photo')
        }
        setPhotos(current => current.map(photo =>
            photo.id === photoId ? { ...photo, processingStatus: 'QUEUED', processingAttempts: 0 } : photo
        ))
        setPollNonce(nonce => nonce + 1)
    }

    const handleUpdateMessage = async (collectionId, field, message) => {
        const response = await apiFetch(`/collections/${collectionId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: message })
        })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to update message')
        }
        const updatedCollection = await response.json()
        setCollections(current => current.map(collection =>
            collection.id === collectionId ? updatedCollection : collection
        ))
        setSelectedCollection(current =>
            current && current.id === collectionId ? updatedCollection : current
        )
    }

    useEffect(() => {
        if (!selectedCollectionId) {
            setPhotos([])
            return
        }

        let cancelled = false
        setLoadingPhotos(true)
        fetchPhotos(selectedCollectionId)
            .then(data => {
                if (cancelled) return
                setPhotos(data)
                listDirtyRef.current = false
                lastListLoadAtRef.current = Date.now()
            })
            .catch(error => console.error('Error fetching photos:', error))
            .finally(() => { if (!cancelled) setLoadingPhotos(false) })
        return () => { cancelled = true }
    }, [selectedCollectionId])

    // Polls the background processing every few seconds while photos are queued or being
    // processed, or while a link request waits for them; stops by itself afterwards.
    // A tick only calls processing-status. The photo list (heavy) is reloaded only when the
    // done or failed counter moved, at most every LIST_RELOAD_MIN_INTERVAL_MS, plus once
    // more when the queue is empty.
    useEffect(() => {
        if (!selectedCollectionId) {
            setProcessing(null)
            lastCountsRef.current = null
            return
        }

        let cancelled = false
        let timer = null
        let keepPolling = false

        const tick = async () => {
            try {
                const response = await apiFetch(`/collections/${selectedCollectionId}/processing-status`)
                if (!response.ok) {
                    throw new Error('Failed to fetch the processing status')
                }
                const status = await response.json()
                if (cancelled) return
                setProcessing(status)

                // Thumbnails and failures only show up in the photo list.
                const plan = planListReload(status, {
                    lastKey: lastCountsRef.current,
                    dirty: listDirtyRef.current,
                    lastReloadAt: lastListLoadAtRef.current
                }, Date.now())
                lastCountsRef.current = plan.key
                listDirtyRef.current = plan.dirty
                if (plan.reload) {
                    const freshPhotos = await fetchPhotos(selectedCollectionId)
                    if (cancelled) return
                    setPhotos(freshPhotos)
                    listDirtyRef.current = false
                    lastListLoadAtRef.current = Date.now()
                }

                // The server may have sent the link (status change, access token) or the request was dropped.
                const known = selectedCollectionRef.current
                if (known?.id === selectedCollectionId) {
                    if (known.status !== status.status) {
                        const collectionResponse = await apiFetch(`/collections/${selectedCollectionId}`)
                        if (collectionResponse.ok) {
                            const freshCollection = await collectionResponse.json()
                            if (cancelled) return
                            replaceCollection(freshCollection)
                        }
                    } else if ((known.sendRequestedAt ?? null) !== (status.sendRequestedAt ?? null)) {
                        replaceCollection({ ...known, sendRequestedAt: status.sendRequestedAt })
                    }
                }

                keepPolling = status.queued + status.processing > 0 || Boolean(status.sendRequestedAt)
                if (keepPolling) {
                    timer = setTimeout(tick, PROCESSING_POLL_INTERVAL_MS)
                }
            } catch (error) {
                console.error('Error polling the processing status:', error)
                // A transient failure must not leave the placeholders stuck: keep trying, but
                // only if the polling was already running.
                if (!cancelled && keepPolling) {
                    timer = setTimeout(tick, PROCESSING_POLL_INTERVAL_MS)
                }
            }
        }

        tick()
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [selectedCollectionId, pollNonce])

    // `groups` come from groupFilesForUpload (client-side basename grouping): each
    // group is either a new main photo (+ its CR2/XMP attachments) or an
    // attachment-only group matched against an already-loaded existing Photo.
    const handleAddPhotos = async ({ groups: unsortedGroups, description, targetStatus = 'PENDING' }, onProgress) => {
        if (!unsortedGroups.length) return

        // The backend derives Photos.position from the order of `photos` in each
        // confirm request, and chunks are sent sequentially: sorting once here keeps
        // the filename order across the whole upload, chunk boundaries included.
        const groups = sortGroupsForUpload(unsortedGroups)

        // Every raw file across every group is presigned and uploaded in one flat
        // pass; `type` tells the backend which S3 prefix to use (uploads/ vs
        // attachments/), and groupIndex/role let us reassemble groups afterwards.
        const fileEntries = []
        groups.forEach((group, groupIndex) => {
            if (group.mainFile) {
                fileEntries.push({ file: group.mainFile, type: 'photo', groupIndex, role: 'main' })
            }
            group.attachmentFiles.forEach((file) => {
                fileEntries.push({ file, type: 'attachment', groupIndex, role: 'attachment' })
            })
        })
        if (!fileEntries.length) return

        const batchResponse = await apiFetch('/photos/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                collectionId: selectedCollection.id,
                files: fileEntries.map(({ file, type }) => ({ filename: file.name, contentType: file.type, type })),
                targetStatus
            })
        })
        if (!batchResponse.ok) {
            const data = await batchResponse.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to get upload urls')
        }
        const uploadTargets = await batchResponse.json()

        let uploaded = 0
        onProgress?.(uploaded, fileEntries.length)

        const uploadResults = await runWithConcurrency(fileEntries, UPLOAD_CONCURRENCY, async (entry, index) => {
            const { url, key } = uploadTargets[index]
            const putResponse = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': entry.file.type },
                body: entry.file
            })
            if (!putResponse.ok) {
                throw new Error(`Failed to upload ${entry.file.name}`)
            }
            uploaded += 1
            onProgress?.(uploaded, fileEntries.length)
            return { ...entry, key, contentType: entry.file.type, size: entry.file.size, filename: entry.file.name }
        })

        const uploadFailures = uploadResults.filter(result => result.status !== 'fulfilled').length

        const succeededByGroup = new Map()
        uploadResults.forEach((result) => {
            if (result.status !== 'fulfilled') return
            const entry = result.value
            if (!succeededByGroup.has(entry.groupIndex)) {
                succeededByGroup.set(entry.groupIndex, { main: null, attachments: [] })
            }
            const bucket = succeededByGroup.get(entry.groupIndex)
            if (entry.role === 'main') {
                bucket.main = entry
            } else {
                bucket.attachments.push(entry)
            }
        })

        const toAttachmentPayload = ({ key, contentType, size, filename }) => ({ key, contentType, size, filename })

        // A group whose main file failed to upload is dropped entirely (its
        // attachments have nothing to attach to); an attachment-only group still
        // confirms whatever of its attachments did upload.
        const photosToConfirm = []
        const attachmentsToExistingPhotos = []
        groups.forEach((group, groupIndex) => {
            const succeeded = succeededByGroup.get(groupIndex)
            if (!succeeded) return
            if (group.mainFile) {
                if (!succeeded.main) return
                photosToConfirm.push({
                    collectionId: selectedCollection.id,
                    key: succeeded.main.key,
                    contentType: succeeded.main.contentType,
                    size: succeeded.main.size,
                    filename: succeeded.main.filename,
                    description,
                    attachments: succeeded.attachments.map(toAttachmentPayload)
                })
            } else if (group.existingPhoto && succeeded.attachments.length > 0) {
                attachmentsToExistingPhotos.push({
                    photoId: group.existingPhoto.id,
                    attachments: succeeded.attachments.map(toAttachmentPayload)
                })
            }
        })

        // La confirmation déclenche un traitement lourd (génération thumbnail/preview)
        // côté backend : on découpe en chunks plutôt que d'envoyer tout le batch d'un
        // coup, et le progress continue de s'incrémenter pendant cette phase.
        const confirmSteps = photosToConfirm.length + (attachmentsToExistingPhotos.length > 0 ? 1 : 0)
        const overallTotal = fileEntries.length + Math.max(confirmSteps, 1)
        onProgress?.(fileEntries.length, overallTotal)

        const created = []
        let confirmFailures = 0
        let confirmed = 0

        for (let i = 0; i < photosToConfirm.length; i += CONFIRM_CHUNK_SIZE) {
            const chunk = photosToConfirm.slice(i, i + CONFIRM_CHUNK_SIZE)
            const confirmResponse = await apiFetch('/photos/confirm/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetStatus, photos: chunk })
            })
            if (!confirmResponse.ok) {
                const data = await confirmResponse.json().catch(() => ({}))
                throw new Error(data.error || 'Failed to confirm photos')
            }
            const { created: chunkCreated, failed: chunkFailed, failedAttachments: chunkFailedAttachments } = await confirmResponse.json()
            created.push(...chunkCreated)
            confirmFailures += chunkFailed.length + (chunkFailedAttachments?.length || 0)
            // The polling may already have reloaded these photos: never add them twice.
            setPhotos(current => {
                const knownIds = new Set(current.map(photo => photo.id))
                return [...current, ...chunkCreated.filter(photo => !knownIds.has(photo.id))]
            })
            // The new photos are processed in the background: (re)start the polling.
            setPollNonce(nonce => nonce + 1)

            confirmed += chunk.length
            onProgress?.(fileEntries.length + confirmed, overallTotal)
        }

        if (attachmentsToExistingPhotos.length > 0) {
            const confirmResponse = await apiFetch('/photos/confirm/batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetStatus, photos: [], attachmentsToExistingPhotos })
            })
            if (!confirmResponse.ok) {
                const data = await confirmResponse.json().catch(() => ({}))
                throw new Error(data.error || 'Failed to confirm attachments')
            }
            const { failedAttachments } = await confirmResponse.json()
            confirmFailures += failedAttachments?.length || 0
            confirmed += 1
            onProgress?.(fileEntries.length + confirmed, overallTotal)
        }

        const totalFailures = uploadFailures + confirmFailures
        if (totalFailures > 0) {
            throw new Error(`${totalFailures} fichier(s) sur ${fileEntries.length} n'ont pas pu être ajoutés`)
        }
    }

    const handleDeletePhoto = async (photoId) => {
        const response = await apiFetch(`/photos/${photoId}`, {
            method: 'DELETE'
        })
        if (!response.ok) {
            throw new Error('Failed to delete photo')
        }
        setPhotos(current => current.filter(photo => photo.id !== photoId))
    }

    const handleDeleteDeliveredPhoto = async (photoId) => {
        const response = await apiFetch(`/photos/delivered/${photoId}`, {
            method: 'DELETE'
        })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to delete delivered photo')
        }
        setPhotos(current => current.filter(photo => photo.id !== photoId))
    }

    const handleMarkReady = async (collectionId) => {
        const response = await apiFetch(`/collections/${collectionId}/mark-ready`, {
            method: 'PATCH'
        })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to mark collection as ready')
        }
        const updatedCollection = await response.json()
        setCollections(current => current.map(collection =>
            collection.id === collectionId ? updatedCollection : collection
        ))
        setSelectedCollection(current =>
            current && current.id === collectionId ? updatedCollection : current
        )
        // Le passage en READY supprime côté serveur toutes les photos non DELIVERED :
        // on reflète ça localement plutôt que de refaire un aller-retour réseau.
        setPhotos(current => current.filter(photo => photo.status === 'DELIVERED'))
    }

    const handleDeleteCollection = async (collectionId) => {
        const response = await apiFetch(`/collections/${collectionId}`, {
            method: 'DELETE'
        })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to delete collection')
        }
        setCollections(current => current.filter(collection => collection.id !== collectionId))
        setSelectedCollection(null)
    }

    const handleRevokeAccess = async (collectionId) => {
        const response = await apiFetch(`/collections/${collectionId}/revoke-access`, {
            method: 'POST'
        })
        if (!response.ok) {
            throw new Error('Failed to revoke access')
        }
        const revokedAt = new Date().toISOString()
        setCollections(current => current.map(collection =>
            collection.id === collectionId ? { ...collection, accessTokenRevokedAt: revokedAt } : collection
        ))
        setSelectedCollection(current =>
            current && current.id === collectionId ? { ...current, accessTokenRevokedAt: revokedAt } : current
        )
    }

    const handleUpdatePhotoStatus = async (photoId, status) => {
        const response = await apiFetch(`/photos/${photoId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        })
        if (!response.ok) {
            const data = await response.json().catch(() => ({}))
            throw new Error(data.error || 'Failed to update photo status')
        }
        setPhotos(current => current.map(photo =>
            photo.id === photoId ? { ...photo, status } : photo
        ))
    }

    return (
        <div className="gallery">
            <h1>Gallery</h1>
            {selectedCollection ? (
                <PhotoList
                    collection={selectedCollection}
                    photos={photos}
                    loading={loadingPhotos}
                    processing={processing}
                    onBack={handleBack}
                    onRetryPhoto={handleRetryPhoto}
                    onCancelSendRequest={handleCancelSendRequest}
                    onAddPhotos={handleAddPhotos}
                    onDeletePhoto={handleDeletePhoto}
                    onDeleteDeliveredPhoto={handleDeleteDeliveredPhoto}
                    onUpdatePhotoStatus={handleUpdatePhotoStatus}
                    onRevokeAccess={handleRevokeAccess}
                    onUpdateMessage={handleUpdateMessage}
                    onMarkReady={handleMarkReady}
                    onDeleteCollection={handleDeleteCollection}
                />
            ) : (
                <CollectionList
                    collections={collections}
                    onSelectCollection={setSelectedCollection}
                    onCreateCollection={handleCreateCollection}
                    onChangeCollectionStatus={handleChangeCollectionStatus}
                />
            )}
        </div>
    )
}
