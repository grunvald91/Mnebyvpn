/** User-facing subscription status formatting. No entitlement decisions here. */
const MiB=1024n*1024n;
const GiB=MiB*1024n;

export function effectiveAccessState(state:string,expiresAt:Date|null,now=Date.now()):string {
  return state==='ACTIVE'&&expiresAt instanceof Date&&
    Number.isFinite(expiresAt.getTime())&&expiresAt.getTime()<=now?'EXPIRED':state;
}

export function formatRemainingTime(expiresAt:Date|null,now=Date.now()):string|null {
  if(!(expiresAt instanceof Date)||!Number.isFinite(expiresAt.getTime()))return null;
  const seconds=Math.ceil((expiresAt.getTime()-now)/1000);
  if(seconds<=0)return 'Срок истёк';
  if(seconds<86400)return 'Осталось '+Math.ceil(seconds/3600)+' ч';
  return 'Осталось '+Math.ceil(seconds/86400)+' дн';
}

function decimalTenth(bytes:bigint,unit:bigint):string {
  const tenth=(bytes*10n+unit/2n)/unit;
  return String(tenth/10n)+(tenth%10n===0n?'':','+String(tenth%10n));
}

export function formatRemainingQuota(limitBytes:bigint|null,usedBytes:bigint):string|null {
  if(limitBytes===null)return null;
  if(limitBytes<0n||usedBytes<0n)return null;
  const remainder=limitBytes>usedBytes?limitBytes-usedBytes:0n;
  if(remainder===0n)return 'Осталось: 0 Б';
  if(remainder<MiB)return 'Осталось: менее 1 МБ';
  if(remainder<GiB)return 'Осталось: '+decimalTenth(remainder,MiB)+' МБ';
  return 'Осталось: '+decimalTenth(remainder,GiB)+' ГБ';
}
