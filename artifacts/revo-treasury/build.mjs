import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build as viteBuild } from 'vite';

const rootDir = path.dirname(new URL(import.meta.url).pathname);
const clientOutDir = path.join(rootDir, 'dist/public');
const prerenderOutDir = path.join(rootDir, 'dist/prerender');
const basePath = process.env.BASE_PATH ?? '/';

await viteBuild({
  configFile: path.join(rootDir, 'vite.config.ts'),
});

const shellPath = path.join(clientOutDir, 'index.html');
const clientShell = await readFile(shellPath, 'utf8');

try {
  await viteBuild({
    configFile: false,
    root: rootDir,
    base: basePath,
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.join(rootDir, 'src'),
      },
      dedupe: ['react', 'react-dom'],
    },
    build: {
      ssr: path.join(rootDir, 'src/prerender.tsx'),
      outDir: prerenderOutDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: 'render.mjs',
        },
      },
    },
  });

  const rendererUrl = `${pathToFileURL(path.join(prerenderOutDir, 'render.mjs')).href}?v=${Date.now()}`;
  const {
    PAGE_METADATA,
    PUBLIC_PAGE_PATHS,
    createStructuredData,
    renderPublicRoute,
  } = await import(rendererUrl);

  for (const route of PUBLIC_PAGE_PATHS) {
    const html = withRouteDocument(
      clientShell,
      PAGE_METADATA[route],
      await renderPublicRoute(route),
      route,
      false,
      createStructuredData(PAGE_METADATA[route]),
    );
    await writeRouteFile(route, html);
  }

  // Explicit files keep the authenticated console client-only and prevent the
  // prerendered homepage from being used as its SPA fallback document.
  for (const route of ['/app', '/dashboard']) {
    const html = withRouteDocument(clientShell, PAGE_METADATA[route], '', undefined, true);
    await writeRouteFile(route, html);
  }
} finally {
  await rm(prerenderOutDir, { recursive: true, force: true });
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function replaceOrInsertHeadTag(html, matcher, replacement) {
  return matcher.test(html)
    ? html.replace(matcher, replacement)
    : html.replace('</head>', `    ${replacement}\n  </head>`);
}

function withRouteDocument(
  shell,
  metadata,
  markup,
  prerenderPath,
  noindex = false,
  structuredData = null,
) {
  let html = shell
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(metadata.title)}</title>`)
    .replace(
      /<meta\s+name=["']description["'][^>]*>/i,
      `<meta name="description" content="${escapeHtml(metadata.description)}" />`,
    )
    .replace(
      /<meta\s+property=["']og:title["'][^>]*>/i,
      `<meta property="og:title" content="${escapeHtml(metadata.title)}" />`,
    )
    .replace(
      /<meta\s+property=["']og:description["'][^>]*>/i,
      `<meta property="og:description" content="${escapeHtml(metadata.description)}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:title["'][^>]*>/i,
      `<meta name="twitter:title" content="${escapeHtml(metadata.title)}" />`,
    )
    .replace(
      /<meta\s+name=["']twitter:description["'][^>]*>/i,
      `<meta name="twitter:description" content="${escapeHtml(metadata.description)}" />`,
    )
    .replace(
      /<meta\s+property=["']og:type["'][^>]*>/i,
      `<meta property="og:type" content="${
        metadata.schemaType === 'TechArticle' ? 'article' : 'website'
      }" />`,
    );

  if (metadata.canonical) {
    html = replaceOrInsertHeadTag(
      html,
      /<link\s+rel=["']canonical["'][^>]*>/i,
      `<link rel="canonical" href="${escapeHtml(metadata.canonical)}" />`,
    );
    html = replaceOrInsertHeadTag(
      html,
      /<meta\s+property=["']og:url["'][^>]*>/i,
      `<meta property="og:url" content="${escapeHtml(metadata.canonical)}" />`,
    );
  } else {
    html = html
      .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/i, '')
      .replace(/\s*<meta\s+property=["']og:url["'][^>]*>/i, '');
  }

  if (noindex) {
    html = html.replace(
      /<meta\s+name=["']robots["'][^>]*>/i,
      '<meta name="robots" content="noindex, nofollow" />',
    );
  }

  const structuredDataTag = /<script\s+id=["']structured-data["'][^>]*>[\s\S]*?<\/script>/i;
  if (structuredData) {
    const serialized = JSON.stringify(structuredData).replaceAll('<', '\\u003c');
    html = replaceOrInsertHeadTag(
      html,
      structuredDataTag,
      `<script id="structured-data" type="application/ld+json">${serialized}</script>`,
    );
  } else {
    html = html.replace(structuredDataTag, '');
  }

  const rootAttributes = prerenderPath
    ? ` id="root" data-prerender-path="${escapeHtml(prerenderPath)}"`
    : ' id="root"';

  return html.replace(
    /<div\s+id=["']root["']\s*><\/div>/i,
    `<div${rootAttributes}>${markup}</div>`,
  );
}

async function writeRouteFile(route, html) {
  const outputPath =
    route === '/'
      ? path.join(clientOutDir, 'index.html')
      : path.join(clientOutDir, `${route.slice(1).replaceAll('/', '--')}.html`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
}