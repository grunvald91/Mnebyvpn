/**
 * Concrete Remnawave Panel provisioning adapter. It does NOT inspect Xray
 * directly. Enable access acknowledgements only with separately collected
 * private on-wire/node-offline expiry evidence for the pinned versions.
 * See docs/release-gates.md and docs/offline-expiry.md.
 */
import type {DesiredAccess,ObservedAccess,ProvisioningAdapter} from './reconciler.ts';
import {RemnawaveApi,remnawaveUsername,type RemnawaveUser} from './remnawave-api.ts';

export interface HardExpiryEvidence {
  /** SHA-256 of the private operator-signed E2E test report (never the report). */
  reportSha256:string;
  panelVersion:string;
  nodeVersion:string;
  xrayVersion:string;
}
export type RemnawaveControl = Pick<RemnawaveApi,'getByEntitlement'|'applyPanelChange'>;

const HEX=/^[a-f0-9]{64}$/;
const VERSION=/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/;
/** Evidence is an explicit operator release decision, not automatic detection. */
export function validateHardExpiryEvidence(input:HardExpiryEvidence):void {
  if(!HEX.test(input.reportSha256)||
     !VERSION.test(input.panelVersion)||
     !VERSION.test(input.nodeVersion)||
     !VERSION.test(input.xrayVersion))
    throw new Error('Pinned node hard-expiry E2E evidence is missing');
}
export function parseRemnawaveObservation(
  id:string,record:RemnawaveUser|null,
):ObservedAccess {
  if(!record)return {revision:0,enabled:false,expiresAt:null,absent:true};
  if(record.username!==remnawaveUsername(id))
    throw Error('Foreign Remnawave user identity');
  const prefix='mnebyvpn:'+id.toLowerCase()+':rev:';
  if(!record.description?.startsWith(prefix))
    throw Error('Unowned or unrevisioned Remnawave record');
  const version=record.description.slice(prefix.length);
  if(!/^(0|[1-9][0-9]*)$/.test(version)||
     !Number.isSafeInteger(Number(version)))
    throw Error('Invalid Remnawave revision');
  const expiresAt=new Date(record.expireAt);
  if(!Number.isFinite(expiresAt.getTime()))throw Error('Invalid Remnawave expiry');
  if(!['ACTIVE','DISABLED','EXPIRED','LIMITED'].includes(record.status))
    throw Error('Unknown Remnawave status');
  return {revision:Number(version),enabled:record.status==='ACTIVE',
    expiresAt};
}
/**
 * Remnawave Panel read-back confirms only Panel state. This implementation
 * relies on *separately* performed node on-wire/partition E2E acceptance; it
 * does not replace this test and must never self-approve a release gate.
 */
export class RemnawaveProvisioningAdapter implements ProvisioningAdapter {
  // P0: Panel state/expireAt is NOT node-side proof. Without an independent
  // Node enforcement implementation this adapter may REVOKE, but cannot
  // acknowledge a new ENABLE or start a customer's 24-hour trial.
  // Do not set enforcesHardExpiry=true based on a report SHA or version string.
  readonly panel:RemnawaveControl;
  readonly evidence?:HardExpiryEvidence;
  constructor(panel:RemnawaveControl,evidence?:HardExpiryEvidence){
    if(evidence)validateHardExpiryEvidence(evidence);
    this.panel=panel;
    this.evidence=evidence;
  }
  async inspect(entitlementId:string):Promise<ObservedAccess> {
    return parseRemnawaveObservation(entitlementId,
      await this.panel.getByEntitlement(entitlementId));
  }
  async apply(desired:DesiredAccess,operationId:string):Promise<'applied'|'unknown'> {
    const expected=desired.entitlementId+':'+desired.revision+
      ':'+(desired.enabled?'enable':'disable');
    if(operationId!==expected||desired.enabled&&
       (!desired.expiresAt||desired.expiresAt.getTime()<=Date.now()))
      throw Error('Stale or invalid provisioning operation');
    await this.panel.applyPanelChange(
      desired.entitlementId,desired.revision,desired.enabled,desired.expiresAt);
    return 'applied';
  }
}
