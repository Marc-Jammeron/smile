import { useState, useEffect } from 'react'
import ClientBrandingPreview from './ClientBrandingPreview.jsx'
import { getSettings, updateSettings, uploadAsset, deleteLogo } from '../api/settings.js'
import { FONTS, DEFAULT_FONT_ID } from 'front-shared/src/constants/fonts.js'
import { BRAND_MODE_LABELS } from 'front-shared/src/constants/brandMode.js'
import {
    DEFAULT_CLIENT_BG,
    CLIENT_TEXT,
    CLIENT_TEXT_SECONDARY,
    contrastRatio
} from 'front-shared/src/constants/clientColors.js'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const MIN_CONTRAST = 4.5

const TEXT_FIELDS = [
    { name: 'displayName', label: 'Nom affiché (remplace le nom par défaut)', max: 40 },
    { name: 'tagline', label: "Sous-titre de l'en-tête (« Photographe » par défaut)", max: 40 },
    { name: 'welcomeMessage', label: "Message d'accueil (optionnel, visible pendant la sélection ; vide = rien n'est affiché)", max: 280, multiline: true }
]

const NULL_FORM = {
    logoKey: null,
    displayName: null,
    tagline: null,
    welcomeMessage: null,
    fontId: null,
    colorBg: null,
    brandMode: null,
    showTagline: null
}

const toForm = (settings) => ({
    logoKey: settings.logoKey,
    displayName: settings.displayName ?? '',
    tagline: settings.tagline ?? '',
    welcomeMessage: settings.welcomeMessage ?? '',
    fontId: settings.fontId,
    colorBg: settings.colorBg,
    brandMode: settings.brandMode,
    showTagline: settings.showTagline,
    // Pour l'aperçu seulement, absents de toPayload.
    logoUrl: settings.logoUrl,
    photographerName: settings.photographerName
})

// Le back normalise de la même façon : texte rogné, chaîne vide = valeur par défaut.
const textOrNull = (text) => text.trim() || null

const toPayload = (form) => ({
    logoKey: form.logoKey,
    displayName: textOrNull(form.displayName),
    tagline: textOrNull(form.tagline),
    welcomeMessage: textOrNull(form.welcomeMessage),
    fontId: form.fontId,
    colorBg: form.colorBg,
    brandMode: form.brandMode,
    showTagline: form.showTagline
})

const isSamePayload = (a, b) => Object.keys(a).every((key) => a[key] === b[key])

const countCharacters = (text) => [...text].length

const FONT_OPTIONS = Object.entries(FONTS).filter(([id]) => id !== DEFAULT_FONT_ID)

