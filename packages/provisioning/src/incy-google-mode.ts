/**
 * Opt-in Android-only Google/Gemini selective-VPN mode for INCY subscriptions.
 *
 * The third-party INCY client advertises these response headers officially:
 * https://docs.incy.cc/app-management/#per-app-proxy
 * Never force them onto an existing full-VPN subscription or Karing/iOS.
 * VpnService stays enabled; this is NOT Smart DNS-only access.
 */
export const GOOGLE_ANDROID_APP_IDS = Object.freeze([
  'com.google.android.apps.bard',        // Standalone Google Gemini
  'com.google.android.googlequicksearchbox', // Embedded Android Google/Gemini
  'com.google.android.gms',              // Google Play services / shared API calls
  'com.google.android.gsf',              // Google Services Framework
  'com.android.vending',                 // Google Play Store
  'com.google.android.youtube',
  'com.android.chrome',                  // All Chrome traffic, not just Google
  'com.google.android.tts',             // Google Text-to-Speech
  'com.google.android.inputmethod.latin', // Gboard voice input (if installed)
  'com.google.android.gm',              // Gmail
  'com.google.android.apps.maps',       // Maps
  'com.google.android.apps.photos',     // Photos
  'com.google.android.apps.docs',       // Drive
  'com.google.android.calendar',
] as const);

export const INCLUDES_GMS = GOOGLE_ANDROID_APP_IDS.includes('com.google.android.gms');

export function incyGoogleModeHeaders(
  client: string | null,
  mode: string | null,
): Readonly<Record<string,string>> {
  if (mode === null) return {};
  if (mode !== 'google' || client !== 'incy') {
    throw new Error('Unsupported selective VPN mode/client');
  }
  if (!GOOGLE_ANDROID_APP_IDS.every(p => /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/.test(p))
      || new Set(GOOGLE_ANDROID_APP_IDS).size !== GOOGLE_ANDROID_APP_IDS.length) {
    throw new Error('Invalid Android package admission list');
  }
  return {
    'per-app-proxy-enable': '1',
    'per-app-proxy-mode': 'proxy',
    'per-app-proxy-list': GOOGLE_ANDROID_APP_IDS.join(','),
  };
}
