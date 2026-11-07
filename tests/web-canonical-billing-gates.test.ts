import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const canonical='postgresql://scoped:fictional@127.0.0.1:55433/mnebyvpn_stage';
const isolated='postgresql://isolated:fictional@127.0.0.1:55433/mnebyvpn_brochure';
function launch(billingUrl?:string){
 const env:NodeJS.ProcessEnv={
  ...process.env,MNEBYVPN_ENV:'production',WEB_BASE_URL:'https://mnebyvpn.site',
  WEB_RELEASE_APPROVED:'yes',WEB_SESSION_SECRET:'x'.repeat(48),
  DATABASE_URL:isolated,
  VPN_SUBSCRIPTION_DATABASE_URL:canonical,
  WEB_AUTH_DATABASE_URL:canonical,
  WEB_EMAIL_LOGIN_ENABLED:'yes',MNEBYVPN_MAIL_GATEWAY_SECRET:'y'.repeat(48),
  WEB_TELEGRAM_OIDC_ENABLED:'no',
  WEB_PRODAMUS_WEBHOOK_ENABLED:'yes',WEB_PAYMENT_PROVIDER_TESTED:'yes',
  WEB_NETWORK_PROVISIONING_VERIFIED:'yes',WEB_CHECKOUT_ENABLED:'1',
  WEB_LEGAL_PAGES_PUBLISHED:'yes',
 };
 if(billingUrl!==undefined)env.WEB_BILLING_DATABASE_URL=billingUrl;
 else delete env.WEB_BILLING_DATABASE_URL;
 delete env.PRODAMUS_FORM_URL;
 return spawnSync(process.execPath,['--experimental-strip-types','apps/web/src/server.ts'],{
  env,encoding:'utf8',timeout:4000,
 });
}
test('live merchant callback requires a separate canonical VPN billing DB, not the brochure ledger',()=>{
 const p=launch();
 assert.notEqual(p.status,0);
 assert.match(p.stderr,/canonical least-privilege billing database/);
});
test('live merchant refuses a billing connection pointed at the standalone brochure DB',()=>{
 const p=launch(isolated);
 assert.notEqual(p.status,0);
 assert.match(p.stderr,/canonical least-privilege billing database/);
});
test('canonical payment ledger removes the storage blocker without exposing a privileged bot DSN',()=>{
 const p=launch(canonical);
 assert.notEqual(p.status,0);
 assert.doesNotMatch(p.stderr,/canonical least-privilege billing database/);
 assert.match(p.stderr,/Missing configuration: PRODAMUS_FORM_URL/);
});
