/** Convert real Lighthouse JSON to an honest, source-linked CI baseline. */
import {readFileSync,appendFileSync} from 'node:fs';

const sources=process.argv.slice(2);
if(!sources.length)throw new Error('Usage: summarize-lighthouse.mjs <mobile.json> [desktop.json]');
const results=[];
for(const filename of sources){
  const lhr=JSON.parse(readFileSync(filename,'utf8'));
  if(lhr.runtimeError)throw new Error('LIGHTHOUSE_RUNTIME_ERROR: '+JSON.stringify(lhr.runtimeError));
  const score=lhr.categories?.performance?.score;
  if(!Number.isFinite(score))throw new Error('LIGHTHOUSE_SCORE_MISSING: '+filename);
  const metric=id=>{
    const audit=lhr.audits?.[id];
    return audit&&Number.isFinite(audit.numericValue)?Math.round(audit.numericValue*100)/100:null;
  };
  const item={
    scope:filename.includes('mobile')?'mobile':filename.includes('desktop')?'desktop':'unknown',
    score:Math.round(score*100),
    lcpMs:metric('largest-contentful-paint'),
    cls:metric('cumulative-layout-shift'),
    tbtMs:metric('total-blocking-time'),
    fcpMs:metric('first-contentful-paint'),
    speedIndexMs:metric('speed-index'),
    transferBytes:metric('total-byte-weight'),
    lighthouseVersion:lhr.lighthouseVersion,
    finalUrl:lhr.finalDisplayedUrl??lhr.finalUrl,
  };
  if([item.lcpMs,item.cls,item.tbtMs,item.fcpMs].some(v=>v===null))
    throw new Error('LIGHTHOUSE_REQUIRED_METRIC_MISSING: '+JSON.stringify(item));
  results.push(item);
  console.log('LIGHTHOUSE_LAB_BASELINE='+JSON.stringify(item));
  // Keep the first audit actionable instead of reducing it to a score.
  const tasks=lhr.audits?.['long-tasks']?.details?.items??[];
  const largestTasks=tasks.filter(t=>Number.isFinite(t.duration))
    .sort((a,b)=>b.duration-a.duration).slice(0,5)
    .map(t=>({durationMs:Math.round(t.duration),url:String(t.url??'').slice(0,150)}));
  const auditNames=['bootup-time','mainthread-work-breakdown','render-blocking-insight',
    'lcp-breakdown-insight','lcp-discovery-insight','unused-javascript',
    'unused-css-rules','network-requests'];
  const diagnostics=auditNames.map(id=>{
    const audit=lhr.audits?.[id];
    return audit?{id,title:audit.title,score:audit.score,
      savingsMs:audit.details?.overallSavingsMs??null,
      numericValue:audit.numericValue??null,
      items:audit.details?.items?.length??0}:null;
  }).filter(Boolean);
  console.log('LIGHTHOUSE_LAB_DIAGNOSTICS='+JSON.stringify({
    scope:item.scope,largestTasks,audits:diagnostics,
  }));
}
const summary=[
  '## Lighthouse — isolated synthetic storefront (lab)',
  '',
  'Это лабораторное измерение реальных HTML/CSS/JS и фоновых медиа с **тестовым каталогом** на localhost, не производственная метрика CrUX.',
  'INP здесь не измеряется: для лабораторной оценки блокировки используется TBT.',
  '',
  '| Режим | Performance | LCP, мс | CLS | TBT, мс | FCP, мс | Speed Index, мс |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...results.map(v=>
    '| '+v.scope+' | '+v.score+' | '+v.lcpMs+' | '+v.cls+' | '+v.tbtMs+
    ' | '+v.fcpMs+' | '+v.speedIndexMs+' |'),
  '',
  'Результаты и исходные JSON доступны в артефакте запуска; этот baseline не является подтверждением скорости production.',
  '',
].join('\n');
if(process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary+'\n');
