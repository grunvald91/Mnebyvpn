import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileEntitlement,
  type DesiredAccess,
  type ObservedAccess,
  type ProvisioningAdapter,
  type ReconcileStore,
} from '../packages/provisioning/src/reconciler.ts';

const moment = new Date('2026-11-05T21:00:00Z');
const future = new Date(moment.getTime() + 3600_000);
function setup() {
  let desired: DesiredAccess = { entitlementId: 'e1', revision: 1, enabled: true, expiresAt: future };
  let observed: ObservedAccess = { revision: 0, enabled: false };
  const pending: string[] = [];
  const actions: string[] = [];
  let fence = 5;
  let acknowledgements: number[] = [];
  let customApply: ((d: DesiredAccess) => Promise<'applied' | 'unknown'>) | null = null;
  const store: ReconcileStore = {
    withLock: async (_id, callback) => callback(fence),
    readDesired: async () => ({ ...desired }),
    acknowledge: async (_id, revision, expectedFence, observedEnabled) => {
      if (observedEnabled !== (desired.enabled && desired.expiresAt !== null && desired.expiresAt > moment)) return false;
      if (expectedFence !== fence || revision !== desired.revision) return false;
      acknowledgements.push(revision);
      return true;
    },
    requestReconcile: async (_id, reason) => { pending.push(reason); },
  };
  const adapter: ProvisioningAdapter = {
    enforcesHardExpiry:true,
    inspect: async () => ({ ...observed }),
    apply: async d => {
      actions.push([d.revision, d.enabled].join(':'));
      if (customApply) return customApply(d);
      observed = { revision: d.revision, enabled: d.enabled, expiresAt:d.enabled ? d.expiresAt : null };
      return 'applied';
    },
  };
  return {
    store, adapter, pending, actions, get acknowledgements() { return acknowledgements; },
    get desired() { return desired; },
    set desired(d: DesiredAccess) { desired = d; },
    get observed() { return observed; },
    set observed(o: ObservedAccess) { observed = o; },
    set fence(f: number) { fence = f; },
    set apply(f: (d: DesiredAccess) => Promise<'applied' | 'unknown'>) { customApply = f; },
  };
}
const run = (s: ReturnType<typeof setup>) => reconcileEntitlement('e1', s.store, s.adapter, () => moment);

test('enables desired current revision once, verifies and CAS-acknowledges', async () => {
  const s = setup();
  assert.deepEqual(await run(s), { status: 'synced', revision: 1 });
  assert.deepEqual(s.actions, ['1:true']);
  assert.deepEqual(s.acknowledgements, [1]);
  assert.deepEqual(await run(s), { status: 'synced', revision: 1 });
  assert.deepEqual(s.actions, ['1:true']);
});

test('late ENABLE rev 1 after refund rev 2 gets compensating DISABLE before ack', async () => {
  const s = setup();
  s.apply = async d => {
    if (d.enabled) {
      s.observed = { revision: d.revision, enabled: true, expiresAt:d.expiresAt };
      s.desired = { ...s.desired, revision: 2, enabled: false };
    } else {
      s.observed = { revision: d.revision, enabled: false, expiresAt:null };
    }
    return 'applied';
  };
  assert.deepEqual(await run(s), { status: 'synced', revision: 2 });
  assert.deepEqual(s.actions, ['1:true', '2:false']);
  assert.deepEqual(s.observed, { revision: 2, enabled: false });
  assert.deepEqual(s.acknowledgements, [2]);
});

test('unknown network outcome is never blindly retried', async () => {
  const s = setup();
  s.apply = async () => 'unknown';
  assert.deepEqual(await run(s), { status: 'retry_required', reason: 'unknown_outcome' });
  assert.deepEqual(s.actions, ['1:true']);
  assert.deepEqual(s.pending, ['unknown_outcome']);
  assert.deepEqual(s.acknowledgements, []);
});

test('exception from adapter also treated as unknown outcome', async () => {
  const s = setup();
  s.apply = async () => { throw new Error('socket timeout'); };
  assert.deepEqual(await run(s), { status: 'retry_required', reason: 'unknown_outcome' });
  assert.deepEqual(s.actions, ['1:true']);
});

