// Per-site activation. A "site" is a hostname (any scheme, any port), or 'file://' for local files.

export const SITES_KEY = 'enabledSites';

export function siteOf(url: string | undefined): string | null
{
  if (!url) return null;
  try
  {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'file://';
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname || null;
  }
  catch
  {
    // not a URL we can run on
  }
  return null;
}

/** Match patterns for registering the content scripts on a site. */
export function sitePatterns(site: string): string[]
{
  return site === 'file://' ? ['file:///*'] : [`*://${site}/*`];
}

export function siteLabel(site: string): string
{
  return site === 'file://' ? 'local files' : site;
}
