#!/usr/bin/env node
/**
 * Three anonymous production Lighthouse lab runs per profile.
 * Summarize medians and observed ranges; never present these as field INP/CrUX.
 */
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';

const dir=resolve(process.argv[2]||'.');
const site='https://mnebyvpn.site/';
const metricNames=[
  ['first-contentful-paint','FCP','ms'],
  ['largest-contentful-paint','LCP','ms'],
  ['cumulative-layout-shift','CLS','score'],
  ['total-blocking-time','TBT','ms'],
  ['speed-index','Speed Index','ms'],
];
const median=values=>{
  const ordered=[...values].sort((a,b)=>a-b);
  return ordered[Math.floor(ordered.length/2)];
};
const range=values=>({min:Math.min(...values),max:Math.max(...values)});
const digits=n=>Math.round(n*1000)/1000;

/** Lighthouse 13 insight IDs replace old LCP element/blocking audits.
 * The values below are lab-only estimates, not measured field improvements.
 * https://developer.chrome.com/blog/lighthouse-13-0/
 */
const pickInsight=(lhr,id)=>{
  const audit=lhr.audits?.[id];
  if(!audit)return null;
  const items=Array.isArray(audit.details?.items)?audit.details.items:[];
  const node=items.find(item=>item?.type==='node');
  const phaseTable=items.find(item=>item?.type==='table'&&
    Array.isArray(item.items)&&item.items.some(row=>typeof row.subpart==='string'));
  const phases=phaseTable?.items?.filter(row=>
    typeof row.subpart==='string'&&Number.isFinite(row.duration))
    .map(row=>({part:row.subpart,durationMs:digits(row.duration)}))||[];
  const blocking=items.filter(item=>typeof item.url==='string'&&
    item.url.startsWith('https://mnebyvpn.site/')).slice(0,10)
    .map(item=>({path:new URL(item.url).pathname,
      wastedMs:Number.isFinite(item.wastedMs)?digits(item.wastedMs):null,
      bytes:Number.isFinite(item.totalBytes)?item.totalBytes:null}));
  return {
    estimatedLcpSavingsMs:Number.isFinite(audit.metricSavings?.LCP)?
      digits(audit.metricSavings.LCP):null,
    estimatedFcpSavingsMs:Number.isFinite(audit.metricSavings?.FCP)?
      digits(audit.metricSavings.FCP):null,
    element:node?{selector:node.selector||null,nodeLabel:node.nodeLabel||null,
      snippet:node.snippet||null}:null,
    phases,blocking,
  };
};
const output=[];

