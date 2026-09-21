import { createContext, useContext, useState, useMemo, useCallback, ReactNode } from 'react';
import { useGetChainParams, getGetChainParamsQueryKey, type ChainParams } from '@workspace/api-client-react';
import { useArcWallet } from '@/hooks/use-arc-wallet';
import { ConnectWalletModal } from '@/components/console/connect-wallet-modal';

type WalletContextType = {
  /** Public Arc chain facts - available BEFORE sign-in (the access
   *  gate needs them to detect and switch networks). The tenant-scoped
   *  custody address lives on the authed GET /treasury/wallet instead. */
  info: ChainParams | undefined;
  wallet: ReturnType<typeof useArcWallet>;
  openConnectModal: () => void;
  closeConnectModal: () => void;
};

const WalletContext = createContext<WalletContextType | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { data: info } = useGetChainParams({
    query: {
      queryKey: getGetChainParamsQueryKey(),
      staleTime: Infinity,
    }
  });

  const wallet = useArcWallet(info);
  const [modalOpen, setModalOpen] = useState(false);

  const openConnectModal = useCallback(() => setModalOpen(true), []);
  const closeConnectModal = useCallback(() => setModalOpen(false), []);

  // Stable context identity: without this, every provider render (e.g. the
  // modal toggling) broadcasts a fresh value object to ALL consumers.
  const value = useMemo(
    () => ({ info, wallet, openConnectModal, closeConnectModal }),
    [info, wallet, openConnectModal, closeConnectModal],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      <ConnectWalletModal isOpen={modalOpen} onClose={closeConnectModal} />
    </WalletContext.Provider>
  );
}

export function useWalletContext() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWalletContext must be used within WalletProvider');
  return ctx;
}
