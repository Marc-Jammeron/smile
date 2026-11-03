import { useState } from 'react'

export const CLIENT_MESSAGE_MAX_LENGTH = 3000

// Editor for a markdown message shown at the top of the client gallery (one box per collection status:
// the selection message and the final message). `onSave(text)` must throw on failure.
export default function ClientMessageBox({ id, label, placeholder, savedValue, onSave }) {
    const [message, setMessage] = useState(savedValue ?? '')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [error, setError] = useState(null)

    const changed = message.trim() !== (savedValue ?? '')

    const handleSave = async () => {
        setSaving(true)
        setError(null)
        setSaved(false)
        try {
            await onSave(message)
            setMessage(message.trim())
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
        } catch (err) {
            console.error('Error saving client message:', err)
            setError(err.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="client-message-box">
            <label htmlFor={id}>{label}</label>
            <textarea
                id={id}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={CLIENT_MESSAGE_MAX_LENGTH}
                rows={3}
                placeholder={placeholder}
            />
            <div className="client-message-actions">
                <span className="client-message-counter">{message.length}/{CLIENT_MESSAGE_MAX_LENGTH}</span>
                {error && <span className="form-error">{error}</span>}
                <button
                    type="button"
                    className="button-outline"
                    onClick={handleSave}
                    disabled={saving || (!changed && !saved)}
                >
                    {saving ? 'Enregistrement...' : saved ? 'Enregistré !' : 'Enregistrer'}
                </button>
            </div>
        </div>
    )
}
