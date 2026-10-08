import type { ChannelAdapter } from '../types.js';
import { type EvolutionApiOptions, evolutionFormatAdapter } from './evolution_api.js';

export interface WhatsmiauOptions extends EvolutionApiOptions {
  /**
   * The Whatsmiau server, host only — `http://whatsmiau:8080`. The route prefix is added for you:
   * `/v1` (self-hosted Whatsmiau serves Evolution's routes there). A url that already ends in a
   * version (`https://api.whatsmiau.dev/v2`, the hosted service) is used as is.
   */
  url: string;
  /**
   * Send proposals with reply buttons (`POST /v1/message/sendButtons/{instance}`). Default `true`:
   * Whatsmiau runs on whatsmeow, whose buttons WhatsApp renders. The buttons message carries the
   * text instruction too; a 4xx from that endpoint falls back to the text-only message.
   */
  buttons?: boolean;
}

/** `http://host:8080` → `http://host:8080/v1`; a url ending in `/v1`, `/v2`… as is. */
function whatsmiauBase(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * WhatsApp through [Whatsmiau](https://github.com/verbeux-ai/whatsmiau) — an Evolution-compatible
 * server built on whatsmeow (verbeux-ai's fork). The same webhook, routes and options as
 * `evolutionApi()`, with two differences: the route prefix (`/v1`) is added to `url`, and reply
 * buttons are on by default — Whatsmiau's render on the phone, where Evolution's (Baileys) did not in
 * our test. Point the instance's webhook (`POST /v1/webhook/set/{instance}`, event
 * `MESSAGES_UPSERT`) at the route, with the token.
 */
export function whatsmiau(options: WhatsmiauOptions): ChannelAdapter {
  return evolutionFormatAdapter({ ...options, url: whatsmiauBase(options.url) }, { buttons: true });
}
