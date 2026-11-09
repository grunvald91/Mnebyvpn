/**
 * Local visual acceptance of the REAL storefront HTML/CSS/JS, with isolated
 * synthetic catalog data (no Prodamus, customer accounts or production APIs).
 * Run from GitHub Actions only; screenshots are an audit, not a design mock.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../apps/web/public');
const plans=[15,30,60,90].map((durationDays,i)=>({
  id:'vpn_'+durationDays+'d_1device',
  title:'VPN '+durationDays+' дней',product:'vpn',
  durationDays,rubMinor:[6000,9900,18000,26000][i],deviceLimit:1,
}));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.webp':'image/webp'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/plans'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({plans,checkoutEnabled:true,loginEnabled:true,
      telegramLoginEnabled:true,emailLoginEnabled:true,trialOffers:['vpn']}));
    return;
  }
  if(url.pathname==='/api/me'){
    res.writeHead(401,{'Content-Type':'application/json'});
    res.end(JSON.stringify({code:'LOGIN_REQUIRED'}));return;
  }
  if(url.pathname.startsWith('/api/support/')){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({available:true,tickets:[]}));return;
  }
  const asset=url.pathname==='/'?'/index.html':url.pathname;
  const pathname=path.resolve(publicDir,'.'+asset);
  if(!pathname.startsWith(publicDir+path.sep)){
    res.writeHead(403);res.end();return;
  }
  try{
    const bytes=readFileSync(pathname);
    res.writeHead(200,{'Content-Type':types[path.extname(pathname)]||'application/octet-stream',
      'Cache-Control':'no-store'});
    res.end(bytes);
  }catch{
    res.writeHead(404);res.end('NOT_FOUND');
  }
});

const listen=()=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await listen();
const base='http://127.0.0.1:'+server.address().port;
const { chromium }=await import(process.env.VISUAL_PLAYWRIGHT_PACKAGE||'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
let failed=false;
for(const [width,height] of [[390,844],[360,740],[1440,900]]){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const browserErrors=[];
  page.on('pageerror',error=>browserErrors.push(String(error.message).slice(0,250)));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.body.classList.contains('journey-active')&&
    document.querySelector('[data-journey-price="30"]')?.textContent!=='—');
  const metrics=await page.evaluate(()=>{
    const card=document.querySelector('.journey-checkout');
    const intro=document.querySelector('.journey-intro');
    const footer=document.querySelector('.footer');
    const rect=x=>{const r=x.getBoundingClientRect();
      return {top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height)}};
    return{
      width:innerWidth,height:innerHeight,
      documentHeight:document.documentElement.scrollHeight,
      bodyHeight:document.body.scrollHeight,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      scrollExtra:document.documentElement.scrollHeight-innerHeight,
      card:rect(card),intro:rect(intro),footer:rect(footer),
      selected:document.querySelector('[data-journey-days="30"]')?.getAttribute('aria-pressed'),
      isJourney:document.body.classList.contains('journey-active'),
    };
  });
  const file=process.env.RUNNER_TEMP+'/mnebyvpn-'+width+'x'+height+'.jpg';
  await page.screenshot({path:file,type:'jpeg',quality:72,fullPage:true});
  console.log('VISUAL_METRICS_'+width+'='+JSON.stringify({...metrics,browserErrors}));
  if(metrics.scrollExtra>2||metrics.horizontalOverflow||browserErrors.length)failed=true;
  if(process.env.VISUAL_SCREENSHOT_INLINE==='yes'){
    console.log('VISUAL_JPEG_'+width+'_BEGIN');
    console.log(readFileSync(file).toString('base64'));
    console.log('VISUAL_JPEG_'+width+'_END');
  }
  await page.close();
}
await browser.close();
server.close();
if(failed){
  console.error('VISUAL_ACCEPTANCE_FAILED: overflow or page error at a required viewport');
  process.exitCode=1;
}else{
  console.log('VISUAL_ACCEPTANCE_PASSED: all required viewports fit without scroll');
}
