import { useEffect, useState } from 'react';
import type { Eip6963ProviderDetail } from '@/lib/arc-wallet';

/**
 * Discovers every installed browser wallet via EIP-6963 announcements.
 * Discovery only runs while `active` (the connect modal is open) so the
 * listener isn't held for the app's whole lifetime.
 */
export function useEip6963Providers(active: boolean): Eip6963ProviderDetail[] {
  const [providers, setProviders] = useState<Eip6963ProviderDetail[]>([]);

  useEffect(() => {
    if (!active) return undefined;
    const found = new Map<string, Eip6963ProviderDetail>();
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (!detail?.info?.uuid || found.has(detail.info.uuid)) return;
      found.set(detail.info.uuid, detail);
      setProviders(Array.from(found.values()));
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
  }, [active]);

  return providers;
}
