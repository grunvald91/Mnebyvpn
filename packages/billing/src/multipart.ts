import type { Fields, Field } from './prodamus.ts';

const SAFE = /^[a-zA-Z0-9_]{1,64}$/;
/**
 * Prodamus delivers signed callbacks as application/x-www-form-urlencoded.
 * Keep accepting multipart/form-data for older integrations and tests.
 * Both formats are decoded with FormData before rebuilding PHP-style nested
 * fields: products[0][price] -> {products:[{price:'...'}]}.
 * The HTTP server bounds the raw request before parsing or verifying Sign.
 */
export function isProdamusContentType(contentType: string): boolean {
  return /^multipart\/form-data;\s*boundary=/i.test(contentType) ||
    /^application\/x-www-form-urlencoded(?:\s*;\s*charset="?utf-8"?)?\s*$/i.test(contentType);
}
export async function parseProdamusFormData(contentType: string, raw: Uint8Array): Promise<Fields> {
  if (!isProdamusContentType(contentType)) throw new Error('Unsupported Prodamus content type');
  const request = new Request('http://localhost/notifications', {
    method: 'POST', headers: { 'content-type': contentType }, body: raw,
  });
  const form = await request.formData();
  if (Array.from(form.keys()).length > 128) throw new Error('Too many fields');
  const result: Fields = Object.create(null) as Fields;
  const used = new Set<string>();
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') throw new Error('Binary parts are not accepted');
    if (value.length > 16000) throw new Error('Field too long');
    if (used.has(key)) throw new Error('Duplicate form field');
    used.add(key);
    const keys = key.match(/^[^\[\]]+|\[[^\[\]]+\]/g)?.map(k=>k.replace(/^\[|\]$/g, ''));
    if (!keys || !SAFE.test(keys[0]) || keys.join('').length > 256 ||
        !keys.every(k=>SAFE.test(k))) throw new Error('Invalid field path');
    let node: Record<string, any> = result;
    for (let i=0; i<keys.length; i++) {
      const part=keys[i];
      if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw new Error('Unsafe field');
      if (i === keys.length - 1) {
        if (part in node) throw new Error('Duplicate form path');
        node[part] = value;
      } else {
        const next = keys[i+1];
        if (!(part in node)) node[part] = /^\d+$/.test(next) ? [] : Object.create(null);
        const child = node[part];
        if (!child || typeof child !== 'object') throw new Error('Conflicting form fields');
        node = child;
      }
    }
  }
  return result;
}
