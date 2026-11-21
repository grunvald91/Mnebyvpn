/**
 * Read-only Lighthouse fixture. Serves REAL site assets with a synthetic,
 * fixed public catalog; never connects to the billing DB or production.
 * The host URL is 127.0.0.1 and is ephemeral for every audit.
 */
import http from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../apps/web/public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.webp':'image/webp',
  '.mp4':'video/mp4','.webm':'video/webm'};
const products=['vpn','smart_dns','bundle'];
const durations=[15,30,60,90];
const plans=products.flatMap((product,productIndex)=>durations.map((durationDays,i)=>({
  id:'perf_only_'+product+'_'+durationDays,
  title:product+' (test fixture) '+durationDays+' days',
  product,durationDays,
  rubMinor:[[8900,14900,26900,36900],[14900,24900,44900,59900],
    [24900,39900,69900,94900]][productIndex][i],
  deviceLimit:product==='bundle'?3:1,dnsQuotaQueriesPer30d:1000000,
})));
const catalog={plans,checkoutEnabled:true,loginEnabled:true,
  telegramLoginEnabled:false,emailLoginEnabled:true,trialOffers:['vpn']};
const bootstrap=Buffer.from(JSON.stringify(catalog),'utf8').toString('base64');

const server=http.createServer((req,res)=>{
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  const url=new URL(req.url??'/', 'http://127.0.0.1');
  if(url.pathname==='/api/plans'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify(catalog));return;
  }
  if(url.pathname==='/api/me'){
    res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({code:'LOGIN_REQUIRED'}));return;
  }
  if(url.pathname==='/api/auth/options'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({emailLoginEnabled:true,telegramLoginEnabled:false}));return;
  }
  if(url.pathname.startsWith('/api/')){
    res.writeHead(404,{'Cache-Control':'no-store'}).end();return;
  }
  const requested=url.pathname==='/'?'/index.html':url.pathname;
  const full=path.resolve(root,'.'+requested);
  if(!full.startsWith(root+path.sep)){
    res.writeHead(403).end();return;
  }
  try{
    let bytes=readFileSync(full);
    if(requested==='/index.html'){
      bytes=Buffer.from(bytes.toString('utf8').replace('</head>',
        '<meta name="mnebyvpn-public-catalog" content="'+bootstrap+'"></head>'));
    }
    res.writeHead(200,{'Content-Type':types[path.extname(full)]??'application/octet-stream',
      'Cache-Control':'no-store','X-Robots-Tag':'noindex'});
    res.end(bytes);
  }catch{
    res.writeHead(404).end('NOT_FOUND');
  }
});
server.listen(0,'127.0.0.1',()=>{
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('LISTENER_UNAVAILABLE');
  console.log('PERF_FIXTURE_URL=http://127.0.0.1:'+address.port+'/');
});
