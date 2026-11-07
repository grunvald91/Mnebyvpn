// Test-only preload: force Bot API failure without contacting Telegram.
// All local website requests still use the native fetch.
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{
  const url=typeof input==='string'?input:String(input?.url??input);
  if(url.startsWith('https://api.telegram.org/bot'))
    return Promise.reject(new Error('Simulated Bot API outage'));
  return nativeFetch(input,init);
};
