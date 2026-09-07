import { useState } from 'react'

export default function Login({ onLogin }) {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState(null)

    const handleSubmit = async (event) => {
        event.preventDefault()
        setSubmitting(true)
        setError(null)
        try {
            await onLogin(email, password)
        } catch (loginError) {
            setError(loginError.message || 'Connexion impossible')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className="login">
            <h1>Connexion</h1>
            <form className="collection-form" onSubmit={handleSubmit}>
                <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                    required
                />
                <input
                    type="password"
                    placeholder="Mot de passe"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                />
                {error && <p className="form-error">{error}</p>}
                <div className="collection-form-actions">
                    <button type="submit" className="create-button" disabled={submitting || !email || !password}>
                        {submitting ? 'Connexion...' : 'Se connecter'}
                    </button>
                </div>
            </form>
        </div>
    )
}
