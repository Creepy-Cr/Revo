import type { ErrorInfo } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';

import './index.css';

const rootElement = document.getElementById('root')!;
const rootOptions = {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error: unknown, errorInfo: ErrorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
};
const app = (
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

const normalizePath = (path: string) =>
  path === '/' ? path : path.replace(/\/+$/, '');
const prerenderPath = rootElement.dataset.prerenderPath;
const canHydrate =
  rootElement.hasChildNodes() &&
  prerenderPath !== undefined &&
  normalizePath(prerenderPath) === normalizePath(window.location.pathname);

if (canHydrate) {
  hydrateRoot(rootElement, app, rootOptions);
} else {
  rootElement.replaceChildren();
  createRoot(rootElement, rootOptions).render(app);
}