for(const device of ['mobile','desktop']){
  const samples=[];
  for(let index=1;index<=3;index++){
    const lhr=JSON.parse(readFileSync(resolve(dir,device+'-'+index+'.json'),'utf8'));
    if(lhr.runtimeError)throw Error(device+' #'+index+': Lighthouse '+lhr.runtimeError.code);
    if(lhr.finalDisplayedUrl!==site || lhr.requestedUrl!==site)
      throw Error(device+' #'+index+': unexpected audited URL');
    const perf=lhr.categories?.performance?.score;
    const seo=lhr.categories?.seo?.score;
    if(!Number.isFinite(perf)||!Number.isFinite(seo))
      throw Error(device+' #'+index+': performance or SEO score missing');
    const metrics={};
    for(const [id] of metricNames){
      const value=lhr.audits?.[id]?.numericValue;
      if(!Number.isFinite(value))throw Error(device+' #'+index+': metric '+id+' missing');
      metrics[id]=digits(value);
    }
    const items=lhr.audits?.['network-requests']?.details?.items??[];
    const largest=items.filter(x=>Number.isFinite(x.transferSize)&&x.transferSize>0).map(x=>{
      let path='other';
      try{path=new URL(x.url).pathname;}catch{}
      return {path,bytes:Math.round(x.transferSize)};
    }).sort((a,b)=>b.bytes-a.bytes).slice(0,12);
    samples.push({
      index,fetchTime:lhr.fetchTime,lighthouseVersion:lhr.lighthouseVersion,
      performanceScore:Math.round(perf*100),seoScore:Math.round(seo*100),
      metrics,requestCount:items.length,topTransferredAssets:largest,
      warnings:lhr.runWarnings||[],
      insights:{
        lcp:pickInsight(lhr,'lcp-breakdown-insight'),
        renderBlocking:pickInsight(lhr,'render-blocking-insight'),
      },
    });
  }
  const metricSummary={};
  for(const [id,name,unit] of metricNames){
    const values=samples.map(s=>s.metrics[id]);
    metricSummary[id]={name,value:digits(median(values)),unit,range:range(values)};
  }
  const scores=samples.map(s=>s.performanceScore);
  const lcpOrdered=[...samples].sort((a,b)=>
    a.metrics['largest-contentful-paint']-b.metrics['largest-contentful-paint']);
  const typical=lcpOrdered[1];
  const summary={
    device,runCount:samples.length,performanceScore:median(scores),
    performanceRange:range(scores),
    seoScore:median(samples.map(s=>s.seoScore)),
    metrics:metricSummary,
    networkRequestCount:median(samples.map(s=>s.requestCount)),
    topTransferredAssets:typical.topTransferredAssets,
    insights:typical.insights,
    runs:samples,
    auditType:'production-lab-not-field',
  };
  output.push(summary);
  console.log('LIGHTHOUSE_MEDIAN_'+device.toUpperCase()+'='+JSON.stringify({
    device,runCount:3,performanceScore:summary.performanceScore,
    performanceRange:summary.performanceRange,seoScore:summary.seoScore,
    metrics:metricSummary,
    topTransferredAssets:typical.topTransferredAssets,
    insights:typical.insights,
  }));
}
const full={source:'https://github.com/GoogleChrome/lighthouse',site,
  kind:'real-production-lab',caveat:'Three laboratory runs; INP and CrUX field data not measured',summary:output};
writeFileSync(resolve(dir,'summary.json'),JSON.stringify(full,null,2)+'\n');
const rows=output.map(x=>['|',x.device,'|',x.performanceScore,
  '('+x.performanceRange.min+'–'+x.performanceRange.max+')','|',x.seoScore,'|',
  x.metrics['first-contentful-paint'].value,'|',
  x.metrics['largest-contentful-paint'].value,'|',
  x.metrics['cumulative-layout-shift'].value,'|',
  x.metrics['total-blocking-time'].value,'|'].join(' '));
const lines=[
  '# MNEBYVPN Lighthouse: production laboratory median (3 runs per profile)',
  '',
  'Anonymous public homepage only. Median from three independent cold laboratory runs.',
  'Single-run variation is preserved in summary.json. These are NOT field LCP/CLS or INP.',
  '',
  '| Device | Performance median (range) | SEO median | FCP ms | LCP ms | CLS | TBT ms |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...rows,
  '',
  '## Largest transferred resources in median-LCP run',
  ...output.flatMap(x=>['','**'+x.device+'**',
    ...x.topTransferredAssets.map(a=>'- '+a.path+': '+a.bytes+' B')]),
  '',
  '## LCP element and render-blocking CSS (median-LCP run)',
  'Lighthouse 13 lab insights only; estimated savings are not measured improvements.',
  ...output.flatMap(x=>{
    const lcp=x.insights.lcp,block=x.insights.renderBlocking;
    return [
      '',
      '**'+x.device+'**',
      lcp?.element
        ?'- LCP element: '+(lcp.element.selector||lcp.element.nodeLabel||'unidentified')
        :'- LCP element: not reported in insight JSON',
      ...((lcp?.phases)||[]).map(p=>'- LCP phase '+p.part+': '+p.durationMs+' ms'),
      block?.estimatedLcpSavingsMs!==null&&block?.estimatedLcpSavingsMs!==undefined
        ?'- Estimated render-blocking LCP savings: '+block.estimatedLcpSavingsMs+' ms'
        :'- Render-blocking LCP savings: not reported',
      ...((block?.blocking)||[]).map(a=>'- Blocking stylesheet '+a.path+
        ': '+(a.wastedMs===null?'unknown':a.wastedMs)+' ms (audit estimate)'),
    ];
  }),
  '',
  'Six original Lighthouse reports and full individual measurements are artifacts.',
];
const markdown=lines.join('\n')+'\n';
writeFileSync(resolve(dir,'summary.md'),markdown);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
