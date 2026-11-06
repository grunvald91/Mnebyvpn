/**
 * Loopback-only payment integration runner for offline tests.
 * Public deployment requires HTTPS reverse proxy, auth & rate limits, managed
 * secrets and official provider test transactions. DO NOT expose this as-is.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { PgBillingStore } from '../../../packages/billing/src/store.ts';
import { handleTelegramUpdate, handleProdamusDelivery, type TelegramUpdate } from '../../../packages/billing/src/handlers.ts';
import { parseProdamusFormData } from '../../../packages/billing/src/multipart.ts';
import type { ProdamusConfig } from '../../../packages/billing/src/prodamus.ts';
import type {PayformLinkTransport} from '../../../packages/billing/src/website-checkout.ts';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.length < 1) throw new Error('Missing env config: '+name);
  return v;
};
const safeStringCompare = (expected: string, actual: string | undefined): boolean => {
  if (!actual) return false;
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function readBounded(req: IncomingMessage, maxBytes = 128 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('Payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
const response = (res: ServerResponse, status: number, message: string): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.writeHead(status).end(message);
};
class TelegramHttp {
  private readonly token: string;
  constructor(token: string) { this.token = token; }
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!/^[A-Za-z]+$/.test(method)) throw new Error('Invalid Bot API method');
    const result = await fetch('https://api.telegram.org/bot'+this.token+'/'+method,{
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify(params),signal:AbortSignal.timeout(
        method==='answerPreCheckoutQuery'||method==='answerWidgetQuery'?3000:8500),
    });
    const data: unknown = await result.json();
    if (!result.ok || !data || typeof data !== 'object' || (data as {ok?:boolean}).ok !== true)
      throw new Error('Telegram Bot API call failed');
    return (data as {result?:unknown}).result;
  }
}
function getConfig(): {db:string; bot:TelegramHttp; tgSecret:string; starsSecret:string; pd:ProdamusConfig;botUsername?:string;
  tgRubleTransport?:PayformLinkTransport} {
  const env = required('MNEBYVPN_ENV');
  if (env !== 'offline-test') throw new Error('Only offline-test runner is enabled');
  const db=required('DATABASE_URL');
  const tgSecret=required('TELEGRAM_WEBHOOK_SECRET');
  const starsSecret=required('STARS_PAYLOAD_SECRET');
  const formSecret=required('PRODAMUS_SIGN_SECRET');
  if (tgSecret.length<24 || starsSecret.length<32 || formSecret.length<32) throw new Error('Secrets too short');
  const tgRubleTransport:PayformLinkTransport|undefined=
    process.env.MNEBYVPN_TG_RUB_LINKS_EXPLICIT==='true'?{
      getLink:async(signedUrl:string)=>{
        const url=new URL(signedUrl);
        if(url.protocol!=='https:'||url.username||url.password||
           !(url.hostname==='payform.ru'||url.hostname.endsWith('.payform.ru')))
          throw new Error('Unapproved Prodamus merchant host');
        const response=await fetch(signedUrl,{signal:AbortSignal.timeout(8000)});
        if(!response.ok)throw new Error('Prodamus link request failed');
        return (await response.text()).trim();
      },
    }:undefined;
  return {
    db, bot:new TelegramHttp(required('TELEGRAM_BOT_TOKEN')),
    tgRubleTransport,
    tgSecret,starsSecret,botUsername:process.env.TELEGRAM_BOT_USERNAME,
    pd:{
      formUrl:required('PRODAMUS_FORM_URL'),
      notificationUrl:required('PRODAMUS_NOTIFICATION_URL'),
      successUrl:required('PRODAMUS_SUCCESS_URL'),
      returnUrl:required('PRODAMUS_RETURN_URL'),
      secret:formSecret,
    },
  };
}
export function startOfflinePaymentsServer(): void {
  const config=getConfig();
  const db=new PgBillingStore(new Pool({connectionString:config.db,max:3,connectionTimeoutMillis:3000}));
  const server=createServer(async (req,res)=>{
    try {
      if (req.method==='GET' && req.url==='/healthz') {
        response(res,200,'OK'); return;
      }
      if (req.method !== 'POST') { response(res,404,'NOT_FOUND'); return; }
      if (req.url === '/webhooks/telegram') {
        const provided=req.headers['x-telegram-bot-api-secret-token'];
        if (typeof provided !== 'string' || !safeStringCompare(config.tgSecret,provided)) {
          response(res,401,'UNAUTHORIZED'); return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
          response(res,415,'UNSUPPORTED_MEDIA_TYPE'); return;
        }
        const update=JSON.parse((await readBounded(req)).toString('utf8')) as TelegramUpdate;
        if (!Number.isSafeInteger(update.update_id)) {response(res,400,'BAD_UPDATE'); return;}
        await handleTelegramUpdate(update,db,config.bot,{
          starsPayloadSecret:config.starsSecret,prodamus:config.pd,
          telegramBotUsername:config.botUsername,
          prodamusTelegramLink:config.tgRubleTransport,
        });
        response(res,200,'OK');
        return;
      }
      if (req.url === '/webhooks/prodamus') {
        const sign=req.headers.sign;
        if (typeof sign !== 'string') {response(res,401,'UNSIGNED');return;}
        const ct=req.headers['content-type'];
        if (typeof ct !== 'string') {response(res,415,'UNSUPPORTED_MEDIA_TYPE');return;}
        const fields=await parseProdamusFormData(ct,await readBounded(req));
        const result=await handleProdamusDelivery(fields,sign,db,config.pd);
        response(res,result.statusCode,result.text);
        return;
      }
      response(res,404,'NOT_FOUND');
    } catch {
      // Do not print request bodies, personally identifiable data or payment credentials.
      response(res,503,'RETRY_LATER');
    }
  });
  // Never bind publicly while authentication/reconciliation is under development.
  const raw=process.env.MNEBYVPN_PORT ?? '8790';
  const port=Number(raw);
  if (!Number.isSafeInteger(port)||port<1||port>65535) throw new Error('Invalid port');
  server.listen(port,'127.0.0.1');
}
if (process.env.MNEBYVPN_ENV === 'offline-test') startOfflinePaymentsServer();
