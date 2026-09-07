import './App.css'
import { useState, useEffect } from 'react'
import Gallery from './components/Gallery.jsx'
import Login from './components/Login.jsx'
import { login, logout, getCurrentPhotographer } from './api/auth.js'

function App() {
  const [photographer, setPhotographer] = useState(null)
  const [checkingSession, setCheckingSession] = useState(true)

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
        <button className="back-button" onClick={handleLogout}>Déconnexion</button>
      </div>
      <Gallery />
    </>
  )
}

export default App