test('lost fencing token prevents stale acknowledgement', async () => {
  const s = setup();
  s.apply = async d => {
    s.observed = { revision: d.revision, enabled: d.enabled, expiresAt:d.enabled?d.expiresAt:null };
    s.fence = 6;
    return 'applied';
  };
  assert.deepEqual(await run(s), { status: 'retry_required', reason: 'fence_lost' });
  assert.deepEqual(s.pending, ['fence_lost']);
  assert.deepEqual(s.acknowledgements, []);
});

test('expired subscription is disabled even if business state is ACTIVE', async () => {
  const s = setup();
  s.desired = { ...s.desired, expiresAt: new Date(moment.getTime() - 1000) };
  s.observed = { revision: 1, enabled: true };
  assert.deepEqual(await run(s), { status: 'synced', revision: 1 });
  assert.deepEqual(s.observed, { revision: 1, enabled: false });
});

test('post-apply inspect failing does not acknowledge', async () => {
  const s = setup();
  s.apply = async () => 'applied'; // upstream falsely claims success
  assert.deepEqual(await run(s), { status: 'retry_required', reason: 'verification_failed' });
  assert.deepEqual(s.pending, ['verification_failed']);
  assert.deepEqual(s.acknowledgements, []);
});

test('repeated concurrent entitlement changes bound correction attempts', async () => {
  const s = setup();
  s.apply = async d => {
    s.observed = { revision: d.revision, enabled: d.enabled };
    s.desired = { ...s.desired, revision: d.revision + 1, enabled: !d.enabled };
    return 'applied';
  };
  assert.deepEqual(await run(s), { status: 'retry_required', reason: 'revision_race' });
  assert.equal(s.actions.length, 4);
  assert.deepEqual(s.pending, ['revision_race']);
});


test('trial needs node-observed hard deadline, not only revision+enabled',async()=>{
 const moment=new Date('2026-11-06T06:00:00Z');
 const expiry=new Date(moment.getTime()+300000);
 const desired:DesiredAccess={
  entitlementId:'trial-1',revision:1,enabled:true,expiresAt:expiry,
  trialPendingActivation:true,isTrial:true,
 };
 let observed:ObservedAccess={revision:0,enabled:false};
 const requested:string[]=[];
 const store:ReconcileStore={
  withLock:async(_id,fn)=>fn(1),
  readDesired:async()=>desired,
  acknowledge:async()=>true,
  requestReconcile:async(_id,reason)=>{requested.push(reason);},
 };
 const adapter:ProvisioningAdapter={
  enforcesHardExpiry:true,
  inspect:async()=>observed,
  apply:async()=>{
   observed={revision:1,enabled:true}; // falsely omits expiry proof
   return 'applied';
  },
 };
 const first=await reconcileEntitlement('trial-1',store,adapter,()=>moment);
 assert.deepEqual(first,{status:'retry_required',reason:'verification_failed'});
 assert.deepEqual(requested,['verification_failed']);
 // A valid node observation with a bounded provisional expiration is accepted.
 observed={revision:1,enabled:true,expiresAt:expiry};
 assert.deepEqual(await reconcileEntitlement('trial-1',store,adapter,()=>moment),
  {status:'synced',revision:1});
 // A node claiming an unbounded or too-far future expiry cannot activate trial.
 observed={revision:1,enabled:true,expiresAt:new Date(moment.getTime()+24*3600000)};
 assert.deepEqual(await reconcileEntitlement('trial-1',store,adapter,()=>moment),
  {status:'retry_required',reason:'verification_failed'});
});

test('paid access cannot sync if the node omits or misreports hard expiry',async()=>{
  const s=setup();
  s.observed={revision:1,enabled:true,expiresAt:null};
  s.apply=async()=> 'applied';
  assert.deepEqual(await run(s),{status:'retry_required',reason:'verification_failed'});
  assert.deepEqual(s.acknowledgements,[]);
  s.observed={revision:1,enabled:true,expiresAt:new Date(future.getTime()+86400_000)};
  assert.deepEqual(await run(s),{status:'retry_required',reason:'verification_failed'});
  s.observed={revision:1,enabled:true,expiresAt:future};
  assert.deepEqual(await run(s),{status:'synced',revision:1});
});
test('paid enable requires an adapter that guarantees hard node expiry',async()=>{
  const s=setup();
  delete s.adapter.enforcesHardExpiry;
  assert.deepEqual(await run(s),{status:'retry_required',reason:'expiry_enforcement_unverified'});
  assert.deepEqual(s.actions,[]);
});
