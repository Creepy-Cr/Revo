export const SITE_ORIGIN = 'https://therevo.xyz';

export interface PageMetadata {
  title: string;
  description: string;
  canonical?: string;
}

export const PUBLIC_PAGE_PATHS = ['/', '/docs', '/privacy', '/terms', '/risk'] as const;

export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number];

const canonical = (path: PublicPagePath) =>
  path === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`;

export const PAGE_METADATA: Record<string, PageMetadata> = {
  '/': {
    title: 'Revo Treasury | Autonomous Treasury Intelligence',
    description:
      'Guarded DAO treasury operations on Arc Testnet with live signals, deterministic policy controls, and Claude-powered intelligence.',
    canonical: canonical('/'),
  },
  '/app': {
    title: 'Treasury Console | Revo',
    description:
      'Operate a testnet treasury with wallet authentication, policy governance, security controls, and transparent activity.',
  },
  '/dashboard': {
    title: 'Treasury Console | Revo',
    description:
      'Operate a testnet treasury with wallet authentication, policy governance, security controls, and transparent activity.',
  },
  '/docs': {
    title: 'Documentation | Revo Treasury',
    description:
      'Understand Revo Treasury architecture, APIs, Arc Testnet custody, governance, and testnet-only safety boundaries.',
    canonical: canonical('/docs'),
  },
  '/privacy': {
    title: 'Privacy | Revo Treasury',
    description: 'Privacy information for the Revo Treasury testnet application.',
    canonical: canonical('/privacy'),
  },
  '/terms': {
    title: 'Terms | Revo Treasury',
    description: 'Terms for using the Revo Treasury testnet application.',
    canonical: canonical('/terms'),
  },
  '/risk': {
    title: 'Risk Disclosure | Revo Treasury',
    description:
      'Important risk and simulation disclosures for Revo Treasury on Arc Testnet.',
    canonical: canonical('/risk'),
  },
};

export const NOT_FOUND_METADATA: PageMetadata = {
  title: 'Page Not Found | Revo Treasury',
  description: 'The requested Revo Treasury page could not be found.',
};