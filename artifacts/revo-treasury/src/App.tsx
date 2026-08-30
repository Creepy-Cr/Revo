import { lazy, Suspense, type ComponentType, type ReactNode, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';
import {
  NOT_FOUND_METADATA,
  PAGE_METADATA,
  PUBLIC_PAGE_PATHS,
  createStructuredData,
  type PublicPagePath,
} from '@/lib/page-metadata';

const Landing = lazy(() => import('@/pages/landing'));
const Console = lazy(() => import('@/pages/console'));
const Docs = lazy(() => import('@/pages/docs'));
const Privacy = lazy(() => import('@/pages/privacy'));
const Terms = lazy(() => import('@/pages/terms'));
const Risk = lazy(() => import('@/pages/risk'));
const NotFound = lazy(() => import('@/pages/not-found'));

const queryClient = new QueryClient();

const PUBLIC_PAGE_COMPONENTS: Record<PublicPagePath, ComponentType> = {
  '/': Landing,
  '/docs': Docs,
  '/privacy': Privacy,
  '/terms': Terms,
  '/risk': Risk,
};

function Router() {
  const [location] = useLocation();

  useEffect(() => {
    const metadata = PAGE_METADATA[location] ?? NOT_FOUND_METADATA;
    document.title = metadata.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', metadata.description);
    document
      .querySelector('meta[property="og:title"]')
      ?.setAttribute('content', metadata.title);
    document
      .querySelector('meta[property="og:description"]')
      ?.setAttribute('content', metadata.description);
    document
      .querySelector('meta[name="twitter:title"]')
      ?.setAttribute('content', metadata.title);
    document
      .querySelector('meta[name="twitter:description"]')
      ?.setAttribute('content', metadata.description);
    document
      .querySelector('meta[property="og:type"]')
      ?.setAttribute('content', metadata.schemaType === 'TechArticle' ? 'article' : 'website');
    document
      .querySelector('meta[name="robots"]')
      ?.setAttribute('content', metadata.canonical ? 'index, follow' : 'noindex, nofollow');

    let canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    let ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
    if (metadata.canonical) {
      if (!canonical) {
        canonical = document.createElement('link');
        canonical.rel = 'canonical';
        document.head.append(canonical);
      }
      if (!ogUrl) {
        ogUrl = document.createElement('meta');
        ogUrl.setAttribute('property', 'og:url');
        document.head.append(ogUrl);
      }
      canonical.href = metadata.canonical;
      ogUrl.content = metadata.canonical;
    } else {
      canonical?.remove();
      ogUrl?.remove();
    }

    const structuredData = createStructuredData(metadata);
    let structuredDataScript = document.querySelector<HTMLScriptElement>(
      'script#structured-data[type="application/ld+json"]',
    );
    if (structuredData) {
      if (!structuredDataScript) {
        structuredDataScript = document.createElement('script');
        structuredDataScript.id = 'structured-data';
        structuredDataScript.type = 'application/ld+json';
        document.head.append(structuredDataScript);
      }
      structuredDataScript.textContent = JSON.stringify(structuredData);
    } else {
      structuredDataScript?.remove();
    }
  }, [location]);

  return (
    <RoutedErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          {PUBLIC_PAGE_PATHS.map((path) => (
            <Route key={path} path={path} component={PUBLIC_PAGE_COMPONENTS[path]} />
          ))}
          <Route path="/app" component={Console} />
          {/* Legacy alias kept so older links to the command center keep working */}
          <Route path="/dashboard" component={Console} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </RoutedErrorBoundary>
  );
}

function PageFallback() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center text-white">
      <div className="font-mono text-xs tracking-[0.18em] uppercase text-white/60">
        Loading Revo…
      </div>
    </div>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App({ ssrPath }: { ssrPath?: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter
          base={import.meta.env.BASE_URL.replace(/\/$/, '')}
          ssrPath={ssrPath}
        >
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
