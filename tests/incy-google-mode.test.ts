import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_ANDROID_APP_IDS, INCLUDES_GMS, incyGoogleModeHeaders,
} from '../packages/provisioning/src/incy-google-mode.ts';
import {installerLink} from '../packages/provisioning/src/subscription-links.ts';

const token='A'.repeat(43);

test('Google mode is opt-in and cannot reconfigure an existing full VPN import',()=>{
  assert.deepEqual(incyGoogleModeHeaders(null,null),{});
  assert.deepEqual(incyGoogleModeHeaders('incy',null),{});
  assert.deepEqual(incyGoogleModeHeaders('karing',null),{});
  assert.throws(()=>incyGoogleModeHeaders('karing','google'));
  assert.throws(()=>incyGoogleModeHeaders(null,'google'));
  assert.throws(()=>incyGoogleModeHeaders('incy','all'));
  assert.throws(()=>incyGoogleModeHeaders('incy','other'));
});

test('INCY Google-only app selection includes native Gemini and Google Play Services',()=>{
  const headers=incyGoogleModeHeaders('incy','google');
  assert.equal(headers['per-app-proxy-enable'],'1');
  assert.equal(headers['per-app-proxy-mode'],'proxy');
  assert.equal(headers['per-app-proxy-list'],GOOGLE_ANDROID_APP_IDS.join(','));
  assert.equal(INCLUDES_GMS,true);
  for(const p of [
    'com.google.android.apps.bard','com.google.android.googlequicksearchbox',
    'com.google.android.gms','com.android.vending','com.google.android.youtube',
    'com.android.chrome','com.google.android.gsf',
  ])assert.ok(GOOGLE_ANDROID_APP_IDS.includes(p as typeof GOOGLE_ANDROID_APP_IDS[number]));
  assert.equal(new Set(GOOGLE_ANDROID_APP_IDS).size,GOOGLE_ANDROID_APP_IDS.length);
  assert.ok(!headers['per-app-proxy-list'].includes('\n'));
  assert.ok(!headers['per-app-proxy-list'].includes('com.mnebyvpn'));
});

test('Google mode has its own installer URL and does not change the original token',()=>{
  const old=installerLink(token,'incy');
  assert.equal(old,'https://cdn.servgo.ru:8443/install/'+token+'?client=incy');
  assert.equal(installerLink(token,'incy','google'),old+'&mode=google');
  assert.equal(installerLink(token,'karing'),'https://cdn.servgo.ru:8443/install/'+token+'?client=karing');
  assert.throws(()=>installerLink(token,'karing','google'));
  assert.throws(()=>installerLink('bad','incy','google'));
});
