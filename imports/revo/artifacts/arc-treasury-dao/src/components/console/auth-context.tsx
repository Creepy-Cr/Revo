import { createContext, useContext, ReactNode, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useRequestAuthNonce,
  useVerifyAuthSignature,
  useLogoutOperator,
  useGetAuthSession,
  getGetAuthSessionQueryKey,
  type AuthSession,
} from '@workspace/api-client-react';
import { useWalletContext } from './wallet-context';
import { useToast } from '@/hooks/use-toast';
import { createWalletClient, custom, type Hex } from 'viem';
import { getInjectedProvider, buildArcChain } from '@/lib/arc-wallet';
import { apiErrorMessage } from '@/lib/api-error';

type AuthContextType = {
  session: AuthSession | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  isSigningIn: boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { wallet, info } = useWalletContext();

  const { data: session, isLoading, isError } = useGetAuthSession({
    query: {
      queryKey: getGetAuthSessionQueryKey(),
      retry: false,
    },
  });

  const requestNonce = useRequestAuthNonce();
  const verifySig = useVerifyAuthSignature();
  const logout = useLogoutOperator();

  const isSigningIn = requestNonce.isPending || verifySig.isPending;

  const signIn = useCallback(async () => {
    if (!wallet.address || !info) {
      toast({ title: 'Connect wallet first', variant: 'destructive' });
      return;
    }

    try {
      const { message } = await requestNonce.mutateAsync({
        data: { address: wallet.address },
      });

      const provider = getInjectedProvider();
      if (!provider) throw new Error('No wallet provider found');

      const chain = buildArcChain(info);
      const walletClient = createWalletClient({ chain, transport: custom(provider) });

      const signature = await walletClient.signMessage({
        account: wallet.address as Hex,
        message,
      });

      await verifySig.mutateAsync({
        data: { address: wallet.address, signature },
      });

      // Every treasury read is tenant-scoped: drop the ENTIRE cache on a
      // session change so one wallet's data can never bleed into another's.
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: getGetAuthSessionQueryKey() });
      toast({ title: 'Signed in successfully' });
    } catch (error) {
      toast({
        title: 'Sign in failed',
        description: apiErrorMessage(error, 'Could not complete sign in.'),
        variant: 'destructive',
      });
    }
  }, [wallet.address, info, requestNonce, verifySig, queryClient, toast]);

  const signOut = useCallback(async () => {
    try {
      await logout.mutateAsync();
      // Purge all tenant-scoped data from the cache on sign-out.
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: getGetAuthSessionQueryKey() });
      toast({ title: 'Signed out' });
    } catch (error) {
      toast({
        title: 'Sign out failed',
        description: apiErrorMessage(error, 'Could not sign out.'),
        variant: 'destructive',
      });
    }
  }, [logout, queryClient, toast]);

  // Stable context identity so consumers only re-render on real auth changes.
  const value = useMemo(
    () => ({
      session: isError ? null : session || null,
      isLoading,
      signIn,
      signOut,
      isSigningIn,
    }),
    [session, isError, isLoading, signIn, signOut, isSigningIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuthContext must be used within AuthProvider');
  return ctx;
}
