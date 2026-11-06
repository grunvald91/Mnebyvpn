/**
 * Offline-only data-plane simulator for acceptance tests.
 * Not a VPN server, not a DNS resolver, and NEVER production provisioning.
 *
 * The node independently checks hard expiry on every new connection AND
 * already established session transfer, even while control-plane is offline.
 * The simulator deliberately exposes stale-access behaviour after refund:
 * node revocation is not instantaneous during a partition.
 */
import { randomUUID } from 'node:crypto';
import type {
  DesiredAccess,ObservedAccess,ProvisioningAdapter,
} from './reconciler.ts';

interface NodeEntry {
  revision:number;
  enabled:boolean;
  expiresAt:Date|null;
}
export class OfflineExpiryNodeSimulator implements ProvisioningAdapter {
  readonly enforcesHardExpiry=true as const;
  private readonly entries=new Map<string,NodeEntry>();
  private readonly sessions=new Map<string,string>();
  private linkUp=true;
  private readonly clock:()=>Date;
  constructor(clock:()=>Date=()=>new Date()){this.clock=clock;}
  setControlLink(up:boolean):void {this.linkUp=up;}
  private requireLink():void {
    if(!this.linkUp)throw new Error('OFFLINE_SIMULATOR_PARTITION');
  }
  async inspect(entitlementId:string):Promise<ObservedAccess> {
    this.requireLink();
    const node=this.entries.get(entitlementId);
    if(!node)return {revision:0,enabled:false};
    // Configured switch remains visible to the reconciler even when local
    // expiry already blocks packets: expired true must trigger a DISABLE.
    return {revision:node.revision,enabled:node.enabled,
      expiresAt:node.expiresAt===null?null:new Date(node.expiresAt.getTime())};
  }
  async apply(desired:DesiredAccess,_operationId:string):Promise<'applied'> {
    this.requireLink();
    if(desired.enabled){
      const expiry=desired.expiresAt?.getTime();
      if(typeof expiry!=='number'||!Number.isFinite(expiry)||expiry<=this.clock().getTime())
        throw new Error('Hard expiry required for node ENABLE');
    }
    const previous=this.entries.get(desired.entitlementId);
    if(previous && previous.revision>desired.revision)
      throw new Error('Stale revision cannot override newer node state');
    this.entries.set(desired.entitlementId,{
      revision:desired.revision,enabled:desired.enabled,
      expiresAt:desired.expiresAt===null?null:new Date(desired.expiresAt.getTime()),
    });
    return 'applied';
  }
  /** Simulates new-connection admission; no IP, TLS, DNS or physical packets. */
  connect(entitlementId:string):string|null {
    if(!this.localPermit(entitlementId))return null;
    const session=randomUUID();
    this.sessions.set(session,entitlementId);
    return session;
  }
  /** Simulates an already-open session sending packets at a later moment. */
  transfer(sessionId:string):boolean {
    const id=this.sessions.get(sessionId);
    return id!==undefined&&this.localPermit(id);
  }
  private localPermit(id:string):boolean {
    const entry=this.entries.get(id);
    return entry?.enabled===true && entry.expiresAt instanceof Date &&
      entry.expiresAt.getTime()>this.clock().getTime();
  }
}
