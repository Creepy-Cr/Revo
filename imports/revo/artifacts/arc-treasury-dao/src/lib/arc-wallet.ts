import { defineChain, parseAbi, type Chain } from 'viem';
import type { ChainParams } from '@workspace/api-client-react';

/**
 * Browser-side Arc Testnet wallet plumbing. All chain parameters come from
 * the API (public `GET /chain/params`) so the frontend never hardcodes chain
 * facts that could drift from the server's testnet-only enforcement.
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

export function buildArcChain(info: ChainParams): Chain {
  return defineChain({
    id: info.chainId,
    name: info.chainName,
    // Arc's NATIVE USDC uses 18 decimals; the ERC-20 interface (which the
    // app uses for all amounts) uses info.usdcDecimals (6).
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
    blockExplorers: { default: { name: 'Arcscan', url: info.explorerUrl } },
    testnet: true,
  });
}

/**
 * Switches the user's wallet to Arc Testnet, offering to add the network
 * when the wallet does not know it yet (EIP-3085/3326).
 */
export async function ensureArcChain(provider: Eip1193Provider, info: ChainParams): Promise<void> {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: info.chainIdHex }],
    });
  } catch (error) {
    const code = (error as { code?: number } | null)?.code;
    if (code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: info.chainIdHex,
          chainName: info.chainName,
          nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
          rpcUrls: [info.rpcUrl],
          blockExplorerUrls: [info.explorerUrl],
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
  chainId: number,
): string {
  return [
    'Revo Treasury testnet withdrawal',
    `Amount: ${amount} USDC`,
    `Destination: ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    `Chain: Arc Testnet (${chainId})`,
  ].join('\n');
}
