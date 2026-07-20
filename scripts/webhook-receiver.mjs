// Example webhook consumer — what a custom CRM would implement.
// Verifies the HMAC signature, rejects stale timestamps, prints events.
// Usage: WEBHOOK_SECRET=... node scripts/webhook-receiver.mjs [port]
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const port = Number(process.argv[2] ?? 4000);
const secret = process.env.WEBHOOK_SECRET ?? 'change-me';
const MAX_SKEW_MS = 5 * 60 * 1000;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const timestamp = req.headers['x-cti-timestamp'];
    const signature = req.headers['x-cti-signature'];
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const fresh = timestamp && Math.abs(Date.now() - Number(timestamp)) < MAX_SKEW_MS;
    const valid =
      typeof signature === 'string' &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

    if (!fresh || !valid) {
      console.error(`REJECTED webhook (fresh=${fresh} valid=${valid})`);
      res.writeHead(401).end();
      return;
    }
    const event = JSON.parse(body);
    console.log(`[${new Date().toISOString()}] ${event.type}`, JSON.stringify(event.data));
    res.writeHead(200).end('ok');
  });
}).listen(port, () => console.log(`Webhook receiver listening on :${port} (POST /cti-events)`));
