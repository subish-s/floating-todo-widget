/**
 * Renderer entry point.
 *
 * The widget is the entire application, so there is no router, no page shell
 * and no server-rendered markup: the document is a single mount node and the
 * bundle below is the whole UI. esbuild writes it to `dist/renderer.js`, which
 * Electron loads over `file://`.
 */
import { createRoot } from 'react-dom/client';
import FloatingWidget from './components/FloatingWidget';
import './styles/global.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<FloatingWidget />);
}
