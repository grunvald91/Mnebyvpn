/** Loopback-only diagnostics. All customer/data-plane endpoints remain blocked. */
import { createServer } from 'node:http';

const host = '127.0.0.1';
const portString = process.env.MNEBYVPN_PORT ?? '8789';
const port = Number(portString);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('MNEBYVPN_PORT must be an integer between 1 and 65535');
}

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end(JSON.stringify({ status: 'ok', component: 'service-scaffold' }));
  } else if (req.method === 'GET' && req.url === '/readyz') {
    res.writeHead(503).end(JSON.stringify({ ready: false, gates: [
      'DATABASE_NOT_CONNECTED', 'PAYMENTS_NOT_IMPLEMENTED',
      'VPN_OFFLINE_EXPIRY_UNVERIFIED', 'SMART_DNS_INGRESS_AUTH_UNVERIFIED',
      'SMART_DNS_ONWIRE_QUOTA_UNVERIFIED',
    ] }));
  } else {
    res.writeHead(404).end(JSON.stringify({ error: 'NOT_FOUND' }));
  }
});
server.listen(port, host, () => {
  console.info(`MNEBYVPN diagnostics listening on http://${host}:${port}`);
});
