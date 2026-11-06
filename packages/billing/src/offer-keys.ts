import {createHash} from 'node:crypto';
import type {PricedPlan} from './channels.ts';
/** Immutable snapshot fingerprint for independently priced RUB offers. */
export function rublePlanKey(plan:PricedPlan):string {
 if(plan.rubMinor===null||!Number.isSafeInteger(plan.rubMinor)||plan.rubMinor<=0)
  throw new Error('RUB price unavailable');
 const payload=JSON.stringify(['ruble:v1',plan.planId,plan.title,plan.product,
  plan.durationSeconds,plan.dnsQuotaBytes?.toString()??null,plan.rubMinor]);
 return createHash('sha256').update(payload).digest('base64url').slice(0,16);
}
