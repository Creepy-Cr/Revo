import { PassThrough } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import { ErrorBoundary } from '@/components/error-boundary';
import App from './App';
import {
  PAGE_METADATA,
  PUBLIC_PAGE_PATHS,
  type PublicPagePath,
} from '@/lib/page-metadata';

export { PAGE_METADATA, PUBLIC_PAGE_PATHS };

export function renderPublicRoute(pathname: PublicPagePath): Promise<string> {
  return new Promise((resolve, reject) => {
    let renderError: unknown;
    const output = new PassThrough();
    let html = '';

    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      html += chunk;
    });
    output.on('end', () => resolve(html));
    output.on('error', reject);

    const { pipe, abort } = renderToPipeableStream(
      <ErrorBoundary>
        <App ssrPath={pathname} />
      </ErrorBoundary>,
      {
        onAllReady() {
          clearTimeout(timeout);
          if (renderError) {
            reject(renderError);
            return;
          }
          pipe(output);
        },
        onShellError(error) {
          clearTimeout(timeout);
          reject(error);
        },
        onError(error) {
          renderError = error;
        },
      },
    );

    const timeout = setTimeout(() => {
      abort();
      reject(new Error(`Prerender timed out for ${pathname}`));
    }, 15_000);
  });
}