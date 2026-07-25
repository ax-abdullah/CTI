// Mock HubSpot: OAuth token + Call engagement creation.
// Usage: node scripts/mock-hubspot.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4300);
const VALID = { client_secret: 'mock-hs-client-secret', refresh_token: 'mock-hs-refresh-token' };
let tok = 0;
let call = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'POST' && url.pathname === '/oauth/v1/token') {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== VALID.client_secret || p.get('refresh_token') !== VALID.refresh_token) {
        res.writeHead(401).end(JSON.stringify({ status: 'BAD_AUTH' }));
        return;
      }
      const token = `mock-hs-access-${++tok}`;
      console.log(`TOKEN ISSUED ${token}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, expires_in: 1800 }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/crm/v3/objects/calls') {
      console.log(`CALL CREATE auth="${req.headers.authorization}" body=${body}`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `hs-call-${++call}` }));
      return;
    }
    res.writeHead(404).end();
  });
}).listen(port, () => console.log(`Mock HubSpot listening on :${port}`));
