// Mock Dynamics 365 / Dataverse: Azure AD token + phonecall activity.
// Usage: node scripts/mock-dynamics.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4400);
const VALID_SECRET = 'mock-dyn-client-secret';
let tok = 0;
let act = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'POST' && url.pathname.endsWith('/oauth2/v2.0/token')) {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== VALID_SECRET) {
        res.writeHead(401).end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      const token = `mock-dyn-access-${++tok}`;
      console.log(`TOKEN ISSUED ${token}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, expires_in: 3600 }));
      return;
    }
    if (req.method === 'POST' && /\/api\/data\/v[\d.]+\/phonecalls$/.test(url.pathname)) {
      const id = `00000000-0000-0000-0000-${String(++act).padStart(12, '0')}`;
      console.log(`PHONECALL CREATE auth="${req.headers.authorization}" body=${body}`);
      res.writeHead(204, { 'OData-EntityId': `${url.origin}${url.pathname}(${id})` });
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
}).listen(port, () => console.log(`Mock Dynamics listening on :${port}`));
