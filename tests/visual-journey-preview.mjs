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
  durationDays,rubMinor:[6000,9900,19900,24900][i],deviceLimit:1,
}));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.webp':'image/webp',
  '.mp4':'video/mp4','.webm':'video/webm'};
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
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.VISUAL_CHROME_PATH?{executablePath:process.env.VISUAL_CHROME_PATH}:{})});
let failed=false;
for(const [width,height] of [[320,700],[360,700],[390,700],[360,740],[390,844],[390,1000],[1440,900]]){
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  const browserErrors=[];
  page.on('pageerror',error=>browserErrors.push(String(error.message).slice(0,250)));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{
    const frame=document.querySelector('#journey-front-frame');
    const btn=frame?.contentDocument?.querySelector('.plan[data-d="30"] strong');
    return document.body.classList.contains('journey-active')&&btn&&btn.textContent!=='—'
      && !frame?.contentDocument?.querySelector('.cta')?.disabled;
  },{timeout:15000});
  // The design fades its title and tariff card in over ~1.5 seconds.
  // Capture settled pixels, not an initially transparent card.
  await page.waitForFunction(()=>{
    const inner=document.querySelector('#journey-front-frame')?.contentDocument;
    const card=inner?.querySelector('.card');
    const heading=inner?.querySelector('.hero h1');
    return card&&heading &&
      Number(getComputedStyle(card).opacity)>=0.99 &&
      Number(getComputedStyle(heading).opacity)>=0.99;
  },null,{timeout:10000});
  const metrics=await page.evaluate(()=>{
    const frame=document.querySelector('#journey-front-frame');
    const inner=frame.contentDocument;
    const art=inner.querySelector('.app');
    return{
      width:innerWidth,height:innerHeight,
      frontTop:Math.round(frame.getBoundingClientRect().top),
      footerBottomGap:Math.round(innerHeight-inner.querySelector('footer').getBoundingClientRect().bottom),
      iframeBottomGap:Math.round(innerHeight-frame.getBoundingClientRect().bottom),
      fullFrameBackground:inner.querySelector('.app').getBoundingClientRect().height>=innerHeight-2,
      videoUncroppedAspect:Math.abs(inner.querySelector('.scene').getBoundingClientRect().width/
        inner.querySelector('.scene').getBoundingClientRect().height-(9/16))<0.005,
      outerScrollHeight:document.documentElement.scrollHeight,
      outerCanScroll:document.documentElement.scrollHeight>innerHeight+2,
      headerSingleRow:(()=>{
        const links=[...inner.querySelectorAll('.top>*')].map(x=>x.getBoundingClientRect());
        return links.every(x=>x.bottom>0)&&Math.max(...links.map(x=>x.top))-Math.min(...links.map(x=>x.top))<=12;
      })(),
      topButtonsUnwrapped:[...inner.querySelectorAll('.top .pill')].every(x=>x.getBoundingClientRect().height<43),
      headerFits:inner.querySelector('.top').getBoundingClientRect().right<=frame.getBoundingClientRect().width+1,
      legalSingleRow:(()=>{
        const links=[...inner.querySelectorAll('.legal-links a')];
        return links.length===2&&Math.abs(links[0].getBoundingClientRect().top-links[1].getBoundingClientRect().top)<=2;
      })(),
      footerVisible:inner.querySelector('footer').getBoundingClientRect().bottom<=innerHeight+3,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      frameWidth:Math.round(frame.getBoundingClientRect().width),
      frameHeight:Math.round(frame.getBoundingClientRect().height),
      artBottom:Math.round(art.getBoundingClientRect().bottom),
      innerHorizontalOverflow:inner.documentElement.scrollWidth>frame.contentWindow.innerWidth+1,
      iframeHasHeader:Boolean(inner.querySelector('.top .brand')),
      iframeHasEarth:Boolean(inner.querySelector('.kb')),
      lockTop:Math.round(inner.querySelector('.lock').getBoundingClientRect().top),
      lockWidth:Math.round(inner.querySelector('.lock').getBoundingClientRect().width),
      cardTop:Math.round(inner.querySelector('.card').getBoundingClientRect().top),
      backdropFilter:getComputedStyle(inner.querySelector('.card')).backdropFilter,
      canvasPresent:Boolean(inner.querySelector('canvas')),
      introFilter:getComputedStyle(inner.querySelector('.card')).filter,
      videoPresent:Boolean(inner.querySelector('video#bgv')),
      videoSources:inner.querySelectorAll('video#bgv source').length,
      iframeHasTariffs:inner.querySelectorAll('.plans-vpn .plan').length===4 && inner.querySelectorAll('.plans-dns .plan').length===4,
      dnsPrices:[...inner.querySelectorAll('.plans-dns .plan strong')].map(el=>el.textContent.trim()),
      vpnFirst:inner.querySelector('.plans-vpn .plan[data-d="15"]').getAttribute('aria-pressed'),
      cardOpacity:Number(getComputedStyle(inner.querySelector('.card')).opacity),
      price:inner.querySelector('.plan[data-d="30"] strong').textContent,
      selected:inner.querySelector('.plan[data-d="15"]').getAttribute('aria-pressed'),
      buyText:inner.querySelector('.cta').textContent,
      trialVisible:getComputedStyle(inner.querySelector('.free')).display!=='none',
      retryVisible:getComputedStyle(inner.querySelector('#front-retry')).display!=='none',
    };
  });
  const file=process.env.RUNNER_TEMP+'/mnebyvpn-'+width+'x'+height+'.jpg';
  await page.screenshot({path:file,type:'jpeg',quality:72,fullPage:true,timeout:20000});
  console.log('VISUAL_METRICS_'+width+'='+JSON.stringify({...metrics,browserErrors}));
  if(metrics.horizontalOverflow||metrics.innerHorizontalOverflow||browserErrors.length||
    !metrics.iframeHasHeader||!metrics.iframeHasEarth||!metrics.iframeHasTariffs||
    JSON.stringify(metrics.dnsPrices)!==JSON.stringify(['120 ₽','199 ₽','379 ₽','549 ₽'])||
    !metrics.videoPresent||metrics.retryVisible||metrics.cardOpacity<0.99||
    metrics.backdropFilter!=='none'||metrics.canvasPresent||metrics.introFilter!=='none'||
    (width<=390&&(metrics.lockWidth>52||metrics.cardTop>270))||
    !metrics.headerSingleRow||!metrics.topButtonsUnwrapped||!metrics.headerFits||
    !metrics.legalSingleRow||metrics.frontTop>12||
    (width<=390&&(metrics.iframeBottomGap>12||!metrics.fullFrameBackground||
      !metrics.videoUncroppedAspect))||
    !metrics.trialVisible||metrics.selected!=='true'||
    metrics.frameWidth>480||metrics.frameWidth<Math.min(360,width)||
    Math.abs(metrics.frameHeight-metrics.artBottom)>28||
    (width<=390&&metrics.outerScrollHeight>metrics.height+280)||
    !metrics.price.includes('₽'))failed=true;
  if(process.env.VISUAL_SCREENSHOT_INLINE==='yes'){
    console.log('VISUAL_JPEG_'+width+'_BEGIN');
    console.log(readFileSync(file).toString('base64'));
    console.log('VISUAL_JPEG_'+width+'_END');
  }
  // DNS info is a real keyboard-accessible dialog. It must name target
  // services accurately without promising all are operational right now.
  await page.frameLocator('#journey-front-frame').locator('#dns-info-open').click();
  const info=await page.frameLocator('#journey-front-frame').locator('#dns-info-dialog');
  if(!await info.isVisible())failed=true;
  const infoContent=await info.textContent();
  if(!['YouTube','ChatGPT','Gemini','Claude','Antigravity','Grok','TikTok','X'].every(x=>infoContent.includes(x))||
    !infoContent.includes('домен')||!infoContent.includes('VPN'))failed=true;
  await page.frameLocator('#journey-front-frame').locator('#dns-info-close').click();
  if(await info.isVisible())failed=true;
  // One VPN and one DNS may be selected at the same time. No iframe
  // reloads, fade-ins or route changes are allowed during tariff taps.
  await page.evaluate(()=>{
    window.__frontLoads=0;
    document.querySelector('#journey-front-frame')
      .addEventListener('load',()=>window.__frontLoads++);
  });
  await page.frameLocator('#journey-front-frame').locator('.plans-dns .plan[data-d="30"]').click();
  const bothSelected=await page.evaluate(()=>{
    const inner=document.querySelector('#journey-front-frame').contentDocument;
    return{
      vpn:inner.querySelector('.plans-vpn .plan[data-d="15"]').getAttribute('aria-pressed'),
      dns:inner.querySelector('.plans-dns .plan[data-d="30"]').getAttribute('aria-pressed'),
      summary:inner.querySelector('#sum').textContent,
      buyText:inner.querySelector('.cta').textContent,
      buyEnabled:!inner.querySelector('.cta').disabled,
      frameLoads:window.__frontLoads,
      opacity:getComputedStyle(inner.querySelector('.card')).opacity,
    };
  });
  console.log('DUAL_SELECTION_'+width+'='+JSON.stringify(bothSelected));
  if(bothSelected.vpn!=='true'||bothSelected.dns!=='true'||
     !bothSelected.summary.includes('VPN')||!bothSelected.summary.includes('Smart DNS')||
     !bothSelected.summary.includes('199 ₽')||
     bothSelected.buyText!=='Оформить только VPN'||!bothSelected.buyEnabled||
     bothSelected.frameLoads!==0||Number(bothSelected.opacity)<0.99)failed=true;
  await page.frameLocator('#journey-front-frame').locator('.plans-vpn .plan[data-d="30"]').click();
  await page.waitForFunction(()=>document.querySelector('#journey-summary')?.textContent?.includes('30 дней'));
  const persisted=await page.evaluate(()=>{
    const inner=document.querySelector('#journey-front-frame').contentDocument;
    return{
      vpn30:inner.querySelector('.plans-vpn .plan[data-d="30"]').getAttribute('aria-pressed'),
      dns30:inner.querySelector('.plans-dns .plan[data-d="30"]').getAttribute('aria-pressed'),
      frameLoads:window.__frontLoads,
    };
  });
  console.log('DUAL_PERSISTED_'+width+'='+JSON.stringify(persisted));
  if(persisted.vpn30!=='true'||persisted.dns30!=='true'||persisted.frameLoads!==0)failed=true;
  // A second tap removes only the selected DNS tariff; VPN stays selected.
  await page.frameLocator('#journey-front-frame').locator('.plans-dns .plan[data-d="30"]').click();
  const cleared=await page.evaluate(()=>{
    const inner=document.querySelector('#journey-front-frame').contentDocument;
    return{
      vpn30:inner.querySelector('.plans-vpn .plan[data-d="30"]').getAttribute('aria-pressed'),
      dns30:inner.querySelector('.plans-dns .plan[data-d="30"]').getAttribute('aria-pressed'),
      price:inner.querySelector('#sum').textContent,
      frameLoads:window.__frontLoads,
    };
  });
  if(cleared.vpn30!=='true'||cleared.dns30!=='false'||cleared.frameLoads!==0||
     !cleared.price.includes('VPN'))failed=true;
  // DNS alone is a preview, never sends a VPN purchase by accident.
  await page.frameLocator('#journey-front-frame').locator('.plans-vpn .plan[data-d="30"]').click();
  await page.frameLocator('#journey-front-frame').locator('.plans-dns .plan[data-d="60"]').click();
  const dnsOnly=await page.evaluate(()=>{
    const inner=document.querySelector('#journey-front-frame').contentDocument;
    return{
      selected:inner.querySelector('.plans-dns .plan[data-d="60"]').getAttribute('aria-pressed'),
      disabled:inner.querySelector('.cta').disabled,
      text:inner.querySelector('.cta').textContent,
      frameLoads:window.__frontLoads,
    };
  });
  if(dnsOnly.selected!=='true'||!dnsOnly.disabled||
    !dnsOnly.text.includes('скоро')||dnsOnly.frameLoads!==0)failed=true;
  await page.frameLocator('#journey-front-frame').locator('.plans-vpn .plan[data-d="30"]').click();
  await page.frameLocator('#journey-front-frame').locator('.try').click();
  if(!await page.frameLocator('#journey-front-frame').locator('#trial-options').isVisible())failed=true;
  await page.frameLocator('#journey-front-frame').locator('#trial-dns').click();
  const trialDns=await page.frameLocator('#journey-front-frame').locator('#trial-dns-status');
  if(!await trialDns.isVisible())failed=true;
  if(await page.evaluate(()=>document.body.dataset.journeyView!=='plans'))failed=true;
  await page.frameLocator('#journey-front-frame').locator('#trial-vpn').click();
  await page.waitForFunction(()=>document.body.dataset.journeyView==='trial-auth');
  const trial=await page.evaluate(()=>{
    const form=document.querySelector('#email-start-form');
    const panel=document.querySelector('#email-auth-panel');
    const button=document.querySelector('#journey-trial-telegram');
    const mount=document.querySelector('#journey-email-mount');
    return {
      route:location.hash,
      emailMounted:mount?.contains(form),
      emailVisible:panel&&!panel.classList.contains('hidden'),
      telegram:button?.getAttribute('aria-disabled'),
      telegramExplained:document.querySelector('.journey-telegram-method .journey-telegram-note')?.textContent,
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
      trialTitle:document.querySelector('#journey-trial-title')?.textContent,
      emailButton:(()=>{
        const input=document.querySelector('#email-input')?.getBoundingClientRect();
        const button=document.querySelector('#email-send-button');
        const rect=button?.getBoundingClientRect();
        return rect&&input?{
          width:Math.round(rect.width),height:Math.round(rect.height),
          centerDelta:Math.round((rect.left+rect.width/2)-(input.left+input.width/2)),
          radius:parseFloat(getComputedStyle(button).borderTopRightRadius),
          leftRadius:parseFloat(getComputedStyle(button).borderTopLeftRadius),
        }:null;
      })(),
    };
  });
  const authImage=process.env.RUNNER_TEMP+'/mnebyvpn-trial-auth-'+width+'x'+height+'.jpg';
  await page.screenshot({path:authImage,type:'jpeg',quality:72,fullPage:true,timeout:20000});
  console.log('TRIAL_AUTH_METRICS_'+width+'='+JSON.stringify({...trial,browserErrors}));
  if(!trial.emailMounted||!trial.emailVisible||!trial.telegramExplained?.includes('email')||
     trial.horizontalOverflow||browserErrors.length||trial.route!=='#try'||
     !trial.emailButton||Math.abs(trial.emailButton.centerDelta)>5||
     trial.emailButton.width<200||trial.emailButton.height>54||
     trial.emailButton.radius<20||trial.emailButton.leftRadius!==trial.emailButton.radius)failed=true;
  if(process.env.VISUAL_SCREENSHOT_INLINE==='yes'){
    console.log('TRIAL_AUTH_JPEG_'+width+'_BEGIN');
    console.log(readFileSync(authImage).toString('base64'));
    console.log('TRIAL_AUTH_JPEG_'+width+'_END');
  }
  await page.locator('#journey-trial-back').click();
  const returned=await page.evaluate(()=>({
    home:document.body.dataset.journeyView==='plans',
    emailRestored:document.querySelector('.account-panel')?.contains(
      document.querySelector('#email-start-form')),
  }));
  if(!returned.home||!returned.emailRestored){
    console.error('TRIAL_AUTH_BACK_FAILED',JSON.stringify(returned));failed=true;
  }
  await page.close();
}