export default function ClientBrandingSettings() {
    const [saved, setSaved] = useState(null)
    const [form, setForm] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [error, setError] = useState(null)
    const [uploading, setUploading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [justSaved, setJustSaved] = useState(false)
    // Logo envoyé mais pas encore enregistré : { key, url } avec une URL locale pour l'aperçu.
    const [pendingLogo, setPendingLogo] = useState(null)

    useEffect(() => {
        getSettings()
            .then((settings) => {
                setSaved(toForm(settings))
                setForm(toForm(settings))
            })
            .catch((err) => setLoadError(err.message))
    }, [])

    // Révoque l'URL locale quand elle est remplacée, et au démontage.
    useEffect(() => () => {
        if (pendingLogo) URL.revokeObjectURL(pendingLogo.url)
    }, [pendingLogo])

    if (loadError) return <p className="form-error">{loadError}</p>
    if (!form) return null

    const update = (changes) => {
        setJustSaved(false)
        setForm((current) => ({ ...current, ...changes }))
    }

    const applySettings = (settings) => {
        setSaved(toForm(settings))
        setForm(toForm(settings))
    }

    const handleLogoChange = async (event) => {
        const file = event.target.files[0]
        event.target.value = ''
        if (!file) return

        // Simple aide : le back fait foi.
        if (!LOGO_TYPES.includes(file.type)) {
            setError('Le logo doit être un PNG, un JPEG ou un WebP')
            return
        }
        if (file.size > MAX_FILE_BYTES) {
            setError('Fichier trop lourd (2 Mo maximum)')
            return
        }

        setUploading(true)
        setError(null)
        try {
            const key = await uploadAsset('logo', file)
            setPendingLogo({ key, url: URL.createObjectURL(file) })
            update({ logoKey: key })
        } catch (err) {
            setError(err.message)
        } finally {
            setUploading(false)
        }
    }

    const handleRemoveLogo = async () => {
        setError(null)
        // Un logo envoyé mais pas encore enregistré : on revient simplement au logo enregistré.
        if (form.logoKey !== saved.logoKey) {
            update({ logoKey: saved.logoKey })
            return
        }
        if (!window.confirm('Retirer le logo ?')) return
        try {
            const settings = await deleteLogo()
            setForm((current) => ({ ...current, logoKey: settings.logoKey, logoUrl: settings.logoUrl }))
            setSaved((current) => ({ ...current, logoKey: settings.logoKey, logoUrl: settings.logoUrl }))
        } catch (err) {
            setError(err.message)
        }
    }

    const handleSave = async () => {
        setSaving(true)
        setError(null)
        try {
            applySettings(await updateSettings(toPayload(form)))
            setJustSaved(true)
        } catch (err) {
            setError(err.message)
        } finally {
            setSaving(false)
        }
    }

    const handleReset = async () => {
        if (!window.confirm('Restaurer les valeurs par défaut de la vue client ? Vos réglages seront perdus.')) return
        setError(null)
        try {
            applySettings(await updateSettings(NULL_FORM))
            setJustSaved(true)
        } catch (err) {
            setError(err.message)
        }
    }

    const isDirty = !isSamePayload(toPayload(form), toPayload(saved))
    const backgroundColor = form.colorBg ?? DEFAULT_CLIENT_BG
    const lowContrast =
        Math.min(
            contrastRatio(backgroundColor, CLIENT_TEXT),
            contrastRatio(backgroundColor, CLIENT_TEXT_SECONDARY)
        ) < MIN_CONTRAST

    let previewLogoUrl = null
    if (form.logoKey !== null) {
        previewLogoUrl = form.logoKey === pendingLogo?.key ? pendingLogo.url : saved.logoUrl
    }
    const previewBranding = {
        logoUrl: previewLogoUrl,
        displayName: textOrNull(form.displayName),
        tagline: textOrNull(form.tagline),
        welcomeMessage: textOrNull(form.welcomeMessage),
        fontId: form.fontId,
        colorBg: form.colorBg,
        brandMode: form.brandMode,
        showTagline: form.showTagline
    }

    return (
        <section className="watermark-settings client-branding-settings">
            <h2>Vue client</h2>

            <div className="watermark-settings-layout">
                <div className="collection-form">
                    <div className="watermark-field">
                        <label>
                            Logo (PNG, JPEG ou WebP, 2 Mo maximum, 2000 × 2000 px maximum)
                            <input
                                type="file"
                                accept={LOGO_TYPES.join(',')}
                                onChange={handleLogoChange}
                                disabled={uploading}
                            />
                        </label>
                        {uploading && <p className="upload-file-count">Envoi en cours…</p>}
                        {!uploading && form.logoKey !== saved.logoKey && (
                            <p className="upload-file-count">Nouveau logo prêt, à enregistrer.</p>
                        )}
                        {!uploading && form.logoKey === saved.logoKey && saved.logoKey && (
                            <p className="upload-file-count">Un logo est enregistré.</p>
                        )}
                        {form.logoKey && (
                            <div>
                                <button type="button" className="button-outline" onClick={handleRemoveLogo} disabled={uploading}>
                                    {form.logoKey !== saved.logoKey ? 'Annuler le nouveau logo' : 'Retirer le logo'}
                                </button>
                            </div>
                        )}
                    </div>
    
                    <label className="watermark-field">
                        Affichage dans l'en-tête
                        <select
                            value={form.brandMode ?? ''}
                            onChange={(event) => update({ brandMode: event.target.value || null })}
                        >
                            <option value="">Automatique (logo s'il existe, sinon nom)</option>
                            {Object.entries(BRAND_MODE_LABELS).map(([mode, label]) => (
                                <option key={mode} value={mode}>{label}</option>
                            ))}
                        </select>
                    </label>
    
                    {TEXT_FIELDS.map(({ name, label, max, multiline }) => (
                        <div key={name} className="watermark-field">
                            <label>
                                {label}
                                {multiline ? (
                                    <textarea
                                        rows="4"
                                        maxLength={max}
                                        value={form[name]}
                                        // Le back refuse les sauts de ligne : le message tient sur une ligne.
                                        onChange={(event) => update({ [name]: event.target.value.replace(/[\r\n]+/g, ' ') })}
                                    />
                                ) : (
                                    <input
                                        type="text"
                                        maxLength={max}
                                        value={form[name]}
                                        disabled={name === 'tagline' && form.showTagline === false}
                                        onChange={(event) => update({ [name]: event.target.value })}
                                    />
                                )}
                            </label>
                            <span className="upload-file-count">{countCharacters(form[name])} / {max}</span>
                            {name === 'tagline' && (
                                <label className="watermark-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={form.showTagline !== false}
                                        onChange={(event) => update({ showTagline: event.target.checked ? null : false })}
                                    />
                                    Afficher le sous-titre
                                </label>
                            )}
                        </div>
                    ))}
    
                    <label className="watermark-field">
                        Police
                        <select
                            value={form.fontId ?? ''}
                            onChange={(event) => update({ fontId: event.target.value || null })}
                        >
                            <option value="">Par défaut ({FONTS[DEFAULT_FONT_ID].label})</option>
                            {FONT_OPTIONS.map(([id, { label }]) => (
                                <option key={id} value={id}>{label}</option>
                            ))}
                        </select>
                    </label>
    
                    <div className="watermark-field">
                        <label>
                            Couleur de fond
                            <input
                                type="color"
                                value={backgroundColor}
                                onChange={(event) => update({ colorBg: event.target.value.toLowerCase() })}
                            />
                        </label>
                        {form.colorBg !== null && (
                            <div>
                                <button type="button" className="button-outline" onClick={() => update({ colorBg: null })}>
                                    Fond par défaut
                                </button>
                            </div>
                        )}
                        {lowContrast && (
                            <p className="form-error">
                                Attention : le texte de la page sera difficile à lire sur ce fond (contraste inférieur à 4,5:1).
                                Vous pouvez tout de même enregistrer.
                            </p>
                        )}
                    </div>
    
                    {error && <p className="form-error">{error}</p>}
    
                    <div className="collection-form-actions">
                        <button type="button" className="button-outline" onClick={handleReset} disabled={saving || uploading}>
                            Restaurer les valeurs par défaut
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
                    {justSaved && <p className="upload-file-count">Enregistré.</p>}
                </div>

                <ClientBrandingPreview branding={previewBranding} photographerName={saved.photographerName} />
            </div>
        </section>
    )
}
