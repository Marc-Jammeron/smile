import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PublicGallery from './components/PublicGallery.jsx'

const galleryMatch = window.location.pathname.match(/^\/gallery\/([^/]+)\/?$/)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <PublicGallery token={galleryMatch ? galleryMatch[1] : null} />
  </StrictMode>,
)
