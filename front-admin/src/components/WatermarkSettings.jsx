import { useState, useEffect, useRef } from 'react'
import { getSettings, updateSettings, uploadAsset, previewWatermark, resetWatermark } from '../api/settings.js'

const POSITION_OPTIONS = [
    { value: 'northwest', label: 'Haut-gauche' },
    { value: 'northeast', label: 'Haut-droite' },
    { value: 'center', label: 'Centre' },
    { value: 'southwest', label: 'Bas-gauche' },
    { value: 'southeast', label: 'Bas-droite' }
]

const MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_SIZE = 30
const PREVIEW_DEBOUNCE_MS = 300

const toForm = (settings) => ({
    watermarkKey: settings.watermarkKey,
    watermarkPosition: settings.watermarkPosition,
    watermarkOpacity: settings.watermarkOpacity,
    watermarkSize: settings.watermarkSize
})

const isSameForm = (a, b) =>
    a.watermarkKey === b.watermarkKey &&
    a.watermarkPosition === b.watermarkPosition &&
    a.watermarkOpacity === b.watermarkOpacity &&
    a.watermarkSize === b.watermarkSize

export default function WatermarkSettings() {
    const [saved, setSaved] = useState(null)
    const [form, setForm] = useState(null)
    const [previewUrl, setPreviewUrl] = useState(null)
    const [previewError, setPreviewError] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [error, setError] = useState(null)
    const [uploading, setUploading] = useState(false)
    const [saving, setSaving] = useState(false)
    const lastSizeRef = useRef(DEFAULT_SIZE)

    useEffect(() => {
        getSettings()
            .then((settings) => {
                setSaved(toForm(settings))
                setForm(toForm(settings))
            })
            .catch((err) => setLoadError(err.message))
    }, [])

    // Aperçu régénéré à chaque changement (debounce) ; seule la dernière requête compte.
    useEffect(() => {
        if (!form) return
        const controller = new AbortController()
        const timer = setTimeout(async () => {
            try {
                const blob = await previewWatermark(form, controller.signal)
                setPreviewUrl(URL.createObjectURL(blob))
                setPreviewError(null)
            } catch (err) {
                if (err.name !== 'AbortError') setPreviewError(err.message)
            }
        }, PREVIEW_DEBOUNCE_MS)
        return () => {
            clearTimeout(timer)
            controller.abort()
        }
    }, [form])

    // Révoque l'URL d'objet précédente quand elle est remplacée, et au démontage.
    useEffect(() => () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl)
    }, [previewUrl])

    if (loadError) return <p className="form-error">{loadError}</p>
    if (!form) return null

    const update = (changes) => setForm((current) => ({ ...current, ...changes }))

    const handleFileChange = async (event) => {
        const file = event.target.files[0]
        event.target.value = ''
        if (!file) return

        // Simple aide : le back fait foi.
        if (file.type !== 'image/png') {
            setError('Le fichier doit être un PNG')
            return
        }
        if (file.size > MAX_FILE_BYTES) {
            setError('Fichier trop lourd (2 Mo maximum)')
            return
        }

        setUploading(true)
        setError(null)
        try {
            update({ watermarkKey: await uploadAsset('watermark', file) })
        } catch (err) {
            setError(err.message)
        } finally {
            setUploading(false)
        }
    }

    const handleNativeSizeChange = (event) => {
        if (event.target.checked) {
            if (form.watermarkSize !== null) lastSizeRef.current = form.watermarkSize
            update({ watermarkSize: null })
        } else {
            update({ watermarkSize: lastSizeRef.current })
        }
    }

    const handleSave = async () => {
        setSaving(true)
        setError(null)
        try {
            const settings = await updateSettings(form)
            setSaved(toForm(settings))
            setForm(toForm(settings))
        } catch (err) {
            setError(err.message)
        } finally {
            setSaving(false)
        }
    }

    const handleReset = async () => {
        if (!window.confirm('Revenir au watermark par défaut ? Vos réglages seront perdus.')) return
        setError(null)
        try {
            const settings = await resetWatermark()
            setSaved(toForm(settings))
            setForm(toForm(settings))
        } catch (err) {
            setError(err.message)
        }
    }

    const isDirty = !isSameForm(form, saved)

    return (
        <section className="watermark-settings">
            <h2>Watermark</h2>

            <div className="watermark-settings-layout">
                <div className="collection-form">
                    <label className="watermark-field">
                        Image du watermark (PNG, 2 Mo maximum)
                        <input type="file" accept="image/png" onChange={handleFileChange} disabled={uploading} />
                    </label>
                    {uploading && <p className="upload-file-count">Envoi en cours…</p>}
                    {form.watermarkKey !== saved.watermarkKey && !uploading && (
                        <p className="upload-file-count">Nouvelle image prête, à enregistrer.</p>
                    )}

                    <label className="watermark-field">
                        Position
                        <select
                            value={form.watermarkPosition}
                            onChange={(event) => update({ watermarkPosition: event.target.value })}
                        >
                            {POSITION_OPTIONS.map(({ value, label }) => (
                                <option key={value} value={value}>{label}</option>
                            ))}
                        </select>
                    </label>

                    <label className="watermark-field">
                        Opacité : {form.watermarkOpacity} %
                        <input
                            type="range"
                            min="10"
                            max="80"
                            step="5"
                            value={form.watermarkOpacity}
                            onChange={(event) => update({ watermarkOpacity: Number(event.target.value) })}
                        />
                    </label>

                    <div className="watermark-field">
                        <label>
                            Taille : {form.watermarkSize === null ? "taille d'origine" : `${form.watermarkSize} % de la largeur`}
                            <input
                                type="range"
                                min="10"
                                max="50"
                                step="5"
                                value={form.watermarkSize ?? lastSizeRef.current}
                                disabled={form.watermarkSize === null}
                                onChange={(event) => update({ watermarkSize: Number(event.target.value) })}
                            />
                        </label>
                        <label className="watermark-checkbox">
                            <input
                                type="checkbox"
                                checked={form.watermarkSize === null}
                                onChange={handleNativeSizeChange}
                            />
                            Taille d'origine
                        </label>
                    </div>

                    {error && <p className="form-error">{error}</p>}

                    <div className="collection-form-actions">
                        <button type="button" className="button-outline" onClick={handleReset}>
                            Revenir au watermark par défaut
                        </button>
                        <button
                            type="button"
                            className="button-primary"
                            onClick={handleSave}
                            disabled={saving || uploading || !isDirty}
                        >
                            {saving ? 'Enregistrement…' : 'Enregistrer'}
                        </button>
                    </div>
                    <p className="upload-file-count">
                        S'applique aux prochaines photos uploadées, pas à celles déjà dans des collections
                    </p>
                </div>

                <div className="watermark-preview">
                    {previewUrl && <img src={previewUrl} alt="Aperçu du watermark" />}
                    {previewError && <p className="form-error">{previewError}</p>}
                </div>
            </div>
        </section>
    )
}
