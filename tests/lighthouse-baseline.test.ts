import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/lighthouse_baseline_summary.mjs',import.meta.url));
const homepage='https://mnebyvpn.site/';

test('production Lighthouse summary uses three real run medians, never a single lucky score',()=>{
  const dir=mkdtempSync(join(tmpdir(),'mnebyvpn-lighthouse-'));
  try{
    for(const device of ['mobile','desktop']){
      const perf=device==='mobile'?[81,94,90]:[97,99,98];
      const lcps=device==='mobile'?[3751,2436,2800]:[531,569,550];
      for(let i=0;i<3;i++){
        const audits:Record<string,unknown>={
          'first-contentful-paint':{numericValue:device==='mobile'?2851-i*160:490+i*20},
          'largest-contentful-paint':{numericValue:lcps[i]},
          'cumulative-layout-shift':{numericValue:0.003},
          'total-blocking-time':{numericValue:29+i*8},
          'speed-index':{numericValue:3900+i*100},
          'network-requests':{details:{items:[{url:homepage+'bg3.mp4',transferSize:166000}]}},
        };
        const lhr={lighthouseVersion:'13.6.0',requestedUrl:homepage,finalDisplayedUrl:homepage,
          fetchTime:'2026-11-21T11:39:00Z',
          categories:{performance:{score:perf[i]/100},seo:{score:1}},
          audits};
        writeFileSync(join(dir,device+'-'+(i+1)+'.json'),JSON.stringify(lhr));
      }
    }
    const result=spawnSync(process.execPath,[script,dir],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    const summary=JSON.parse(readFileSync(join(dir,'summary.json'),'utf8'));
    assert.equal(summary.kind,'real-production-lab');
    assert.equal(summary.summary[0].runCount,3);
    assert.equal(summary.summary[0].performanceScore,90);
    assert.deepEqual(summary.summary[0].performanceRange,{min:81,max:94});
    assert.equal(summary.summary[0].metrics['largest-contentful-paint'].value,2800);
    assert.equal(summary.summary[1].performanceScore,98);
    assert.equal(summary.summary[1].metrics['largest-contentful-paint'].value,550);
    assert.match(result.stdout,/LIGHTHOUSE_MEDIAN_MOBILE=/);

    unlinkSync(join(dir,'mobile-3.json'));
    const incomplete=spawnSync(process.execPath,[script,dir],{encoding:'utf8',timeout:10000});
    assert.notEqual(incomplete.status,0,'missing third sample must not silently pass');
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
