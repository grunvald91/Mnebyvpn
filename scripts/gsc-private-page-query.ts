/**
 * PRIVATE owner-only Google Search Console landing-page/query diagnostics.
 * This module must never be used in public CI logs, step summaries or artifacts.
 * Google Search Analytics exposes a sampled/top-row subset, not complete demand.
 * Docs: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
 */
export type PageQueryRow={
  keys?:string[];clicks?:number;impressions?:number;position?:number;
};
export type PageQueryOpportunity={
  path:string;query:string;clicks:number;impressions:number;
  ctr:number;position:number|null;
};

function safeSearchPhrase(value:unknown):string|null{
  if(typeof value!=='string')return null;
  const query=value.trim().replace(/\s+/g,' ');
  // Prevent accidental private tokens, control characters, forged Telegram
  // lines, URLs, emails and unbounded source text in owner diagnostics.
  if(!query||query.length>110||/[\p{Cc}\p{Cf}<>|\x60]/u.test(value))return null;
  if(/https?:\/\/|www\.|@|(?:api.?key|password|passwd|secret|token)\s*[:=]/i.test(query))
    return null;
  return query;
}
function nonnegative(v:unknown):number{
  return typeof v==='number'&&Number.isFinite(v)&&v>=0?v:0;
}

/** Exact canonical page + query pairs, sorted by *observed* impressions.
 * No inference about search demand, ranking causes, or unseen query rows.
 */
export function selectPageQueryOpportunities(
  rows:readonly PageQueryRow[]|undefined,origin:string,paths:readonly string[],limit=8,
):PageQueryOpportunity[]{
  if(limit<1||!Number.isInteger(limit)||limit>50)throw Error('GSC_PRIVATE_QUERY_LIMIT_INVALID');
  const permitted=new Set(paths.map(path=>origin+path));
  const aggregated=new Map<string,PageQueryOpportunity & {weightedPosition:number;positionWeight:number}>();
  for(const row of rows||[]){
    if(!row||row.keys?.length!==2||!permitted.has(row.keys[0]))continue;
    const query=safeSearchPhrase(row.keys[1]);
    if(!query)continue;
    const impressions=nonnegative(row.impressions),clicks=nonnegative(row.clicks);
    if(impressions<1||clicks>impressions)continue;
    const path=row.keys[0].slice(origin.length);
    const key=path+'\0'+query;
    const current=aggregated.get(key)||{
      path,query,impressions:0,clicks:0,ctr:0,position:null,
      weightedPosition:0,positionWeight:0,
    };
    current.impressions+=impressions;
    current.clicks+=clicks;
    if(typeof row.position==='number'&&Number.isFinite(row.position)&&row.position>0){
      current.weightedPosition+=row.position*impressions;
      current.positionWeight+=impressions;
    }
    aggregated.set(key,current);
  }
  return [...aggregated.values()].map(({weightedPosition,positionWeight,...row})=>({
    ...row,ctr:row.clicks/row.impressions,
    position:positionWeight>0?weightedPosition/positionWeight:null,
  })).sort((a,b)=>b.impressions-a.impressions||a.clicks-b.clicks||
    a.path.localeCompare(b.path,'ru')||a.query.localeCompare(b.query,'ru')).slice(0,limit);
}

export function formatPrivatePageQueryLines(
  rows:readonly PageQueryRow[]|undefined,origin:string,paths:readonly string[],limit=6,
):string[]{
  const selected=selectPageQueryOpportunities(rows,origin,paths,limit);
  if(!selected.length)return [
    'Запросы × страницы (28 завершённых дней): данных пока нет.',
    'Отсутствие строк не доказывает отсутствие показов или индексации.',
  ];
  return [
    'Запросы × страницы (выборка GSC, финальные 28 дней):',
    ...selected.map((r,i)=>String(i+1)+'. «'+r.query+'» → '+r.path+
      ' · показы: '+r.impressions+'; клики: '+r.clicks+
      ', CTR '+(r.ctr*100).toFixed(1)+'%'+
      (r.position===null?'':', поз. '+r.position.toFixed(1))),
    'Строки ограничены выборкой API; это не частотность рынка.',
  ];
}
