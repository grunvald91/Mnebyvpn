/**
 * Anonymous SEO discovery contract for the active website.
 * Never enumerate customer-specific, checkout, login or subscription URLs.
 */
export const PUBLIC_SEO_PATHS = ['/', '/terms', '/agreement', '/privacy'] as const;

const aliasTargets: Readonly<Record<string,string>> = Object.freeze({
  '/index.html': '/',
  '/terms.html': '/terms',
  '/agreement.html': '/agreement',
  '/privacy.html': '/privacy',
});

export function canonicalAlias(path: string): string | null {
  return aliasTargets[path] ?? null;
}

export function requiresNoindex(path: string): boolean {
  return /^(?:\/payment\/|\/api(?:\/|$)|\/auth(?:\/|$)|\/sub(?:\/|$)|\/install(?:\/|$)|\/webhooks(?:\/|$)|\/landing-art\.html$)/.test(path);
}

export function renderRobots(origin: string): string {
  const site = new URL(origin);
  if(site.origin !== origin || site.protocol !== 'https:')
    throw new Error('SEO requires a canonical HTTPS origin');
  return [
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /sub/',
    'Disallow: /install/',
    'Disallow: /webhooks/',
    '',
    'Sitemap: ' + origin + '/sitemap.xml',
    '',
  ].join('\n');
}

export function renderSitemap(origin: string): string {
  const site = new URL(origin);
  if(site.origin !== origin || site.protocol !== 'https:')
    throw new Error('SEO requires a canonical HTTPS origin');
  const urls = PUBLIC_SEO_PATHS.map(path=>
    '  <url><loc>' + origin + path + '</loc></url>'
  ).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls + '\n</urlset>\n';
}
