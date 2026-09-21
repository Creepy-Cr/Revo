import { useState, useRef, useEffect } from 'react';
import { Wallet, Loader2, Copy, ExternalLink, RefreshCw, Power, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useWalletContext } from './wallet-context';
import { useAuthContext } from './auth-context';
import { shortAddress } from '@/lib/arc-wallet';
import { AnimatePresence, motion } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';

export function WalletConnectButton() {
  const { wallet, info, openConnectModal } = useWalletContext();
  const { address, connecting, onArcChain, disconnect, switchChain } = wallet;
  const { session, signIn, signOut, isSigningIn } = useAuthContext();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const copyAddress = async (value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        if (!ok) throw new Error('execCommand copy failed');
      }
      toast({ title: 'Address copied' });
      setDropdownOpen(false);
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Select the address in the menu and copy it manually.',
        variant: 'destructive',
      });
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (connecting) {
    return (
      <button disabled className="flex items-center gap-2 bg-primary/50 text-white px-4 py-1.5 rounded-full text-sm font-medium opacity-80 cursor-not-allowed leading-relaxed">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Connecting</span>
      </button>
    );
  }

  if (!address) {
    return (
      <button 
        onClick={openConnectModal}
        className="flex items-center gap-2 bg-primary hover:bg-orange-600 text-white px-4 py-1.5 rounded-full text-sm font-medium transition-all hover:shadow-[0_2px_12px_rgba(249,115,22,0.35)] leading-relaxed"
      >
        <Wallet className="w-4 h-4" />
        <span>Connect Wallet</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {!session ? (
        <button
          onClick={() => void signIn()}
          disabled={isSigningIn || !onArcChain}
          className="flex items-center gap-1.5 bg-secondary hover:bg-[#332b25] text-white px-3 py-1.5 rounded-full border border-white/5 transition-colors disabled:opacity-50 text-[11px] font-mono font-bold tracking-[0.1em] uppercase leading-relaxed"
        >
          {isSigningIn ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5 text-primary" />}
          <span>Sign In</span>
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-r border-white/10 mr-1">
          <ShieldCheck className="w-3.5 h-3.5 text-green-400" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.15em] text-white/90">{session.role}</span>
        </div>
      )}

      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="flex items-center gap-2 bg-secondary hover:bg-[#332b25] text-white px-3 py-1.5 rounded-full border border-white/5 transition-colors text-[11px] font-mono font-bold tracking-[0.1em] leading-relaxed"
        >
          <div className={`w-2 h-2 rounded-full ${onArcChain ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.5)]' : 'bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.5)]'}`} />
          <span className="text-sm font-medium font-mono leading-relaxed tabular-nums">{onArcChain ? shortAddress(address) : 'Wrong network'}</span>
        </button>

        <AnimatePresence>
          {dropdownOpen && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full mt-2 w-72 console-card rounded-2xl border border-border bg-card shadow-xl overflow-hidden z-50"
            >
              <div className="p-4 border-b border-border">
                <p className="text-xs text-muted-foreground mb-1 uppercase tracking-[0.1em]">Connected Wallet</p>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-mono text-white/90 truncate mr-2 select-all leading-relaxed tabular-nums">{address}</span>
                  <button
                    onClick={() => void copyAddress(address)}
                    className="p-1.5 text-muted-foreground hover:text-white hover:bg-white/10 rounded-md transition-colors"
                    title="Copy address"
                    aria-label="Copy address"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
                {session && (
                  <div className="mt-3 text-xs bg-black/20 p-2 rounded border border-white/5">
                    <span className="text-muted-foreground">Role: </span>
                    <span className="text-white/80 font-medium capitalize">{session.role}</span>
                  </div>
                )}
              </div>

              <div className="p-2">
                {!onArcChain && (
                  <button
                    onClick={() => {
                      switchChain();
                      setDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-primary hover:text-orange-300 hover:bg-primary/10 rounded-lg transition-colors text-left leading-relaxed"
                  >
                    <RefreshCw className="w-4 h-4" />
                    <span>Switch to Arc</span>
                  </button>
                )}
                {info?.explorerUrl && (
                  <a
                    href={`${info.explorerUrl}/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setDropdownOpen(false)}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground hover:text-white hover:bg-white/5 rounded-lg transition-colors leading-relaxed"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>View on Explorer</span>
                  </a>
                )}
                {session && (
                  <>
                    <button
                      onClick={() => {
                        void signIn();
                        setDropdownOpen(false);
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 text-sm text-green-400 hover:text-green-300 hover:bg-green-500/10 rounded-lg transition-colors text-left leading-relaxed"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      <span>Re-authenticate</span>
                    </button>
                    <button
                      onClick={() => {
                        void signOut();
                        setDropdownOpen(false);
                      }}
                      className="w-full flex items-center gap-3 px-3 py-2 text-sm text-primary hover:text-orange-300 hover:bg-primary/10 rounded-lg transition-colors text-left leading-relaxed"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      <span>Sign Out</span>
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    disconnect();
                    setDropdownOpen(false);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors text-left leading-relaxed"
                >
                  <Power className="w-4 h-4" />
                  <span>Disconnect</span>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
