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
    runs:samples,
    auditType:'production-lab-not-field',
  };
  output.push(summary);
  console.log('LIGHTHOUSE_MEDIAN_'+device.toUpperCase()+'='+JSON.stringify({
    device,runCount:3,performanceScore:summary.performanceScore,
    performanceRange:summary.performanceRange,seoScore:summary.seoScore,
    metrics:metricSummary,
    topTransferredAssets:typical.topTransferredAssets,
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
  'Six original Lighthouse reports and full individual measurements are artifacts.',
];
const markdown=lines.join('\n')+'\n';
writeFileSync(resolve(dir,'summary.md'),markdown);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
