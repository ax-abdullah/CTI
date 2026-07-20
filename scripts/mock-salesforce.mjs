// Mock Salesforce for lab testing: OAuth token endpoint + Task sobject
// creation, speaking the contract of SalesforceTokenService/Client.
// Usage: node scripts/mock-salesforce.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 4200);
const VALID = { client_secret: 'mock-sf-client-secret', refresh_token: 'mock-sf-refresh-token' };
let tokenCounter = 0;
let taskCounter = 0;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'POST' && url.pathname === '/services/oauth2/token') {
      const params = new URLSearchParams(body);
      if (
        params.get('client_secret') !== VALID.client_secret ||
        params.get('refresh_token') !== VALID.refresh_token
      ) {
        console.log('TOKEN REFUSED (bad credentials)');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const token = `mock-sf-access-${++tokenCounter}`;
      console.log(`TOKEN ISSUED ${token}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, instance_url: `http://localhost:${port}`, token_type: 'Bearer' }));
      return;
    }

    if (req.method === 'POST' && /^\/services\/data\/v[\d.]+\/sobjects\/Task$/.test(url.pathname)) {
      const auth = req.headers.authorization ?? 'none';
      console.log(`TASK CREATE auth="${auth}" body=${body}`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `00T${String(++taskCounter).padStart(12, '0')}`, success: true }));
      return;
    }

    res.writeHead(404).end();
  });
}).listen(port, () => console.log(`Mock Salesforce listening on :${port}`));
