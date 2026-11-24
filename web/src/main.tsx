import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Apply the remembered theme before the first paint, so the page does not flash.
try { if (localStorage.getItem('pl-theme') === 'dark') document.documentElement.classList.add('dark') } catch { /* private window */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
