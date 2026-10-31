import './App.css'
import { useState, useEffect } from 'react'
import Gallery from './components/Gallery.jsx'
import Login from './components/Login.jsx'
import SettingsPage from './components/SettingsPage.jsx'
import { login, logout, getCurrentPhotographer } from './api/auth.js'

function App() {
  const [photographer, setPhotographer] = useState(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [view, setView] = useState('gallery')

  useEffect(() => {
    getCurrentPhotographer()
      .then(setPhotographer)
      .finally(() => setCheckingSession(false))
  }, [])

  const handleLogin = async (email, password) => {
    const data = await login(email, password)
    setPhotographer(data)
  }

  const handleLogout = async () => {
    await logout()
    setPhotographer(null)
    setView('gallery')
  }

  if (checkingSession) {
    return null
  }

  if (!photographer) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <>
      <div className="topbar">
        <span>{photographer.email}</span>
        <button className="back-button" onClick={() => setView(view === 'gallery' ? 'settings' : 'gallery')}>
          {view === 'gallery' ? 'Réglages' : 'Retour'}
        </button>
        <button className="back-button" onClick={handleLogout}>Déconnexion</button>
      </div>
      {view === 'gallery' ? <Gallery /> : <SettingsPage />}
    </>
  )
}

export default App
