import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useWalletContext } from './wallet-context';
import { useAuthContext } from './auth-context';
import { shortAddress } from '@/lib/arc-wallet';

/**
 * Full-screen operator gate shown on /app while signed out. No treasury data
 * is fetched (or fetchable) behind it - every treasury endpoint is
 * tenant-scoped and auth-required on the server.
 */
export function AccessGate() {
  const { wallet, openConnectModal } = useWalletContext();
  const { address, connecting, onArcChain, switchChain, chainReady } = wallet;
  const { signIn, isSigningIn } = useAuthContext();

  const step = !address ? 1 : !onArcChain ? 2 : 3;

  // Auto-prompt the network switch the moment a connected wallet is seen on
  // the wrong chain - at most once per address (a Set, so toggling
  // A → B → A never re-prompts A), leaving the button as the manual retry.
  const autoSwitchedFor = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!address || !chainReady || onArcChain) return;
    if (autoSwitchedFor.current.has(address)) return;
    autoSwitchedFor.current.add(address);
    void switchChain();
  }, [address, chainReady, onArcChain, switchChain]);

  const cta = () => {
    if (step === 1) return openConnectModal();
    if (step === 2) return void switchChain();
    return void signIn();
  };

  const ctaLabel =
    step === 1
      ? connecting
        ? 'CONNECTING…'
        : 'CONNECT WALLET'
      : step === 2
        ? 'SWITCH TO ARC'
        : isSigningIn
          ? 'AWAITING SIGNATURE…'
          : 'SIGN IN & ENTER CONSOLE';

  const busy = connecting || isSigningIn;

  const rows = [
    {
      no: '01',
      label: 'Connect a wallet',
      meta: address ? shortAddress(address) : 'EIP-6963 · any injected wallet',
      state: address ? 'done' : step === 1 ? 'active' : 'idle',
    },
    {
      no: '02',
      label: 'Arc mainnet network',
      meta: !address
        ? 'chain 5042'
        : !chainReady
          ? 'checking network…'
          : onArcChain
            ? 'chain 5042 · verified'
            : 'wrong network detected',
      state: address && onArcChain ? 'done' : step === 2 ? 'active' : 'idle',
    },
    {
      no: '03',
      label: 'Verify ownership',
      meta: 'one signature · zero gas',
      state: step === 3 ? 'active' : 'idle',
    },
  ] as const;

  return (
    <div className="min-h-[100dvh] bg-[#000000] text-white flex flex-col selection:bg-primary/30 selection:text-white">
      {/* Top hairline strip */}
      <div className="flex items-center justify-between px-5 md:px-8 py-4 border-b border-white/5">
        <span className="font-display font-medium tracking-tight text-lg">Revo Treasury</span>
        <span className="flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-[0.15em] text-yellow-500 uppercase">
          <span className="w-1.5 h-1.5 bg-yellow-500 animate-pulse shadow-[0_0_8px_rgba(234,179,8,0.5)]" />
          MAINNET
        </span>
      </div>

      <div className="flex-1 grid place-items-center px-4 py-10 relative overflow-hidden">
        <div className="absolute top-[30%] left-1/2 -translate-x-1/2 w-[700px] h-[500px] bg-primary/5 blur-[140px] rounded-full pointer-events-none" />

        <div className="relative w-full max-w-lg">
          <p className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase mb-4">
            <span className="text-white/40">00 //</span> OPERATOR ACCESS
          </p>
          <h1 className="font-display font-medium tracking-tight text-3xl md:text-[2.6rem] leading-[1.05] mb-3">
            This console is
            <br />
            operator-gated.
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed mb-8 max-w-md">
            Every treasury on Revo is private to the wallet that runs it. Sign in to open
            yours; a first-time wallet gets its own treasury provisioned on the spot.
          </p>

          <div className="border-t border-white/10">
            {rows.map((row) => (
              <div
                key={row.no}
                className="flex items-baseline gap-4 py-3.5 border-b border-white/5"
                data-testid={`gate-step-${row.no}`}
              >
                <span
                  className={`text-[10px] font-mono font-bold tracking-[0.1em] tabular-nums ${
                    row.state === 'done'
                      ? 'text-green-400'
                      : row.state === 'active'
                        ? 'text-primary'
                        : 'text-white/25'
                  }`}
                >
                  {row.state === 'done' ? '■' : '□'} {row.no}
                </span>
                <span
                  className={`text-sm font-medium tracking-tight ${
                    row.state === 'idle' ? 'text-white/40' : 'text-white'
                  }`}
                >
                  {row.label}
                </span>
                <span className="ml-auto text-[10px] font-mono tracking-[0.08em] text-muted-foreground uppercase tabular-nums text-right">
                  {row.meta}
                </span>
              </div>
            ))}
          </div>

          <button
            onClick={cta}
            disabled={busy}
            data-testid="button-gate-cta"
            className="mt-8 w-full flex items-center justify-center gap-2.5 bg-primary hover:bg-orange-600 disabled:opacity-60 disabled:cursor-not-allowed text-white h-12 text-[12px] font-mono font-bold tracking-[0.18em] uppercase transition-colors"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {ctaLabel}
          </button>

          <p className="mt-4 text-[10px] font-mono tracking-[0.08em] text-white/30 uppercase leading-relaxed">
            Signature proves wallet ownership only: no gas, no transaction, no custody of your keys.
          </p>
        </div>
      </div>
    </div>
  );
}
