import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './', updateViaCache: 'none' as any }).catch(() => {});
  });
}
