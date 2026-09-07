import { useMemo, useState } from 'react'
import { groupFilesForUpload } from '../utils/photoGrouping.js'

const describeGroup = (group) => {
    const parts = []
    if (group.mainFile) {
        parts.push(group.mainFile.name)
    } else if (group.existingPhoto) {
        parts.push(`photo existante : ${group.existingPhoto.originalFilename}`)
    }
    parts.push(...group.attachmentFiles.map((file) => file.name))
    return parts.join(' + ')
}

export default function PhotoUploadForm({ onUpload, onCancel, existingPhotos = [] }) {
    const [pendingFiles, setPendingFiles] = useState([])
    const [deselectedStems, setDeselectedStems] = useState(new Set())
    const [description, setDescription] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [progress, setProgress] = useState(null)
    const [error, setError] = useState(null)

    const groups = useMemo(() => groupFilesForUpload(pendingFiles, existingPhotos), [pendingFiles, existingPhotos])
    const selectedGroups = groups.filter((group) => group.uploadable && !deselectedStems.has(group.stem))

    const handleFilesSelected = (event) => {
        setPendingFiles(Array.from(event.target.files))
        setDeselectedStems(new Set())
    }

    const toggleGroup = (stem) => {
        setDeselectedStems((current) => {
            const next = new Set(current)
            if (next.has(stem)) {
                next.delete(stem)
            } else {
                next.add(stem)
            }
            return next
        })
    }

    const handleSubmit = async (event) => {
        event.preventDefault()
        if (!selectedGroups.length) return

        setSubmitting(true)
        setError(null)
        setProgress({ done: 0, total: 1 })
        try {
            await onUpload(
                { groups: selectedGroups, description: description.trim() || null },
                (done, total) => setProgress({ done, total })
            )
        } catch (uploadError) {
            setError(uploadError.message || "Impossible d'ajouter les photos")
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <form className="collection-form" onSubmit={handleSubmit}>
            <input
                type="file"
                multiple
                onChange={handleFilesSelected}
                required
            />
            {groups.length > 0 && (
                <div className="upload-group-preview">
                    <p className="upload-file-count">
                        {groups.length} groupe{groups.length > 1 ? 's' : ''} détecté{groups.length > 1 ? 's' : ''},{' '}
                        {selectedGroups.length} sera{selectedGroups.length > 1 ? 'nt' : ''} envoyé{selectedGroups.length > 1 ? 's' : ''}
                    </p>
                    <ul className="upload-group-list">
                        {groups.map((group) => (
                            <li
                                key={group.stem}
                                className={`upload-group-item${group.isOrphanAttachment ? ' upload-group-anomaly' : ''}`}
                            >
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={group.uploadable && !deselectedStems.has(group.stem)}
                                        disabled={!group.uploadable}
                                        onChange={() => toggleGroup(group.stem)}
                                    />
                                    <span>{describeGroup(group)}</span>
                                </label>
                                {group.isOrphanAttachment && (
                                    <span className="upload-group-warning">
                                        aucun JPEG ni photo existante correspondante — non envoyé
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <textarea
                placeholder="Description (optionnel, appliquée à toutes les photos)"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
            />
            {submitting && progress && (
                <div className="upload-progress">
                    <div className="upload-progress-bar">
                        <div
                            className="upload-progress-fill"
                            style={{ width: `${(progress.done / progress.total) * 100}%` }}
                        />
                    </div>
                    <span>{progress.done} / {progress.total}</span>
                </div>
            )}
            {error && <p className="form-error">{error}</p>}
            <div className="collection-form-actions">
                <button type="button" className="back-button" onClick={onCancel} disabled={submitting}>
                    Annuler
                </button>
                <button type="submit" className="create-button" disabled={submitting || !selectedGroups.length}>
                    {submitting ? 'Envoi...' : 'Ajouter'}
                </button>
            </div>
        </form>
    )
}