/* Real Android regression: iframe may load before journey.js is available.
 * Delaying the parent controller must NOT leave the tariff grid in 'loading'.
 */
{
  const page=await browser.newPage({viewport:{width:360,height:740},
    userAgent:'Mozilla/5.0 (Linux; Android 13; SM-N985F) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'});
  await page.route('**/journey.js',async route=>{
    await new Promise(resolve=>setTimeout(resolve,1800));
    await route.continue();
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{
    const doc=document.querySelector('#journey-front-frame')?.contentDocument;
    return document.body.classList.contains('journey-active') &&
      doc?.querySelector('.plan[data-d="30"] strong')?.textContent?.includes('₽') &&
      !doc.querySelector('.cta')?.disabled;
  },null,{timeout:15000});
  const result=await page.evaluate(()=>{
    const frame=document.querySelector('#journey-front-frame');
    return {
      top:Math.round(frame.getBoundingClientRect().top),
      price:frame.contentDocument.querySelector('.plan[data-d="30"] strong').textContent,
      button:frame.contentDocument.querySelector('.cta').textContent,
      reloadVisible:getComputedStyle(frame.contentDocument.querySelector('#front-retry')).display!=='none',
      error:frame.contentDocument.querySelector('#front-error').textContent,
    };
  });
  console.log('ANDROID_SLOW_PARENT_HANDSHAKE='+JSON.stringify(result));
  if(result.top>12||result.reloadVisible||!result.price.includes('₽')||result.error)failed=true;
  await page.close();
}
// The tariff service can fail. Never leave the visual frame spinning forever.
{
  const page=await browser.newPage({viewport:{width:390,height:700}});
  await page.route('**/api/plans',route=>route.fulfill({
    status:503,contentType:'application/json',body:'{"code":"TEMP_UNAVAILABLE"}',
  }));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{
    const doc=document.querySelector('#journey-front-frame')?.contentDocument;
    return doc?.querySelector('.cta')?.textContent==='Тариф пока недоступен';
  },null,{timeout:15000});
  const result=await page.evaluate(()=>{
    const doc=document.querySelector('#journey-front-frame').contentDocument;
    return {
      loading:doc.querySelector('.cta').textContent.includes('Загрузка'),
      retryVisible:getComputedStyle(doc.querySelector('#front-retry')).display!=='none',
      retryTopLevel:doc.querySelector('#front-retry').getAttribute('target')==='_top',
      purchaseDisabled:doc.querySelector('.cta').disabled,
    };
  });
  console.log('CATALOG_FAILURE_FALLBACK='+JSON.stringify(result));
  if(result.loading||!result.retryVisible||!result.retryTopLevel||!result.purchaseDisabled)failed=true;
  await page.close();
}
// Verify the original owner video loads on normal connections and stays
// optional for visitors who requested reduced motion.
{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{
    const v=document.querySelector('#journey-front-frame')?.contentDocument?.querySelector('#bgv');
    return v?.videoWidth===432 && v?.videoHeight===768 &&
      v.querySelectorAll('source').length===2;
  },{timeout:15000});
  console.log('VIDEO_ASSET_SMOKE=played_or_loaded_metadata');
  await page.close();
  const reduced=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await reduced.goto(base,{waitUntil:'networkidle'});
  const optOut=await reduced.evaluate(()=>{
    const inner=document.querySelector('#journey-front-frame')?.contentDocument;
    const v=inner?.querySelector('#bgv');
    return {videoSources:v?.querySelectorAll('source').length,
      fallbackVisible:!inner?.querySelector('.scene')?.classList.contains('vid')};
  });
  console.log('VIDEO_REDUCED_MOTION='+JSON.stringify(optOut));
  if(optOut.videoSources!==0||!optOut.fallbackVisible)failed=true;
  await reduced.close();
}
// Branded checkout visual acceptance: real authenticated route, no card data
// entry and no provider HTTP call before the explicit confirmation click.
{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  let checkoutCalls=0;
  page.on('pageerror',error=>{console.error('ORDER_PAGE_ERROR',String(error.message));failed=true;});
  await page.route('**/api/me',route=>route.fulfill({
    status:200,contentType:'application/json',
    body:JSON.stringify({csrf:'visual-order-csrf',
      identity:{email:'visual-test@example.com',emailLinked:true,telegramLinked:false},
      access:[],orders:[]}),
  }));
  await page.route('**/api/checkout',route=>{
    checkoutCalls++;
    return route.fulfill({status:500,contentType:'application/json',body:'{"code":"BLOCKED_BY_VISUAL_TEST"}'});
  });
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.body.classList.contains('journey-active')&&
    !document.querySelector('#journey-buy').disabled);
  // Initial VPN 15-day tariff is already active; a second tap deselects it.
  // Change to 30 and back to exercise the parent's real catalog selection.
  await page.frameLocator('#journey-front-frame').locator('.plans-vpn .plan[data-d="30"]').click();
  await page.frameLocator('#journey-front-frame').locator('.plans-vpn .plan[data-d="15"]').click();
  await page.frameLocator('#journey-front-frame').locator('.cta').click();
  await page.waitForFunction(()=>document.body.dataset.journeyView==='checkout');
  const order=await page.evaluate(()=>({
    route:location.hash,
    total:document.querySelector('#journey-order-price')?.textContent,
    period:document.querySelector('#journey-order-period')?.textContent,
    email:document.querySelector('#journey-order-email')?.textContent,
    confirmEnabled:!document.querySelector('#journey-order-pay')?.disabled,
    hasCardFields:!!document.querySelector('.journey-order input[type="tel"],.journey-order input[autocomplete="cc-number"]'),
    screenHasProviderBrand:document.querySelector('.journey-order')?.textContent?.includes('Prodamus'),
    hasHorizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,
  }));
  const image=process.env.RUNNER_TEMP+'/mnebyvpn-branded-order-390x844.jpg';
  await page.screenshot({path:image,type:'jpeg',quality:75,fullPage:true});
  console.log('BRANDED_CHECKOUT_METRICS='+JSON.stringify({...order,checkoutCalls}));
  if(process.env.VISUAL_SCREENSHOT_INLINE==='yes'){
    console.log('BRANDED_ORDER_JPEG_BEGIN');
    console.log(readFileSync(image).toString('base64'));
    console.log('BRANDED_ORDER_JPEG_END');
  }
  if(order.route!=='#checkout'||!order.email?.includes('visual-test@example.com')||
    order.total==='—'||!order.confirmEnabled||order.hasCardFields||
    order.screenHasProviderBrand||order.hasHorizontalOverflow||checkoutCalls!==0)failed=true;
  await page.locator('#journey-order-back').click();
  if(await page.locator('#journey-landing').isHidden())failed=true;
  await page.close();
}
// Synthetic *end-to-end* email OTP and trial request (no customer records,
 // external email or paid orders). Verifies that clicking Try does not issue
 // an anonymous trial and the server-backed grant occurs after OTP only.
{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  let verified=false,trialCalls=0;
  page.on('pageerror',error=>{
    console.error('TRIAL_OTP_PAGE_ERROR',String(error.message));failed=true;
  });
  await page.route('**/api/me',route=>route.fulfill({
    status:verified?200:401,contentType:'application/json',
    body:JSON.stringify(verified?{
      csrf:'visual-test-csrf',identity:{email:'visual-test@example.com',
        emailLinked:true,telegramLinked:false},
      access:[],orders:[],
    }:{code:'LOGIN_REQUIRED'}),
  }));
  await page.route('**/api/auth/email/start',route=>route.fulfill({
    status:200,contentType:'application/json',body:'{"status":"SENT"}',
  }));
  await page.route('**/api/auth/email/verify',route=>{
    verified=true;
    return route.fulfill({status:200,contentType:'application/json',body:'{"status":"SIGNED_IN"}'});
  });
  await page.route('**/api/trial',route=>{
    trialCalls++;
    return route.fulfill({status:200,contentType:'application/json',body:'{"status":"GRANTED"}'});
  });
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.body.classList.contains('journey-active')&&
    !document.querySelector('#journey-trial').disabled);
  await page.frameLocator('#journey-front-frame').locator('.try').click();
  await page.frameLocator('#journey-front-frame').locator('#trial-vpn').click();
  if(trialCalls!==0)failed=true;
  await page.locator('#email-input').fill('visual-test@example.com');
  await page.locator('#email-send-button').click();
  await page.locator('#email-code-input').fill('123456');
  await page.locator('#email-verify-button').click();
  try{await page.waitForFunction(()=>document.body.dataset.journeyView==='setup',{timeout:7000});}
  catch{failed=true;}
  const actual=await page.evaluate(()=>({
    view:document.body.dataset.journeyView,
    title:document.querySelector('#journey-setup-title')?.textContent,
    emailFormDuplicates:document.querySelectorAll('#email-start-form').length,
  }));
  console.log('TRIAL_EMAIL_OTP_SMOKE='+JSON.stringify({...actual,trialCalls}));
  if(actual.view!=='setup'||trialCalls!==1||actual.emailFormDuplicates!==1)failed=true;
  await page.close();
}
await browser.close();
server.close();
if(failed){
  console.error('VISUAL_ACCEPTANCE_FAILED: overflow, page error or invalid trial auth at required viewport');
  process.exitCode=1;
}else{
  console.log('VISUAL_ACCEPTANCE_PASSED: all required viewports fit without scroll');
}
