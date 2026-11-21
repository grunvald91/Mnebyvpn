#!/usr/bin/env node
/**
 * Summarize an actual, anonymous production Lighthouse run.
 * Never substitutes synthetic data when the site is unreachable.
 * Lab LCP, CLS and TBT are NOT field Core Web Vitals/INP.
 */
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';

const dir=resolve(process.argv[2]||'.');
const base='https://mnebyvpn.site/';
const metrics=[
  ['first-contentful-paint','FCP','ms'],
  ['largest-contentful-paint','LCP','ms'],
  ['cumulative-layout-shift','CLS','score'],
  ['total-blocking-time','TBT','ms'],
  ['speed-index','Speed Index','ms'],
];
const summary=[];
for(const device of ['mobile','desktop']){
  const lhr=JSON.parse(readFileSync(resolve(dir,device+'.json'),'utf8'));
  if(lhr.runtimeError)throw Error(device+': Lighthouse runtimeError: '+lhr.runtimeError.code);
  if(lhr.finalDisplayedUrl && !lhr.finalDisplayedUrl.startsWith(base))
    throw Error(device+': unexpected audited origin '+lhr.finalDisplayedUrl);
  const perf=lhr.categories?.performance?.score;
  if(typeof perf!=='number'||!Number.isFinite(perf))throw Error(device+': missing performance score');
  const measures={};
  for(const [id,label,unit] of metrics){
    const value=lhr.audits?.[id]?.numericValue;
    if(value===undefined||!Number.isFinite(value))
      throw Error(device+': missing Lighthouse metric '+id);
    measures[id]={name:label,value:Math.round(value*1000)/1000,unit};
  }
  const requests=lhr.audits?.['network-requests']?.details?.items||[];
  const assets=requests.filter(x=>Number.isFinite(x.transferSize)&&x.transferSize>0)
    .map(x=>{
      let path='other';
      try{const url=new URL(x.url);path=url.pathname;}catch{}
      return {path,bytes:Math.round(x.transferSize)};
    }).sort((a,b)=>b.bytes-a.bytes).slice(0,12);
  const result={
    device,
    lighthouseVersion:lhr.lighthouseVersion,
    requestedUrl:lhr.requestedUrl,
    auditedUrl:lhr.finalDisplayedUrl||lhr.finalUrl,
    fetchTime:lhr.fetchTime,
    performanceScore:Math.round(perf*100),
    seoScore:typeof lhr.categories?.seo?.score==='number'?Math.round(lhr.categories.seo.score*100):null,
    metrics:measures,
    networkRequestCount:requests.length,
    topTransferredAssets:assets,
    warnings:lhr.runWarnings||[],
    auditType:'production-lab-not-field',
  };
  summary.push(result);
  console.log('LIGHTHOUSE_BASELINE_'+device.toUpperCase()+'='+JSON.stringify(result));
}
const output={source:'https://github.com/GoogleChrome/lighthouse',site:base,kind:'real-production-lab',
  caveat:'Lighthouse lab metrics, not CrUX field data; INP is not measured in this run',
  summary};
writeFileSync(resolve(dir,'summary.json'),JSON.stringify(output,null,2)+'\n');
const lines=[
  '# MNEBYVPN Lighthouse: production laboratory baseline',
  '',
  'Anonymous public homepage only; no payments or customer APIs deliberately invoked.',
  'LCP/CLS here are lab estimates, TBT is a responsiveness proxy, INP is **not measured**.',
  '',
  '| Device | Performance | SEO | FCP (ms) | LCP (ms) | CLS | TBT (ms) |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...summary.map(x=>'| '+x.device+' | '+x.performanceScore+' | '+
    (x.seoScore===null?'n/a':x.seoScore)+' | '+
    x.metrics['first-contentful-paint'].value+' | '+
    x.metrics['largest-contentful-paint'].value+' | '+
    x.metrics['cumulative-layout-shift'].value+' | '+
    x.metrics['total-blocking-time'].value+' |'),
  '',
  '## Largest transferred assets per device',
  ...summary.flatMap(x=>['','**'+x.device+'**',
    ...x.topTransferredAssets.map(a=>'- '+a.path+': '+a.bytes+' B')]),
  '',
  'Full original JSON reports are attached as workflow artifacts.',
];
const markdown=lines.join('\n')+'\n';
writeFileSync(resolve(dir,'summary.md'),markdown);
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,markdown);
