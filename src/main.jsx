import '@fontsource/big-shoulders-display/700'
import '@fontsource/big-shoulders-display/900'
import '@fontsource/barlow-condensed/400'
import '@fontsource/barlow-condensed/600'
import '@fontsource/barlow-condensed/700'
import '@fontsource/courier-prime/400'
import '@fontsource/courier-prime/700'
import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// scripts/bake.mjs loads the dev page with ?bake to run the drawing code without the scene
if (!(import.meta.env.DEV && location.search === '?bake')) createRoot(document.getElementById('root')).render(<App />)
