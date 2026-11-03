import { useState } from 'react'
import { GOOGLE_REVIEW_URL } from '../constants/googleReview.js'

const dismissKey = (variant) => `review-card-dismissed-${variant}`

const isDismissed = (variant) => {
    try {
        return sessionStorage.getItem(dismissKey(variant)) === '1'
    } catch {
        return false
    }
}

const rememberDismissed = (variant) => {
    try {
        sessionStorage.setItem(dismissKey(variant), '1')
    } catch {
        // storage unavailable (private mode…): the card will simply show again next time
    }
}

const CONTENT = {
    // After the selection is validated: a discreet, low-pressure invitation.
    validated: {
        title: 'Merci pour votre confiance !',
        text: 'Si l\'expérience vous a plu jusqu\'ici, un petit mot sur Google m\'aiderait beaucoup.'
    },
    // Final photos delivered: the main ask, when the client has just seen the result.
    ready: {
        title: 'Vos photos vous plaisent ?',
        text: 'Si ce moment vous a plu, un petit avis Google m’aiderait beaucoup : c’est ce qui permet à d’autres de me trouver. \nQuelques mots sur ce qui vous a marqué, et c’est parfait.'
    }
}

export default function ReviewCard({ variant }) {
    const [dismissed, setDismissed] = useState(() => isDismissed(variant))
    const { title, text } = CONTENT[variant]

    if (!GOOGLE_REVIEW_URL || dismissed) return null

    const dismiss = () => {
        rememberDismissed(variant)
        setDismissed(true)
    }

    return (
        <aside className={`client-review-card client-review-card-${variant}`}>
            <h2 className="client-review-title">{title}</h2>
            <p className="client-review-text">{text}</p>
            <div className="client-review-actions">
                <a
                    className="client-review-link"
                    href={GOOGLE_REVIEW_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Laisser un avis Google ★
                </a>
                <button type="button" className="client-review-dismiss" onClick={dismiss}>
                    Plus tard
                </button>
            </div>
        </aside>
    )
}
