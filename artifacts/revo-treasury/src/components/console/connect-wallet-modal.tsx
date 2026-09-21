import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import { X, AlertCircle, Loader2, CheckCircle2, ArrowUpRight, Wallet } from 'lucide-react';
import { useWalletContext } from './wallet-context';
import { useEip6963Providers } from '@/hooks/use-eip6963';
import type { Eip6963ProviderDetail } from '@/lib/arc-wallet';
import metamaskLogo from '@/assets/wallets/metamask.svg';
import okxLogo from '@/assets/wallets/okx.svg';
import phantomLogo from '@/assets/wallets/phantom.svg';
import rabbyLogo from '@/assets/wallets/rabby.svg';
import { trackEvent } from '@/lib/analytics';

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

interface KnownWallet {
  id: string;
  name: string;
  rdns: string[];
  logo: string;
  installUrl: string;
}

const KNOWN_WALLETS: KnownWallet[] = [
  {
    id: 'metamask',
    name: 'MetaMask',
    rdns: ['io.metamask', 'io.metamask.flask'],
    logo: metamaskLogo,
    installUrl: 'https://metamask.io/download',
  },
  {
    id: 'okx',
    name: 'OKX Wallet',
    rdns: ['com.okex.wallet'],
    logo: okxLogo,
    installUrl: 'https://web3.okx.com',
  },
  {
    id: 'phantom',
    name: 'Phantom',
    rdns: ['app.phantom'],
    logo: phantomLogo,
    installUrl: 'https://phantom.app/download',
  },
  {
    id: 'rabby',
    name: 'Rabby',
    rdns: ['io.rabby'],
    logo: rabbyLogo,
    installUrl: 'https://rabby.io',
  },
];

function WalletRow({
  logo,
  name,
  detected,
  pending,
  disabled,
  onConnect,
  installUrl,
  testId,
}: {
  logo: string;
  name: string;
  detected: boolean;
  pending: boolean;
  disabled: boolean;
  onConnect?: () => void;
  installUrl?: string;
  testId: string;
}) {
  const inner = (
    <>
      <span className="w-11 h-11 shrink-0 rounded-xl bg-white/[0.05] border border-white/[0.08] flex items-center justify-center transition-transform duration-300 group-hover:scale-[1.06] shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
        <img src={logo} alt="" className="w-6 h-6" draggable={false} />
      </span>
      <span className="flex-1 text-left text-white font-medium text-[15px] tracking-[-0.01em]">
        {name}
      </span>
      {pending ? (
        <Loader2 className="w-4 h-4 text-primary animate-spin" />
      ) : detected ? (
        <span className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-green-400">
          <span className="w-1.5 h-1.5 bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
          Detected
        </span>
      ) : (
        <span className="flex items-center gap-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-white/35 group-hover:text-white/70 transition-colors">
          Install
          <ArrowUpRight className="w-3 h-3" />
        </span>
      )}
    </>
  );

  const rowClass =
    'group relative w-full flex items-center gap-4 p-3 pr-4 rounded-2xl border transition-all duration-300 overflow-hidden ' +
    (detected
      ? 'bg-white/[0.02] border-white/[0.07] hover:border-primary/45 hover:bg-white/[0.045] hover:shadow-[0_8px_28px_-10px_rgba(252,59,0,0.35)]'
      : 'bg-transparent border-white/[0.05] hover:border-white/[0.14] opacity-80 hover:opacity-100');

  if (detected) {
    return (
      <button type="button" onClick={onConnect} disabled={disabled} className={rowClass} data-testid={testId}>
        <span className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-r from-transparent via-primary/[0.05] to-transparent" />
        {inner}
      </button>
    );
  }
  return (
    <a href={installUrl} target="_blank" rel="noopener noreferrer" className={rowClass} data-testid={testId}>
      {inner}
    </a>
  );
}

