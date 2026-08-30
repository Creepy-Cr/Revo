import { lazy, Suspense, type ReactNode, useEffect } from 'react';
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

const Landing = lazy(() => import('@/pages/landing'));
const Console = lazy(() => import('@/pages/console'));
const Docs = lazy(() => import('@/pages/docs'));
const Privacy = lazy(() => import('@/pages/privacy'));
const Terms = lazy(() => import('@/pages/terms'));
const Risk = lazy(() => import('@/pages/risk'));
const NotFound = lazy(() => import('@/pages/not-found'));

const queryClient = new QueryClient();

const PAGE_METADATA: Record<string, { title: string; description: string }> = {
  '/': {
    title: 'Revo Treasury | Autonomous Treasury Intelligence',
    description:
      'Guarded DAO treasury operations on Arc Testnet with live signals, deterministic policy controls, and Claude-powered intelligence.',
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
  },
  '/privacy': {
    title: 'Privacy | Revo Treasury',
    description: 'Privacy information for the Revo Treasury testnet application.',
  },
  '/terms': {
    title: 'Terms | Revo Treasury',
    description: 'Terms for using the Revo Treasury testnet application.',
  },
  '/risk': {
    title: 'Risk Disclosure | Revo Treasury',
    description:
      'Important risk and simulation disclosures for Revo Treasury on Arc Testnet.',
  },
};

function Router() {
  const [location] = useLocation();

  useEffect(() => {
    const metadata = PAGE_METADATA[location] ?? {
      title: 'Page Not Found | Revo Treasury',
      description: 'The requested Revo Treasury page could not be found.',
    };
    document.title = metadata.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', metadata.description);
  }, [location]);

  return (
    <RoutedErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={Landing} />
          <Route path="/app" component={Console} />
          {/* Legacy alias kept so older links to the command center keep working */}
          <Route path="/dashboard" component={Console} />
          <Route path="/docs" component={Docs} />
          <Route path="/privacy" component={Privacy} />
          <Route path="/terms" component={Terms} />
          <Route path="/risk" component={Risk} />
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
