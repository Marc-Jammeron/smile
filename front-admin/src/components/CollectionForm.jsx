import { useState } from 'react'
import { STATUS_OPTIONS, STATUS_LABELS } from 'front-shared/src/constants/collectionStatus.js'

export default function CollectionForm({ onCreate, onCancel }) {
    const [name, setName] = useState('')
    const [clientName, setClientName] = useState('')
    const [clientEmail, setClientEmail] = useState('')
    const [description, setDescription] = useState('')
    const [status, setStatus] = useState('DRAFT')
    const [maxPhotos, setMaxPhotos] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState(null)

    const handleSubmit = async (event) => {
        event.preventDefault()
        if (!name.trim() || !clientName.trim() || !clientEmail.trim()) return

        setSubmitting(true)
        setError(null)
        try {
            await onCreate({
                name: name.trim(),
                clientName: clientName.trim(),
                clientEmail: clientEmail.trim(),
                description: description.trim() || null,
                status,
                maxPhotos: maxPhotos === '' ? 0 : Number(maxPhotos)
            })
        } catch {
            setError('Impossible de créer la collection')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <form className="collection-form" onSubmit={handleSubmit}>
            <input
                type="text"
                placeholder="Nom de la collection"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                required
            />
            <input
                type="text"
                placeholder="Nom du client"
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                required
            />
            <input
                type="email"
                placeholder="Email du client"
                value={clientEmail}
                onChange={(event) => setClientEmail(event.target.value)}
                required
            />
            <textarea
                placeholder="Description (optionnel)"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
            />
            <div className="collection-form-row">
                <label>
                    Statut
                    <select value={status} onChange={(event) => setStatus(event.target.value)}>
                        {STATUS_OPTIONS.map(option => (
                            <option key={option} value={option}>{STATUS_LABELS[option]}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Nombre max de photos
                    <input
                        type="number"
                        min="0"
                        placeholder="0"
                        value={maxPhotos}
                        onChange={(event) => setMaxPhotos(event.target.value)}
                    />
                </label>
            </div>
            {error && <p className="form-error">{error}</p>}
            <div className="collection-form-actions">
                <button type="button" className="back-button" onClick={onCancel} disabled={submitting}>
                    Annuler
                </button>
                <button type="submit" className="create-button" disabled={submitting || !name.trim() || !clientName.trim() || !clientEmail.trim()}>
                    {submitting ? 'Création...' : 'Créer'}
                </button>
            </div>
        </form>
    )
}
