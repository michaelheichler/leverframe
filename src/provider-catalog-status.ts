import * as p from '@clack/prompts';
import type { BrowsingCatalogStatus } from './provider-catalog.js';

export function reportBrowsingCatalogStatus(statuses: BrowsingCatalogStatus[]): void {
  for (const status of statuses) {
    const timestamp = status.fetchedAt ? ` Last fetched: ${status.fetchedAt}.` : '';
    if (status.source === 'live') {
      p.log.info(`${status.providerName}: live model catalog.${timestamp}`);
      if (status.reason) p.log.warn(`${status.providerName}: ${status.reason}`);
    } else {
      const availability = status.source === 'unavailable'
        ? 'No model catalog available.'
        : `Showing stale ${status.source} models for browsing only; launch requires live discovery.`;
      p.log.warn(`${status.providerName}: ${availability}${timestamp} ${status.reason ?? ''}`.trim());
    }
  }
}
