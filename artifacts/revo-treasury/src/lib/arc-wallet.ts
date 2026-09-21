import { defineChain, parseAbi, type Chain } from 'viem';
import type { ChainParams } from '@workspace/api-client-react';

/**
 * Browser-side Arc wallet plumbing. All chain parameters come from
 * the API (public `GET /chain/params`) so the frontend never hardcodes chain
 * facts that could drift from the server's mainnet enforcement.
 * TreasuryWalletInfo (authed) is a superset of ChainParams, so both satisfy
 * these helpers.
 */

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

/** EIP-6963 multi-wallet discovery types. */
export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/**
 * The wallet the user explicitly picked in the connect modal (EIP-6963).
 * All signing paths resolve through getInjectedProvider(), so routing the
 * selection here keeps every existing call site pointed at the right wallet
 * even when several extensions are installed.
 */
let activeProvider: Eip1193Provider | null = null;

export function setActiveProvider(provider: Eip1193Provider | null): void {
  activeProvider = provider;
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  if (activeProvider) return activeProvider;
  const eth = (window as { ethereum?: Eip1193Provider }).ethereum;
  return eth ?? null;
}

export const usdcAbi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]);

export const ARC_CHAIN_ID = 5042;
export const ARC_CHAIN_NAME = 'Arc';
export const ARC_EXPLORER_URL = 'https://arc-scan.org';

export function buildArcChain(info: ChainParams): Chain {
  return defineChain({
    id: ARC_CHAIN_ID,
    name: ARC_CHAIN_NAME,
    // Arc's NATIVE USDC uses 18 decimals; the ERC-20 interface (which the
    // app uses for all amounts) uses info.usdcDecimals (6).
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
    blockExplorers: { default: { name: 'Arcscan', url: ARC_EXPLORER_URL } },
    testnet: false,
  });
}

/**
 * Switches the user's wallet to Arc, offering to add the network
 * when the wallet does not know it yet (EIP-3085/3326).
 */
export async function ensureArcChain(provider: Eip1193Provider, info: ChainParams): Promise<void> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${ARC_CHAIN_ID.toString(16)}` }],
    });
  } catch (error) {
    const code = (error as { code?: number } | null)?.code;
    if (code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
          chainName: ARC_CHAIN_NAME,
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          rpcUrls: [info.rpcUrl],
          blockExplorerUrls: [ARC_EXPLORER_URL],
        },
      ],
    });
  }
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The exact message the user signs (EIP-191 personal_sign) to authorize a
 * withdrawal to their own wallet. MUST stay byte-identical to the server
 * builder in artifacts/api-server/src/lib/arc-chain.ts.
 */
export function withdrawalAuthMessage(
  address: string,
  amount: string,
  issuedAt: string,
): string {
  return [
    'Revo Treasury withdrawal',
    `Amount: ${amount} USDC`,
    `Destination: ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    'Chain: Arc (5042)',
  ].join('\n');
}
