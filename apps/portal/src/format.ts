const DAY_MS = 86_400_000;

export function formatDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'never';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** "3 min ago", "2 h ago", "5 d ago" relative to `now`; "never" for null. */
export function formatAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (ms === null || ms === undefined) return 'never';
  const diff = Math.max(0, now - ms);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < DAY_MS) return `${Math.round(diff / 3_600_000)} h ago`;
  return `${Math.round(diff / DAY_MS)} d ago`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Canonical link endpoints of known public hubs, by portal host (ADR-021): the portal lives on
 * play.daisychess.org, nodes connect to hub.daisychess.org (`/link` on play is only an alias).
 */
export const KNOWN_HUB_LINKS: Readonly<Record<string, string>> = {
  'play.daisychess.org': 'wss://hub.daisychess.org/link',
};

/**
 * The hub's link endpoint for node setup snippets: build-time `VITE_HUB_URL`, else the canonical
 * endpoint of a known hub, else derived from this origin (self-hosted hubs).
 */
export function hubLinkUrl(
  configured: string | undefined = import.meta.env.VITE_HUB_URL as string | undefined,
  loc: Pick<Location, 'protocol' | 'host'> = globalThis.location,
): string {
  if (configured) return configured;
  const known = KNOWN_HUB_LINKS[loc.host];
  if (known) return known;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/link`;
}

export function composeSnippet(hubUrl: string, nodeToken: string, pool: boolean): string {
  return `services:
  node:
    image: ghcr.io/refaustria/daisychess-node:latest
    restart: unless-stopped
    read_only: true
    tmpfs: ["/tmp:size=64m,mode=1777"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    environment:
      HUB_URL: ${hubUrl}
      NODE_TOKEN: ${nodeToken}
      NODE_POOL: "${pool ? 'on' : 'off'}"
      MAX_SESSIONS: "2"
`;
}

export function npxSnippet(hubUrl: string, nodeToken: string, pool: boolean): string {
  return `HUB_URL=${hubUrl} NODE_TOKEN=${nodeToken} POOL=${pool ? 'on' : 'off'} npx -y @daisychess/node`;
}

/** Last `days` UTC days ending today as `YYYY-MM-DD`, oldest first. */
export function lastDays(days: number, now: number = Date.now()): string[] {
  const start = Math.floor(now / DAY_MS) * DAY_MS;
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(start - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}
