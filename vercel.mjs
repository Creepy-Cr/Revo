// Deploy from the repository root. Only the static web artifact is built here;
// the long-running treasury API and its reconciliation worker need a separate host.
const rawApiOrigin = process.env.REVO_API_ORIGIN?.trim();
let apiOrigin;

if (rawApiOrigin) {
  const url = new URL(rawApiOrigin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('REVO_API_ORIGIN must be an HTTPS origin without a path or credentials.');
  }
  apiOrigin = url.origin;
}

const pageRoutes = ['docs', 'privacy', 'terms', 'risk', 'app', 'dashboard'];

export const config = {
  framework: null,
  installCommand: 'pnpm install --frozen-lockfile',
  buildCommand: 'pnpm --filter @workspace/revo-treasury run build',
  outputDirectory: 'artifacts/revo-treasury/dist/public',
  rewrites: [
    ...(apiOrigin
      ? [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }]
      : []),
    ...pageRoutes.flatMap((page) => [
      { source: `/${page}`, destination: `/${page}.html` },
      { source: `/${page}/`, destination: `/${page}.html` },
    ]),
  ],
};