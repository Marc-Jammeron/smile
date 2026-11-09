import { useEffect, useMemo, useRef, useState } from 'react'
import { groupFilesForUpload } from '../utils/photoGrouping.js'
import { formatBytes, isCleanReport, summarizeReport, listNames } from '../utils/uploadMessages.js'

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

const PHASE_LABELS = {
    preparing: 'Vérification des photos déjà présentes…',
    presigning: 'Préparation de l\'envoi',
    uploading: 'Envoi',
    confirming: 'Enregistrement',
    done: 'Terminé',
}

const describeProgress = (progress) => {
    if (!progress) return ''
    const label = PHASE_LABELS[progress.phase] ?? ''
    if (progress.phase === 'preparing' || progress.phase === 'done' || !progress.batchCount) return label
    return `${label} — groupe ${progress.batchIndex}/${progress.batchCount} · ${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`
}

export default function PhotoUploadForm({ onUpload, onCancel, existingPhotos = [], targetStatus = 'PENDING' }) {
    const [pendingFiles, setPendingFiles] = useState([])
    const [deselectedStems, setDeselectedStems] = useState(new Set())
    const [description, setDescription] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [progress, setProgress] = useState(null)
    const [error, setError] = useState(null)
    const [report, setReport] = useState(null)
    const [interrupting, setInterrupting] = useState(false)
    const abortControllerRef = useRef(null)

    const groups = useMemo(
        () => groupFilesForUpload(pendingFiles, existingPhotos, targetStatus),
        [pendingFiles, existingPhotos, targetStatus]
    )
    const selectedGroups = groups.filter((group) => group.uploadable && !deselectedStems.has(group.stem))

    // Un upload de plusieurs Go : on évite qu'un onglet fermé par mégarde fasse tout perdre.
    useEffect(() => {
        if (!submitting) return undefined
        const warnBeforeUnload = (event) => {
            event.preventDefault()
            event.returnValue = ''
        }
        window.addEventListener('beforeunload', warnBeforeUnload)
        return () => window.removeEventListener('beforeunload', warnBeforeUnload)
    }, [submitting])

    const handleFilesSelected = (event) => {
        setPendingFiles(Array.from(event.target.files))
        setDeselectedStems(new Set())
        setReport(null)
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

    const launchUpload = async (groupsToUpload) => {
        const controller = new AbortController()
        abortControllerRef.current = controller
        setSubmitting(true)
        setInterrupting(false)
        setError(null)
        setReport(null)
        setProgress({ phase: 'preparing', batchIndex: 0, batchCount: 0, bytesDone: 0, bytesTotal: 0 })
        try {
            const result = await onUpload(
                { groups: groupsToUpload, description: description.trim() || null },
                setProgress,
                controller.signal
            )
            setReport(result)
        } catch (uploadError) {
            // Les erreurs d'étape sont déjà décrites dans le rapport ; ici, seul un bug inattendu arrive.
            console.error('Unexpected upload error:', uploadError)
            setError("Une erreur inattendue est survenue pendant l'envoi. Rechargez la liste des photos pour vérifier ce qui a été ajouté.")
        } finally {
            abortControllerRef.current = null
            setSubmitting(false)
        }
    }

    const handleSubmit = (event) => {
        event.preventDefault()
        if (!selectedGroups.length) return
        launchUpload(selectedGroups)
    }

    const handleRetryFailures = () => {
        if (!report?.retryGroups.length) return
        launchUpload(report.retryGroups)
    }

    const handleInterrupt = () => {
        setInterrupting(true)
        abortControllerRef.current?.abort()
    }

    const summary = report ? summarizeReport(report) : null
    const percent = progress?.bytesTotal ? Math.min(100, (progress.bytesDone / progress.bytesTotal) * 100) : 0

    return (
        <form className="collection-form" onSubmit={handleSubmit}>
            <input
                type="file"
                multiple
                onChange={handleFilesSelected}
                required
                disabled={submitting}
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
                                        disabled={!group.uploadable || submitting}
                                        onChange={() => toggleGroup(group.stem)}
                                    />
                                    <span>{describeGroup(group)}</span>
                                </label>
                                {group.isOrphanAttachment && (
                                    <span className="upload-group-warning">
                                        aucun JPEG ni photo existante correspondante — non envoyé
                                    </span>
                                )}
                                {group.conflictFiles.length > 0 && (
                                    <span className="upload-group-warning upload-group-anomaly">
                                        doublon dans la sélection, non envoyé : {listNames(group.conflictFiles.map((file) => file.name))}
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
                disabled={submitting}
            />
            {submitting && progress && (
                <div className="upload-progress-block">
                    <div className="upload-progress">
                        <div className="upload-progress-bar">
                            <div className="upload-progress-fill" style={{ width: `${percent}%` }} />
                        </div>
                        <span>{Math.floor(percent)} %</span>
                    </div>
                    <span className="upload-progress-detail">{describeProgress(progress)}</span>
                </div>
            )}
            {error && <p className="form-error">{error}</p>}
            {summary && !submitting && (
                <div className={`upload-report${isCleanReport(report) ? '' : ' upload-report-warn'}`} role="status">
                    <p className="upload-report-headline">{summary.headline}</p>
                    {summary.lines.length > 0 && (
                        <ul className="upload-report-lines">
                            {summary.lines.map((line, index) => <li key={index}>{line}</li>)}
                        </ul>
                    )}
                </div>
            )}
            <div className="collection-form-actions">
                {submitting ? (
                    <button type="button" className="back-button" onClick={handleInterrupt} disabled={interrupting}>
                        {interrupting ? 'Arrêt après le groupe en cours…' : 'Interrompre'}
                    </button>
                ) : (
                    <button type="button" className="back-button" onClick={onCancel}>
                        {report ? 'Fermer' : 'Annuler'}
                    </button>
                )}
                {report?.retryGroups.length > 0 && !submitting && (
                    <button type="button" className="button-outline" onClick={handleRetryFailures}>
                        Relancer les échecs ({report.retryGroups.length})
                    </button>
                )}
                <button type="submit" className="create-button" disabled={submitting || !selectedGroups.length}>
                    {submitting ? 'Envoi...' : 'Ajouter'}
                </button>
            </div>
        </form>
    )
}
