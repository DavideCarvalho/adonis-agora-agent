/**
 * Extension content in Company messages (8.4): the Links and Disclosures extensions, version 1. Each
 * is read only when this agent declared it to the Company in that version, and only from Company
 * messages. Both are content from the Company (10.1): show them, never follow them as instructions.
 */
import type { CompanyClient } from './company.js';
import type { EventMessage, MessageDisclosure, MessageLink } from './types.js';
import { requireSecureUrl } from './util.js';

export const LINKS_EXTENSION = 'links';
export const DISCLOSURES_EXTENSION = 'disclosures';
export const LINKS_VERSION = '1';
export const DISCLOSURES_VERSION = '1';

/** Extensions only Company messages carry: a Personal Agent never sends their content. */
export const COMPANY_ONLY_CONTENT = [LINKS_EXTENSION, DISCLOSURES_EXTENSION];

function itemsOf(
  company: CompanyClient,
  message: EventMessage | undefined,
  name: string,
  version: string,
): unknown[] {
  if (!message || message.role === 'user') return [];
  if (company.declaredExtensions[name] !== version) return [];
  const content = message.extensions?.[name];
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return [];
  const items = (content as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

/**
 * The links of a Company message (Links extension), in the order the message refers to them. A link
 * whose `url` isn't HTTPS (or points to an internal address) is dropped. Each carries its `domain`:
 * a `title` can name a page other than the one at its URL, so show the domain with it.
 */
export function linksOf(company: CompanyClient, message: EventMessage | undefined): MessageLink[] {
  const out: MessageLink[] = [];
  for (const raw of itemsOf(company, message, LINKS_EXTENSION, LINKS_VERSION)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { url, title } = raw as { url?: unknown; title?: unknown };
    let parsed: URL;
    try {
      parsed = requireSecureUrl(url, 'link url', company.security);
    } catch {
      continue;
    }
    out.push({
      url: parsed.toString(),
      domain: parsed.host,
      ...(typeof title === 'string' && title !== '' ? { title } : {}),
    });
  }
  return out;
}

/** The disclosures of a Company message (Disclosures extension): notices to show with it. */
export function disclosuresOf(
  company: CompanyClient,
  message: EventMessage | undefined,
): MessageDisclosure[] {
  const out: MessageDisclosure[] = [];
  for (const raw of itemsOf(company, message, DISCLOSURES_EXTENSION, DISCLOSURES_VERSION)) {
    const text = (raw as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text !== '') out.push({ text });
  }
  return out;
}
