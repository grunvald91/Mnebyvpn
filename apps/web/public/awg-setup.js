/* Native FI217 AmneziaWG setup. Private X25519 material NEVER leaves browser.
 * A server-issued grant is not enough: the read-only material endpoint
 * must verify the actual FI signed ACK before download.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9+/]{43}=$/;
const PKCS8_HEADER=[0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,
                    0x03,0x2b,0x65,0x6e,0x04,0x22,0x04,0x20];
const NO_CACHE={cache:'no-store',credentials:'same-origin',redirect:'error'};

export function canonicalAwgKey(input){
  if(typeof input!=='string'||!KEY.test(input))return false;
  try{
    const bytes=atob(input);
    return bytes.length===32&&btoa(bytes)===input&&
      [...bytes].some(c=>c.charCodeAt(0)!==0);
  }catch{return false;}
}
export function bytesToB64(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length!==32)
    throw Error('UNTRUSTED_AWG_KEY_BYTES');
  return btoa(String.fromCharCode(...bytes));
}
export async function generateLocalAwgKeyPair(webCrypto=globalThis.crypto){
  if(!webCrypto?.subtle||!webCrypto.getRandomValues)
    throw Error('X25519_UNAVAILABLE');
  let pair;
  try{
    pair=await webCrypto.subtle.generateKey({name:'X25519'},true,['deriveBits']);
  }catch{throw Error('X25519_UNAVAILABLE');}
  const publicBytes=new Uint8Array(await webCrypto.subtle.exportKey('raw',pair.publicKey));
  const der=new Uint8Array(await webCrypto.subtle.exportKey('pkcs8',pair.privateKey));
  if(der.length!==48||PKCS8_HEADER.some((byte,i)=>der[i]!==byte))
    throw Error('UNSUPPORTED_X25519_KEY_FORMAT');
  const priv=der.subarray(PKCS8_HEADER.length);
  const publicKey=bytesToB64(publicBytes);
  const privateKey=bytesToB64(priv);
  if(!canonicalAwgKey(publicKey)||!canonicalAwgKey(privateKey))
    throw Error('INVALID_X25519_KEY');
  return {publicKey,privateKey};
}

/** Local-only file writer; never POST privateKey or conf. */
export function renderNativeAwgConf(material,pair,now=Date.now()){
  if(!material||material.protocol!=='AmneziaWG 3.1'||
     material.nodeId!=='fi-test-01'||material.countryCode!=='FI'||
     material.endpoint!=='fi.mnebyvpn.site:51821'||
     !/^10\.73\.91\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])\/32$/.test(
       material.clientAddress??'')||
     material.mtu!==1280||!canonicalAwgKey(material.serverPublicKey)||
     !canonicalAwgKey(material.headerProtectionKey)||
     !canonicalAwgKey(material.clientPublicKey)||
     material.clientPublicKey!==pair?.publicKey||
     !canonicalAwgKey(pair?.privateKey)||
     !Number.isFinite(Date.parse(material.expiresAt))||
     Date.parse(material.expiresAt)<=now)
    throw Error('INVALID_SIGNED_FI_AWG_MATERIAL');
  return [
    '[Interface]',
    'Address = '+material.clientAddress,
    'PrivateKey = '+pair.privateKey,
    'MTU = 1280',
    'Jc = 0','Jmin = 0','Jmax = 0',
    'S1 = 16','S2 = 16','S3 = 16','S4 = 16',
    'H1 = 1','H2 = 2','H3 = 3','H4 = 4',
    'HeaderProtectionKey = '+material.headerProtectionKey,
    'RandomTrailers = on','DisableCookies = off',
    '',
    '[Peer]',
    'PublicKey = '+material.serverPublicKey,
    'Endpoint = '+material.endpoint,
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 10','',
  ].join('\n');
}

