import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusTag } from './status-tag';
import {
  useGetTreasuryWalletPosition,
  getGetTreasuryWalletPositionQueryKey,
  useClaimTreasuryDeposit,
  useRequestTreasuryWithdrawal,
  getGetTreasuryDashboardQueryKey,
  useGetTreasuryWalletInfo,
  getGetTreasuryWalletInfoQueryKey,
  type TreasuryWalletInfo,
} from '@workspace/api-client-react';
import { createPublicClient, createWalletClient, custom, formatUnits, parseUnits, type Hex } from 'viem';
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, Copy, Check, Droplets, ShieldAlert } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useWalletContext } from './wallet-context';
import { useAuthContext } from './auth-context';
import { buildArcChain, getInjectedProvider, shortAddress, usdcAbi, withdrawalAuthMessage } from '@/lib/arc-wallet';
import { apiErrorMessage } from '@/lib/api-error';

const AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;

type DepositPhase = 'idle' | 'signing' | 'confirming' | 'crediting';

export function WalletPanel() {
  const { wallet, openConnectModal } = useWalletContext();

  // The tenant-scoped custody wallet (deposit address) is auth-required -
  // this panel only mounts inside the signed-in console, so fetching here
  // (not in WalletProvider, which also serves the signed-out gate) keeps
  // the gate free of 401s.
  const { data: info } = useGetTreasuryWalletInfo({
    query: {
      queryKey: getGetTreasuryWalletInfoQueryKey(),
      staleTime: Infinity,
    },
  });

  // Disconnected is a real state a user lands in (the Wallet tab is the
  // first stop for funding) - it gets a directed prompt, never a blank card.
  if (!wallet.address || !info) {
    return (
      <div className="console-card flex flex-col" data-testid="panel-wallet-disconnected">
        <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2 mb-8 shrink-0">
          <span className="text-white/40">01 //</span> WALLET
        </h3>
        <div className="border-y border-white/[0.08] py-10 px-2 text-center space-y-5">
          <h4 className="text-2xl font-display font-medium text-white tracking-tight">Connect a wallet to fund the treasury.</h4>
          <p className="text-[13px] text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Deposits are sent from your own wallet; connect it to see your
            USDC balance and move funds into custody. Withdrawals come back to
            the same address.
          </p>
          <button
            onClick={openConnectModal}
            data-testid="button-wallet-connect-cta"
            className="inline-flex items-center gap-2 px-6 py-3 text-[11px] font-mono uppercase tracking-[0.12em] font-bold text-white bg-primary hover:bg-orange-600 rounded-[4px] transition-all shadow-[0_4px_16px_rgba(252,59,0,0.35)]"
          >
            CONNECT WALLET
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="console-card flex flex-col h-full">
      <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2 mb-6 shrink-0">
        <span className="text-white/40">01 //</span> WALLET
      </h3>
      <ConnectedPanel info={info} address={wallet.address} onArcChain={wallet.onArcChain} switchChain={wallet.switchChain} walletError={wallet.error} />
    </div>
  );
}

function ConnectedPanel({
  info,
  address,
  onArcChain,
  switchChain,
  walletError,
}: {
  info: TreasuryWalletInfo;
  address: string;
  onArcChain: boolean;
  switchChain: () => Promise<void>;
  walletError: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { session } = useAuthContext();
  const chain = useMemo(() => buildArcChain(info), [info]);

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [depositPhase, setDepositPhase] = useState<DepositPhase>('idle');
  const [withdrawSigning, setWithdrawSigning] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: position } = useGetTreasuryWalletPosition(address, {
    query: {
      queryKey: getGetTreasuryWalletPositionQueryKey(address),
      refetchInterval: 10_000,
    },
  });

  const { data: balanceMicro } = useQuery({
    queryKey: ['arc-usdc-balance', address, onArcChain],
    enabled: onArcChain,
    refetchInterval: 15_000,
    queryFn: async () => {
      const provider = getInjectedProvider();
      if (!provider) throw new Error('Wallet provider unavailable');
      const client = createPublicClient({ chain, transport: custom(provider) });
      const value = await client.readContract({
        address: info.usdcAddress as Hex,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [address as Hex],
      });
      return value.toString();
    },
  });

  const claim = useClaimTreasuryDeposit();
  const withdraw = useRequestTreasuryWithdrawal();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getGetTreasuryDashboardQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetTreasuryWalletPositionQueryKey(address) });
    void queryClient.invalidateQueries({ queryKey: ['arc-usdc-balance', address, onArcChain] });
  };

  const walletBalance = balanceMicro !== undefined ? Number(formatUnits(BigInt(balanceMicro), info.usdcDecimals)) : null;
  const withdrawable = position?.netDepositedUsdc ?? 0;

  const depositBusy = depositPhase !== 'idle';
  const depositValid = AMOUNT_PATTERN.test(depositAmount) && Number(depositAmount) > 0;
  const withdrawValid = AMOUNT_PATTERN.test(withdrawAmount) && Number(withdrawAmount) > 0;

  const handleDeposit = async () => {
    const provider = getInjectedProvider();
    if (!provider || !depositValid) return;
    setDepositPhase('signing');
    try {
      const walletClient = createWalletClient({ chain, transport: custom(provider) });
      const hash = await walletClient.writeContract({
        account: address as Hex,
        chain,
        address: info.usdcAddress as Hex,
        abi: usdcAbi,
        functionName: 'transfer',
        args: [info.treasuryAddress as Hex, parseUnits(depositAmount, info.usdcDecimals)],
      });
      setDepositPhase('confirming');
      const publicClient = createPublicClient({ chain, transport: custom(provider) });
      await publicClient.waitForTransactionReceipt({ hash });
      setDepositPhase('crediting');
      claim.mutate(
        { data: { txHash: hash } },
        {
          onSuccess: (transfer) => {
            setDepositPhase('idle');
            setDepositAmount('');
            toast({
              title: 'Deposit Credited',
              description: `${transfer.amountUsdc} testnet USDC verified on-chain and added to the treasury.`,
            });
            invalidate();
          },
          onError: (error) => {
            setDepositPhase('idle');
            toast({
              title: 'Deposit Not Credited',
              description: apiErrorMessage(error, 'The transaction could not be verified on Arc Testnet.'),
              variant: 'destructive',
            });
          },
        },
      );
    } catch (error) {
      setDepositPhase('idle');
      toast({
        title: 'Deposit Cancelled',
        description: (error as { shortMessage?: string; message?: string } | null)?.shortMessage
          ?? (error as { message?: string } | null)?.message
          ?? 'The transaction was not sent.',
        variant: 'destructive',
      });
    }
  };

  const handleWithdraw = async () => {
    const provider = getInjectedProvider();
    if (!provider || !withdrawValid) return;

    let signature: string;
    const issuedAt = new Date().toISOString();
    setWithdrawSigning(true);
    try {
      const micro = parseUnits(withdrawAmount, info.usdcDecimals);
      const message = withdrawalAuthMessage(
        address,
        formatUnits(micro, info.usdcDecimals),
        issuedAt,
        info.chainId,
      );
      const walletClient = createWalletClient({ chain, transport: custom(provider) });
      signature = await walletClient.signMessage({ account: address as Hex, message });
    } catch (error) {
      setWithdrawSigning(false);
      toast({
        title: 'Withdrawal Cancelled',
        description: (error as { shortMessage?: string; message?: string } | null)?.shortMessage
          ?? (error as { message?: string } | null)?.message
          ?? 'The authorization was not signed.',
        variant: 'destructive',
      });
      return;
    }
    setWithdrawSigning(false);

    withdraw.mutate(
      { data: { address, amountUsdc: Number(withdrawAmount), issuedAt, signature } },
      {
        onSuccess: (transfer) => {
          setWithdrawAmount('');
          toast({
            title: 'Withdrawal Sent On-Chain',
            description: `${transfer.amountUsdc} testnet USDC sent to your wallet (tx confirmed).`,
          });
          invalidate();
        },
        onError: (error) => {
          toast({
            title: 'Withdrawal Failed',
            description: apiErrorMessage(error, 'The withdrawal could not be executed on Arc Testnet.'),
            variant: 'destructive',
          });
          invalidate();
        },
      },
    );
  };

  const copyTreasury = async () => {
    await navigator.clipboard.writeText(info.treasuryAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-8 flex-1 flex flex-col">
      {walletError && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-[4px] text-[11px] font-mono text-red-400 leading-relaxed uppercase tabular-nums">
          {walletError}
        </div>
      )}

      {/* Balances Ledger */}
      <div className="flex flex-col border border-white/[0.08] rounded-[2px] overflow-hidden">
        <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-white/[0.08]">
          <div className="flex-1 p-4 bg-[#080808] flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground mb-3">IN WALLET</div>
            <div className="text-2xl font-display tabular-nums text-white tracking-tight leading-tight">
              {walletBalance === null ? '-' : walletBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              <span className="text-muted-foreground text-[10px] font-mono ml-2 uppercase">USDC</span>
            </div>
          </div>
          <div className="flex-1 p-4 bg-[#080808] flex flex-col justify-between">
            <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground mb-3">WITHDRAWABLE</div>
            <div className="text-2xl font-display tabular-nums text-primary tracking-tight leading-tight">
              {withdrawable.toLocaleString('en-US', { maximumFractionDigits: 6 })}
              <span className="text-primary/50 text-[10px] font-mono ml-2 uppercase">USDC</span>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-4">
        {/* Deposit */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="Amount to deposit"
              inputMode="decimal"
              disabled={depositBusy || !onArcChain || !session}
              className={`flex-1 min-w-0 bg-[#0a0a0a] border border-white/[0.08] rounded-[4px] px-4 py-3 text-[13px] font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-primary/50 disabled:opacity-50 transition-colors ${!session ? 'cursor-not-allowed' : ''}`}
            />
            <button
              onClick={() => void handleDeposit()}
              disabled={!depositValid || depositBusy || !onArcChain || !session}
              className="px-5 py-3 flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.1em] font-bold text-white bg-primary hover:bg-orange-600 rounded-[4px] transition-all disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap shadow-sm"
            >
              {!session ? <ShieldAlert className="w-3.5 h-3.5 text-white/50" /> : <ArrowDownToLine className="w-3.5 h-3.5" />}
              {depositPhase === 'signing'
                ? 'SIGN...'
                : depositPhase === 'confirming'
                  ? 'CONFIRM...'
                  : depositPhase === 'crediting'
                    ? 'CREDIT...'
                    : !session ? 'SIGN IN' : 'DEPOSIT'}
            </button>
          </div>
          {!onArcChain && (
            <div className="text-[10px] font-mono uppercase tracking-widest text-primary/80">
              SWITCH TO {info.chainName}
            </div>
          )}
        </div>

        {/* Withdraw */}
        <div className="flex gap-2">
          <input
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder={`Up to ${withdrawable.toLocaleString('en-US', { maximumFractionDigits: 6 })}`}
            inputMode="decimal"
            disabled={withdrawSigning || withdraw.isPending || !session}
            className={`flex-1 min-w-0 bg-[#0a0a0a] border border-white/[0.08] rounded-[4px] px-4 py-3 text-[13px] font-mono text-white placeholder:text-white/20 focus:outline-none focus:border-primary/50 disabled:opacity-50 transition-colors ${!session ? 'cursor-not-allowed' : ''}`}
          />
          <button
            onClick={() => void handleWithdraw()}
            disabled={!withdrawValid || withdrawSigning || withdraw.isPending || !onArcChain || !session}
            className="px-5 py-3 flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.1em] font-bold text-white/90 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] rounded-[4px] transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap"
          >
            {!session ? <ShieldAlert className="w-3.5 h-3.5 text-white/50" /> : <ArrowUpFromLine className="w-3.5 h-3.5" />}
            {withdrawSigning ? 'SIGN...' : withdraw.isPending ? 'SENDING...' : !session ? 'SIGN IN' : 'WITHDRAW'}
          </button>
        </div>
      </div>

      {/* Footer Info */}
      <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground pt-4 border-t border-white/[0.08] mt-2">
        <button onClick={() => void copyTreasury()} className="flex items-center gap-1.5 hover:text-white transition-colors">
          {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          <span>TREASURY {shortAddress(info.treasuryAddress)}</span>
        </button>
        {info.faucetUrl && (
          <a href={info.faucetUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-primary transition-colors">
            <Droplets className="w-3.5 h-3.5" /> FAUCET
          </a>
        )}
      </div>

      {/* Recent transfers */}
      {position && position.transfers.length > 0 && (
        <div className="space-y-0 pt-4 border-t border-white/[0.08] mt-auto">
          <div className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground mb-3">RECENT TRANSFERS</div>
          <div className="flex flex-col border border-white/[0.04] rounded-[2px] overflow-hidden">
            {position.transfers.slice(0, 4).map((t, i) => (
              <div key={t.id} className={`flex items-center justify-between bg-[#080808] hover:bg-[#0a0a0a] transition-colors px-3 py-2.5 ${i !== 0 ? 'border-t border-white/[0.04]' : ''}`}>
                <div className="flex items-center gap-3 text-[11px] font-mono text-white/80 tabular-nums">
                  {t.direction === 'deposit' ? (
                    <ArrowDownToLine className="w-3.5 h-3.5 text-green-400" />
                  ) : (
                    <ArrowUpFromLine className="w-3.5 h-3.5 text-primary" />
                  )}
                  <span>
                    {t.amountUsdc.toLocaleString('en-US', { maximumFractionDigits: 6 })}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <StatusTag
                    label={t.status}
                    tone={t.status === 'confirmed' ? 'positive' : t.status === 'pending' ? 'warning' : 'negative'}
                    pulse={t.status === 'pending'}
                  />
                  {t.explorerTxUrl ? (
                    <a href={t.explorerTxUrl} target="_blank" rel="noreferrer" className="text-white/20 hover:text-muted-foreground transition-colors">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  ) : (
                    <div className="w-3.5" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
