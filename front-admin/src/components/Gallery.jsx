import CollectionList from './CollectionList.jsx'
import PhotoList from './PhotoList.jsx'
import { useState, useEffect, useRef } from 'react'
import { runUpload } from '../utils/uploadPipeline.js'
import { apiFetch } from '../api/http.js'
import { presignFiles, putToStorage, confirmBatch, fetchCollectionPhotos } from '../api/photoUpload.js'

const uploadApi = {
    presign: presignFiles,
    put: putToStorage,
    confirm: confirmBatch,
    fetchPhotos: fetchCollectionPhotos,
}

export default function Gallery() {
    const [collections, setCollections] = useState([])
    const [photos, setPhotos] = useState([])
    const [selectedCollection, setSelectedCollection] = useState(null)
    const [loadingPhotos, setLoadingPhotos] = useState(false)
    const [uploading, setUploading] = useState(false)
    const selectedCollectionIdRef = useRef(null)

    useEffect(() => {
        selectedCollectionIdRef.current = selectedCollection?.id ?? null
    }, [selectedCollection])

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
    // The whole flow (reload, dedup, presign by batch, PUT, confirm by chunks, retries)
    // lives in utils/uploadPipeline.js; this handler only bridges it to React state and
    // returns the report (sent / skipped / failed / groups to retry) to the form.
    const handleAddPhotos = async ({ groups, description, targetStatus = 'PENDING' }, onProgress, signal) => {
        const collectionId = selectedCollection.id
        // Back/delete are disabled while uploading, but never write photos of one
        // collection into the list of another.
        const isStillSelected = () => selectedCollectionIdRef.current === collectionId

        setUploading(true)
        try {
            return await runUpload({
                collectionId,
                groups,
                targetStatus,
                description,
                api: uploadApi,
                signal,
                onProgress,
                onPhotosReloaded: (fresh) => {
                    if (isStillSelected()) setPhotos(fresh)
                },
                onPhotosCreated: (created) => {
                    if (isStillSelected()) setPhotos(current => [...current, ...created])
                },
            })
        } finally {
            setUploading(false)
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
                    uploading={uploading}
                    onBack={() => setSelectedCollection(null)}
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