async function api(path,options={}){
  const res=await fetch(path,{...NO_CACHE,...options});
  let data;
  try{data=await res.json();}catch{throw Error('SERVICE_UNAVAILABLE');}
  if(!res.ok||!data||typeof data!=='object')
    throw Error(typeof data?.code==='string'?data.code:'SERVICE_UNAVAILABLE');
  return data;
}
function message(code){
  switch(code){
    case 'LOGIN_REQUIRED':return 'Сначала войдите в личный кабинет.';
    case 'AWG_DEVICE_ALREADY_BOUND':return 'Для этой подписки уже зарегистрировано другое устройство. Обратитесь в поддержку для безопасной смены ключа.';
    case 'AWG_ACCESS_DENIED':case 'AWG_DEVICE_NOT_ACTIVE':return 'Доступ пока не подтверждён. Проверьте подписку.';
    case 'X25519_UNAVAILABLE':return 'Браузер не поддерживает защищённую генерацию X25519. Откройте страницу в актуальном Chrome или другом совместимом браузере.';
    case 'AWG_REGISTRATION_NOT_READY':case 'AWG_DEVICE_QUEUE_UNAVAILABLE':return 'Регистрация временно недоступна.';
    default:return 'Не удалось завершить настройку. Проверьте интернет и попробуйте позже.';
  }
}
async function pause(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

export async function createFiAwgSetup(entitlementId,csrf,onProgress,transport=api){
  if(!UUID.test(entitlementId)||typeof csrf!=='string'||!csrf)
    throw Error('INVALID_ENTITLEMENT');
  onProgress('Создаём ключ на вашем устройстве…');
  const pair=await generateLocalAwgKeyPair();
  onProgress('Регистрируем публичный ключ через RU188…');
  await transport('/api/awg/fi/device',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
    body:JSON.stringify({entitlementId,peerPublicKey:pair.publicKey}),
  });
  // No private key in any request; poll the public-key state, not the
  // client's VPN socket. Client connections never wait for the controller.
  for(let i=0;i<48;i++){
    const query='/api/awg/fi/device/status?entitlementId='+
      encodeURIComponent(entitlementId)+'&peer='+encodeURIComponent(pair.publicKey);
    const result=await transport(query);
    if(result.state==='BLOCKED')throw Error('AWG_ACCESS_DENIED');
    if(result.state==='ACKNOWLEDGED'){
      onProgress('FI217 подтвердил применение доступа. Формируем файл…');
      const subscription=await transport('/api/vpn/subscription',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
        body:JSON.stringify({entitlementId}),
      });
      const url=new URL(subscription.subscriptionUrl);
      if(url.origin!=='https://cdn.servgo.ru:8443'||
         !/^\/sub\/[A-Za-z0-9_-]{43}$/.test(url.pathname)||
         url.search||url.hash)throw Error('UNTRUSTED_SUBSCRIPTION');
      const token=url.pathname.split('/')[2];
      const material=await transport('/awg/'+token+'/material?peer='+
        encodeURIComponent(pair.publicKey));
      const file=renderNativeAwgConf(material,pair);
      // Do not return the private key or configuration to logs or analytics.
      return {file,filename:'MNEBYVPN-FI-AmneziaWG.conf'};
    }
    if(!['QUEUED','PROCESSING','STAGED'].includes(result.state))
      throw Error('UNEXPECTED_AWG_STATE');
    onProgress(result.state==='STAGED'
      ?'FI217 применяет профиль и подписывает подтверждение…'
      :'Запрос принят. Ожидаем RU188 и FI217…');
    await pause(5000);
  }
  throw Error('AWG_REGISTRATION_TIMEOUT');
}

function init(){
  const btn=document.getElementById('awg-create');
  const status=document.getElementById('awg-state');
  const link=document.getElementById('awg-download');
  const details=document.getElementById('awg-detail');
  if(!btn||!status||!link||!details)return;
  const entitlementId=new URLSearchParams(location.search).get('entitlementId')??'';
  if(!UUID.test(entitlementId)){
    status.textContent='Откройте настройку из карточки действующей VPN-подписки.';
    return;
  }
  let csrf='';
  api('/api/me').then(me=>{
    const active=(me.access??[]).some(a=>
      a.id===entitlementId&&a.product==='vpn'&&
      a.state==='ACTIVE'&&a.secondsRemaining>0);
    if(!me.fiAwgRegistrationAvailable||!active||typeof me.csrf!=='string')
      throw Error('AWG_ACCESS_DENIED');
    csrf=me.csrf;
    btn.disabled=false;
    status.textContent='Можно создать персональный профиль для этого устройства.';
  }).catch(error=>{
    status.textContent=message(error?.message);
  });
  btn.addEventListener('click',async()=>{
    if(!csrf)return;
    btn.disabled=true;
    link.hidden=true;
    try{
      const {file,filename}=await createFiAwgSetup(
        entitlementId,csrf,text=>{status.textContent=text;});
      const objectUrl=URL.createObjectURL(new Blob([file],{type:'text/plain'}));
      link.href=objectUrl;
      link.download=filename;
      link.hidden=false;
      link.click();
      status.textContent='Профиль готов. Импортируйте скачанный файл в AmneziaWG.';
      details.textContent='Файл содержит приватный ключ. Не пересылайте его другим людям.';
      // Revoke the transient browser object URL after the download.
      setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);
    }catch(error){
      status.textContent=message(error?.message);
      // The device key was held ONLY in memory. Never retry with a different
      // key silently: an existing pending peer must be rotated by policy.
    }
  });
}
if(typeof document!=='undefined')init();
