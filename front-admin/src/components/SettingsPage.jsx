import { useState } from 'react'
import WatermarkSettings from './WatermarkSettings.jsx'
import ClientBrandingSettings from './ClientBrandingSettings.jsx'

const SECTIONS = [
    { id: 'watermark', label: 'Watermark', Component: WatermarkSettings },
    { id: 'client', label: 'Vue client', Component: ClientBrandingSettings }
]

export default function SettingsPage() {
    const [sectionId, setSectionId] = useState(SECTIONS[0].id)
    const { Component } = SECTIONS.find(({ id }) => id === sectionId)

    return (
        <div className="settings-page">
            <nav className="settings-sidebar" aria-label="Réglages">
                {SECTIONS.map(({ id, label }) => (
                    <button
                        key={id}
                        type="button"
                        className={`settings-sidebar-item${id === sectionId ? ' active' : ''}`}
                        aria-current={id === sectionId ? 'page' : undefined}
                        onClick={() => setSectionId(id)}
                    >
                        {label}
                    </button>
                ))}
            </nav>
            <div className="settings-content">
                <Component />
            </div>
        </div>
    )
}
