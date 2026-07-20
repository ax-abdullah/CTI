// Mock Zoho server for lab testing: OAuth token endpoint + PhoneBridge
// call-notify endpoints, speaking the exact contract of ZohoClient /
// ZohoTokenService. Usage: node scripts/mock-zoho.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4100);
const VALID = { client_secret: 'mock-client-secret', refresh_token: 'mock-refresh-token' };
let tokenCounter = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'POST' && url.pathname === '/oauth/v2/token') {
      const params = new URLSearchParams(body);
      if (
        params.get('client_secret') !== VALID.client_secret ||
        params.get('refresh_token') !== VALID.refresh_token
      ) {
        console.log('TOKEN REFUSED (bad credentials)');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      const token = `mock-access-${++tokenCounter}`;
      console.log(`TOKEN ISSUED ${token}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, expires_in: 3600, token_type: 'Bearer' }));
      return;
    }

    if (url.pathname.startsWith('/phonebridge/v3/calls')) {
      const auth = req.headers.authorization ?? 'none';
      console.log(`${req.method} ${url.pathname} auth="${auth}" body=${body}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    res.writeHead(404).end();
  });
}).listen(port, () => console.log(`Mock Zoho listening on :${port}`));
