export const SITE_ORIGIN = 'https://therevo.xyz';
export const SOCIAL_IMAGE_URL = `${SITE_ORIGIN}/social/revo-treasury-share.png`;

export interface PageMetadata {
  title: string;
  description: string;
  canonical?: string;
  schemaType?: 'WebPage' | 'TechArticle';
}

export const PUBLIC_PAGE_PATHS = ['/', '/docs', '/privacy', '/terms', '/risk'] as const;

export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number];

const canonical = (path: PublicPagePath) =>
  path === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`;

export const PAGE_METADATA: Record<string, PageMetadata> = {
  '/': {
    title: 'Revo Treasury | Autonomous Treasury Intelligence',
    description:
      'Guarded DAO treasury operations on Arc mainnet with live signals, deterministic policy controls, and Claude-powered intelligence.',
    canonical: canonical('/'),
  },
  '/app': {
    title: 'Treasury Console | Revo',
    description:
      'Operate an Arc mainnet treasury with wallet authentication, policy governance, security controls, and transparent activity.',
  },
  '/dashboard': {
    title: 'Treasury Console | Revo',
    description:
      'Operate an Arc mainnet treasury with wallet authentication, policy governance, security controls, and transparent activity.',
  },
  '/docs': {
    title: 'Documentation | Revo Treasury',
    description:
      'Understand Revo Treasury architecture, APIs, Arc mainnet custody, governance, and security boundaries.',
    canonical: canonical('/docs'),
    schemaType: 'TechArticle',
  },
  '/privacy': {
    title: 'Privacy | Revo Treasury',
    description: 'Privacy information for the Revo Treasury Arc mainnet application.',
    canonical: canonical('/privacy'),
  },
  '/terms': {
    title: 'Terms | Revo Treasury',
    description: 'Terms for using the Revo Treasury Arc mainnet application.',
    canonical: canonical('/terms'),
  },
  '/risk': {
    title: 'Risk Disclosure | Revo Treasury',
    description:
      'Important risk disclosures for Revo Treasury on Arc mainnet.',
    canonical: canonical('/risk'),
  },
};

export const NOT_FOUND_METADATA: PageMetadata = {
  title: 'Page Not Found | Revo Treasury',
  description: 'The requested Revo Treasury page could not be found.',
};

export function createStructuredData(metadata: PageMetadata) {
  if (!metadata.canonical) return null;

  const organizationId = `${SITE_ORIGIN}/#organization`;
  const websiteId = `${SITE_ORIGIN}/#website`;
  const logoId = `${SITE_ORIGIN}/#logo`;
  const primaryImageId = `${metadata.canonical}#primaryimage`;
  const webpageType =
    metadata.schemaType === 'TechArticle' ? ['WebPage', 'TechArticle'] : 'WebPage';

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': organizationId,
        name: 'Revo Core Technologies',
        alternateName: 'Revo',
        url: `${SITE_ORIGIN}/`,
        logo: {
          '@type': 'ImageObject',
          '@id': logoId,
          url: `${SITE_ORIGIN}/brand/revo-mark.png`,
          contentUrl: `${SITE_ORIGIN}/brand/revo-mark.png`,
          width: 435,
          height: 512,
        },
        image: { '@id': logoId },
      },
      {
        '@type': 'WebSite',
        '@id': websiteId,
        url: `${SITE_ORIGIN}/`,
        name: 'Revo Treasury',
        description:
          'An Arc mainnet treasury command center for guarded DAO operations, explainable market signals, and policy governance.',
        publisher: { '@id': organizationId },
        inLanguage: 'en',
      },
      {
        '@type': 'ImageObject',
        '@id': primaryImageId,
        url: SOCIAL_IMAGE_URL,
        contentUrl: SOCIAL_IMAGE_URL,
        width: 1200,
        height: 630,
        caption: 'Revo Treasury: Autonomous Treasury Intelligence',
      },
      {
        '@type': webpageType,
        '@id': `${metadata.canonical}#webpage`,
        url: metadata.canonical,
        name: metadata.title,
        headline: metadata.title,
        description: metadata.description,
        isPartOf: { '@id': websiteId },
        about: { '@id': organizationId },
        publisher: { '@id': organizationId },
        primaryImageOfPage: { '@id': primaryImageId },
        inLanguage: 'en',
      },
    ],
  };
}