import { memo } from 'react';
import {
  useGetTreasuryCrosschainBalance,
  getGetTreasuryCrosschainBalanceQueryKey,
  type CrosschainBalance,
} from '@workspace/api-client-react';
import { StatusTag } from './status-tag';

/**
 * The treasury's Circle Gateway balance, read through Circle App Kit.
 *
 * The copy here is deliberate. A Gateway balance is not a wallet balance, so an
 * empty Gateway must never render as "the treasury is empty" - the two are
 * different pots of money and the panel says so outright. Likewise a failed
 * read renders as a failed read, not as zero.
 */
function CrosschainPanelImpl() {
  const { data, isLoading, isError } = useGetTreasuryCrosschainBalance({
    query: {
      queryKey: getGetTreasuryCrosschainBalanceQueryKey(),
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
  });

  return (
    <div className="console-card flex flex-col" data-testid="panel-crosschain">
      <div className="flex items-center justify-between gap-3 mb-6 shrink-0">
        <h3 className="text-[10px] font-mono tracking-[0.1em] text-muted-foreground uppercase flex items-center gap-2">
          <span className="text-white/40">02 //</span> CROSS-CHAIN
        </h3>
        <StatusTag label="CIRCLE GATEWAY" tone="accent" />
      </div>

      <Body data={data} isLoading={isLoading} isError={isError} />

      <p className="mt-6 pt-5 border-t border-white/[0.08] text-[11px] text-muted-foreground/70 leading-relaxed">
        Read live from Circle Gateway via App Kit. Gateway is a separate pot from
        the treasury's Arc custody balance: USDC only appears here once it has
        been deposited into Gateway, where it becomes spendable on any supported
        chain.
      </p>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
}: {
  data?: CrosschainBalance;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground leading-relaxed" data-testid="text-crosschain-loading">
        Reading Circle Gateway…
      </div>
    );
  }

  // A read that failed is reported as a failure. No zeros stand in for it -
  // including a reading that arrived without a total, which is not a zero
  // balance but an absent one.
  if (isError || !data || !data.available || data.totalConfirmed === undefined) {
    return (
      <div className="border-y border-white/[0.08] py-8 px-2 text-center space-y-2" data-testid="text-crosschain-unavailable">
        <StatusTag label="UNAVAILABLE" tone="warning" />
        <p className="text-[13px] text-muted-foreground leading-relaxed max-w-sm mx-auto">
          Circle Gateway could not be reached, so there is no balance to show.
          This says nothing about the treasury's Arc balance.
        </p>
        {data?.error && (
          <p className="font-mono text-[10px] text-muted-foreground/60 break-words">{data.error}</p>
        )}
      </div>
    );
  }

  const funded = data.chains.filter((c) => Number(c.confirmedBalance) > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground">
          Total in Gateway
        </span>
        <span className="text-2xl font-display font-medium text-white tabular-nums" data-testid="text-crosschain-total">
          {data.totalConfirmed} <span className="text-sm text-muted-foreground">USDC</span>
        </span>
      </div>

      {data.stale && (
        <StatusTag label="STALE READING" tone="warning" />
      )}

      {!data.deposited ? (
        <div className="border-y border-white/[0.08] py-8 px-2 text-center" data-testid="text-crosschain-empty">
          <p className="text-[13px] text-muted-foreground leading-relaxed max-w-sm mx-auto">
            Nothing deposited into Circle Gateway yet. The treasury's Arc balance
            is unaffected; this panel only tracks funds handed to Gateway for
            cross-chain spending.
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground/60">
            {data.chains.length} chains monitored
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {funded.map((chain) => (
            <div
              key={chain.chain}
              className="flex items-center justify-between gap-4 py-2 border-b border-white/[0.05] last:border-b-0"
              data-testid={`row-crosschain-${chain.chain}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-[14px] text-white/90 truncate">{chain.label}</span>
                {chain.isArc && <StatusTag label="SETTLEMENT" tone="accent" />}
              </div>
              <span className="text-sm text-white/80 tabular-nums shrink-0">
                {chain.confirmedBalance}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const CrosschainPanel = memo(CrosschainPanelImpl);