export function ConnectWalletModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { wallet } = useWalletContext();
  const { hasProvider, connecting, error, connect, address } = wallet;
  const discovered = useEip6963Providers(isOpen);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  // Match discovered providers to the curated list by rdns.
  const byRdns = new Map<string, Eip6963ProviderDetail>();
  for (const d of discovered) byRdns.set(d.info.rdns, d);
  const knownRows = KNOWN_WALLETS.map((w) => ({
    wallet: w,
    detail: w.rdns.map((r) => byRdns.get(r)).find(Boolean) ?? null,
  }));
  const knownRdns = new Set(KNOWN_WALLETS.flatMap((w) => w.rdns));
  const extraDetected = discovered.filter((d) => !knownRdns.has(d.info.rdns));
  // Wallets the browser has but EIP-6963 didn't identify (older extensions).
  const showLegacyFallback = hasProvider && discovered.length === 0;
  const detectedCount = knownRows.filter((r) => r.detail).length + extraDetected.length;

  useEffect(() => {
    if (!isOpen) setPendingId(null);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      trackEvent('wallet_chooser_opened', { injected_provider_present: hasProvider });
    }
    wasOpen.current = isOpen;
  }, [isOpen, hasProvider]);

  // Auto-close on successful connection
  useEffect(() => {
    if (isOpen && address && !connecting) {
      const timer = setTimeout(onClose, 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen, address, connecting, onClose]);

  // Focus management + scroll lock while open; restore both on close.
  useEffect(() => {
    if (!isOpen) return undefined;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => {
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      (focusables?.[0] ?? cardRef.current)?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Trap Tab inside the dialog.
      if (e.key === 'Tab' && cardRef.current) {
        const focusables = Array.from(
          cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
        );
        if (focusables.length === 0) {
          e.preventDefault();
          cardRef.current.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        const inside = active ? cardRef.current.contains(active) : false;
        if (e.shiftKey && (!inside || active === first)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (!inside || active === last)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    if (isOpen) document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [isOpen, onClose]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const connectWith = async (id: string, provider?: Eip6963ProviderDetail['provider']) => {
    if (pendingId) return;
    trackEvent('wallet_provider_selected', { provider: id, detected: Boolean(provider) });
    setPendingId(id);
    try {
      await connect(provider);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {isOpen && (
        <div
          ref={overlayRef}
          onClick={handleBackdropClick}
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-wallet-title"
        >
          <motion.div
            ref={cardRef}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md bg-[#0a0a0a] border border-white/[0.08] rounded-[24px] overflow-hidden flex flex-col outline-none shadow-[0_32px_80px_-16px_rgba(0,0,0,0.9),0_0_60px_-30px_rgba(252,59,0,0.25),inset_0_1px_1px_rgba(255,255,255,0.08)]"
          >
            {/* Top hairline accent */}
            <div className="h-px w-full bg-gradient-to-r from-transparent via-primary/60 to-transparent" />

            <div className="flex items-start justify-between px-6 pt-6 pb-5">
              <div>
                <h2 id="connect-wallet-title" className="text-xl font-display font-medium text-white tracking-tight">
                  Connect Wallet
                </h2>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                  Arc mainnet · real funds
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-2 -mr-2 -mt-1 text-muted-foreground hover:text-white hover:bg-white/5 rounded-full transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 pb-6 space-y-5">
              {address && !connecting ? (
                <div className="text-center py-8 space-y-4">
                  <div className="w-16 h-16 bg-green-500/15 text-green-400 rounded-full mx-auto flex items-center justify-center border border-green-500/25">
                    <CheckCircle2 className="w-8 h-8" />
                  </div>
                  <h3 className="text-white font-medium">Connected successfully</h3>
                </div>
              ) : (
                <>
                  <div className="space-y-2.5">
                    {knownRows.map(({ wallet: w, detail }) => (
                      <WalletRow
                        key={w.id}
                        logo={w.logo}
                        name={w.name}
                        detected={!!detail}
                        pending={pendingId === w.id}
                        disabled={!!pendingId}
                        onConnect={detail ? () => connectWith(w.id, detail.provider) : undefined}
                        installUrl={w.installUrl}
                        testId={`wallet-option-${w.id}`}
                      />
                    ))}

                    {extraDetected.map((d) => (
                      <WalletRow
                        key={d.info.uuid}
                        logo={d.info.icon}
                        name={d.info.name}
                        detected
                        pending={pendingId === d.info.uuid}
                        disabled={!!pendingId}
                        onConnect={() => connectWith(d.info.uuid, d.provider)}
                        testId={`wallet-option-${d.info.rdns}`}
                      />
                    ))}

                    {showLegacyFallback && (
                      <button
                        type="button"
                        onClick={() => connectWith('injected')}
                        disabled={!!pendingId}
                        className="group relative w-full flex items-center gap-4 p-3 pr-4 rounded-2xl border bg-white/[0.02] border-white/[0.07] hover:border-primary/45 hover:bg-white/[0.045] transition-all duration-300"
                        data-testid="wallet-option-injected"
                      >
                        <span className="w-11 h-11 shrink-0 rounded-xl bg-primary/10 border border-primary/20 text-primary flex items-center justify-center">
                          <Wallet className="w-5 h-5" />
                        </span>
                        <span className="flex-1 text-left text-white font-medium text-[15px]">Browser Wallet</span>
                        {pendingId === 'injected' ? (
                          <Loader2 className="w-4 h-4 text-primary animate-spin" />
                        ) : (
                          <span className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-green-400">
                            <span className="w-1.5 h-1.5 bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
                            Detected
                          </span>
                        )}
                      </button>
                    )}
                  </div>

                  {detectedCount === 0 && !showLegacyFallback && (
                    <p className="font-mono text-[11px] leading-relaxed text-white/40 text-center pt-1">
                      No wallet extension detected; install one of the wallets above to continue.
                    </p>
                  )}

                  {error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3">
                      <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                      <p className="text-sm text-red-400 leading-relaxed flex-1">{error}</p>
                    </div>
                  )}

                  <div className="pt-4 border-t border-white/[0.06]">
                    <p className="text-xs text-muted-foreground leading-relaxed text-center">
                      This connects to Arc mainnet and can move real funds. Deposit USDC on Arc from an exchange or bridge.
                    </p>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
