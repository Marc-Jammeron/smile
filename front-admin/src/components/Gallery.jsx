import CollectionList from './CollectionList.jsx'
import PhotoList from './PhotoList.jsx'
import { useState, useEffect } from 'react'
import { runWithConcurrency } from '../utils/concurrency.js'
import { apiFetch } from '../api/http.js'

const UPLOAD_CONCURRENCY = 4
const CONFIRM_CHUNK_SIZE = 20


export default function Gallery() {
    const [collections, setCollections] = useState([])
    const [photos, setPhotos] = useState([])
    const [selectedCollection, setSelectedCollection] = useState(null)
    const [loadingPhotos, setLoadingPhotos] = useState(false)

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
        const updatedCollection = await response.json()
        setCollections(current => current.map(collection =>
            collection.id === collectionId ? updatedCollection : collection
        ))
    }

    useEffect(() => {
        if (!selectedCollection) {
            setPhotos([])
            return
        }

        setLoadingPhotos(true)
        apiFetch(`/photos/collection/${selectedCollection.id}`)
            .then(response => response.json())
            .then(data => setPhotos(data))
            .catch(error => console.error('Error fetching photos:', error))
            .finally(() => setLoadingPhotos(false))
    }, [selectedCollection])

    // `groups` come from groupFilesForUpload (client-side basename grouping): each
    // group is either a new main photo (+ its CR2/XMP attachments) or an
    // attachment-only group matched against an already-loaded existing Photo.
    const handleAddPhotos = async ({ groups, description, targetStatus = 'PENDING' }, onProgress) => {
        if (!groups.length) return

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
            setPhotos(current => [...current, ...chunkCreated])

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
                    onBack={() => setSelectedCollection(null)}
                    onAddPhotos={handleAddPhotos}
                    onDeletePhoto={handleDeletePhoto}
                    onDeleteDeliveredPhoto={handleDeleteDeliveredPhoto}
                    onUpdatePhotoStatus={handleUpdatePhotoStatus}
                    onRevokeAccess={handleRevokeAccess}
                    onMarkReady={handleMarkReady}
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
