import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChainParams } from '@workspace/api-client-react';
import { ensureArcChain, getInjectedProvider, setActiveProvider, type Eip1193Provider } from '@/lib/arc-wallet';

interface ArcWalletState {
  address: string | null;
  /** Wallet's current chain id as a hex string (from eth_chainId events). */
  chainIdHex: string | null;
  connecting: boolean;
  error: string | null;
}

/** Wallet events are untrusted input: coerce only well-formed payloads. */
function asLowerString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;
}
function firstAccount(payload: unknown): string | null {
  return Array.isArray(payload) ? asLowerString(payload[0]) : null;
}

/**
 * Connection state for the user's injected (EIP-1193) wallet. Connection is
 * detected silently on mount via eth_accounts; `connect` prompts and then
 * switches/adds Arc Testnet so the user can never sign against another chain
 * from this UI.
 *
 * The provider lives in React state so account/chain listeners are
 * (re)attached to whichever provider is actually active - including one the
 * user picked from the EIP-6963 modal after mount. A monotonically bumped
 * generation guards every async completion (initial snapshot, connect,
 * switchChain) so a provider replaced mid-flight can never write its stale
 * result into the new provider's state.
 */
export function useArcWallet(info: ChainParams | undefined) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(() => getInjectedProvider());
  const [state, setState] = useState<ArcWalletState>({
    address: null,
    chainIdHex: null,
    connecting: false,
    error: null,
  });

  // Bumped every time the active provider is replaced. Async work captures
  // the generation at start and may only commit if it is still current.
  const generationRef = useRef(0);

  const adoptProvider = useCallback((next: Eip1193Provider) => {
    generationRef.current += 1;
    setProvider(next);
    // A new provider's accounts/chain are unknown until its own snapshot or
    // events say otherwise - never carry the previous wallet's identity over.
    setState({ address: null, chainIdHex: null, connecting: false, error: null });
    return generationRef.current;
  }, []);

  // Wallets that inject window.ethereum after our first render (common with
  // slow extension startup) are picked up here.
  useEffect(() => {
    if (provider) return;
    const found = getInjectedProvider();
    if (found) setProvider(found);
  }, [provider]);

  // Subscribe to the ACTIVE provider. Re-runs whenever the user picks a
  // different wallet, so accountsChanged/chainChanged always land in state.
  useEffect(() => {
    if (!provider) return;
    const generation = generationRef.current;

    // Events are fresher than the initial snapshot: if one arrives while the
    // snapshot RPCs are still in flight, the snapshot must not clobber it.
    let sawAccountsEvent = false;
    let sawChainEvent = false;
    let cancelled = false;

    void (async () => {
      try {
        const [accounts, chainId] = await Promise.all([
          provider.request({ method: 'eth_accounts' }),
          provider.request({ method: 'eth_chainId' }),
        ]);
        if (cancelled || generationRef.current !== generation) return;
        setState((s) => ({
          ...s,
          address: sawAccountsEvent ? s.address : firstAccount(accounts),
          chainIdHex: sawChainEvent ? s.chainIdHex : asLowerString(chainId),
        }));
      } catch {
        // A wallet that refuses eth_accounts just stays disconnected.
      }
    })();

    const onAccounts = (...args: unknown[]) => {
      if (generationRef.current !== generation) return;
      sawAccountsEvent = true;
      setState((s) => ({ ...s, address: firstAccount(args[0]) }));
    };
    const onChain = (...args: unknown[]) => {
      if (generationRef.current !== generation) return;
      sawChainEvent = true;
      const next = asLowerString(args[0]);
      // Ignore malformed payloads (some wallets emit numbers) rather than
      // wiping a known-good chain id.
      if (next !== null) setState((s) => ({ ...s, chainIdHex: next }));
    };
    provider.on?.('accountsChanged', onAccounts);
    provider.on?.('chainChanged', onChain);
    return () => {
      cancelled = true;
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('chainChanged', onChain);
    };
  }, [provider]);

  const connect = useCallback(async (chosen?: Eip1193Provider) => {
    const active = chosen ?? getInjectedProvider();
    if (!active || !info) return;
    let generation = generationRef.current;
    if (chosen) {
      setActiveProvider(chosen);
      generation = adoptProvider(chosen);
    }
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const accounts = await active.request({ method: 'eth_requestAccounts' });
      await ensureArcChain(active, info);
      const chainId = await active.request({ method: 'eth_chainId' });
      if (generationRef.current !== generation) return; // provider replaced mid-flight
      setState((s) => ({
        ...s,
        address: firstAccount(accounts),
        chainIdHex: asLowerString(chainId),
        connecting: false,
      }));
    } catch (error) {
      if (generationRef.current !== generation) return;
      const message =
        (error as { message?: string } | null)?.message ?? 'Wallet connection was rejected';
      setState((s) => ({ ...s, connecting: false, error: message }));
    }
  }, [info, adoptProvider]);

  const switchChain = useCallback(async () => {
    const active = provider ?? getInjectedProvider();
    if (!active || !info) return;
    const generation = generationRef.current;
    try {
      await ensureArcChain(active, info);
      const chainId = await active.request({ method: 'eth_chainId' });
      if (generationRef.current !== generation) return;
      setState((s) => ({ ...s, chainIdHex: asLowerString(chainId), error: null }));
    } catch (error) {
      if (generationRef.current !== generation) return;
      const message = (error as { message?: string } | null)?.message ?? 'Network switch was rejected';
      setState((s) => ({ ...s, error: message }));
    }
  }, [provider, info]);

  const disconnect = useCallback(() => {
    setState((s) => ({ ...s, address: null, chainIdHex: null, error: null }));
  }, []);

  const onArcChain = Boolean(info && state.chainIdHex === info.chainIdHex.toLowerCase());

  // Stable identity: this object feeds the wallet context value. Without the
  // memo, every provider render (e.g. the connect modal toggling) allocates a
  // fresh object and broadcasts to every wallet-context consumer.
  return useMemo(
    () => ({
      hasProvider: provider !== null,
      /** True once chain params have loaded - network checks are meaningless before. */
      chainReady: info !== undefined,
      address: state.address,
      onArcChain,
      connecting: state.connecting,
      error: state.error,
      connect,
      switchChain,
      disconnect,
    }),
    [
      provider,
      info,
      state.address,
      onArcChain,
      state.connecting,
      state.error,
      connect,
      switchChain,
      disconnect,
    ],
  );
}
