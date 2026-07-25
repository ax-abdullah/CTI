import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { AriClient } from '../src/pbx-connector/ari/ari-client';

/** A mock ARI: HTTP for REST + a WebSocket on /ari/events. */
class MockAri {
  private http!: Server;
  private wss!: WebSocketServer;
  private client?: WebSocket;
  port!: number;
  requests: Array<{ method: string; url: string; auth?: string }> = [];

  async start(): Promise<void> {
    this.http = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
      if (req.url?.includes('/variable') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: 'the-value' }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ari/events' });
    this.wss.on('connection', (ws) => (this.client = ws));
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  pushEvent(obj: unknown): void {
    this.client?.send(JSON.stringify(obj));
  }

  lastRequest() {
    return this.requests[this.requests.length - 1];
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

describe('AriClient (integration)', () => {
  let mock: MockAri;
  let client: AriClient;

  beforeEach(async () => {
    mock = new MockAri();
    await mock.start();
    client = new AriClient({ baseUrl: `http://127.0.0.1:${mock.port}`, username: 'cti', password: 'secret', app: 'cti' });
  });
  afterEach(async () => {
    client.destroy();
    await mock.stop();
  });

  it('connects the Stasis event socket and receives events', async () => {
    await client.connect();
    const event = await new Promise<any>((resolve) => {
      client.on('event', resolve);
      setTimeout(() => mock.pushEvent({ type: 'StasisStart', channel: { id: 'c1' } }), 20);
    });
    expect(event.type).toBe('StasisStart');
    expect(event.channel.id).toBe('c1');
  });

  it('answers a channel with basic auth on the right path', async () => {
    await client.connect();
    await client.answer('c1');
    const req = mock.lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/ari/channels/c1/answer');
    expect(req.auth).toBe('Basic ' + Buffer.from('cti:secret').toString('base64'));
  });

  it('snoops a channel with spy/whisper/app query for coaching', async () => {
    await client.connect();
    await client.snoop('c1', { spy: 'in', whisper: 'out', app: 'cti' });
    const req = mock.lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/ari/channels/c1/snoop?');
    expect(req.url).toContain('spy=in');
    expect(req.url).toContain('whisper=out');
    expect(req.url).toContain('app=cti');
  });

  it('reads a channel variable', async () => {
    await client.connect();
    const v = await client.getChannelVar('c1', 'CTI_PRIORITY');
    expect(v).toEqual({ value: 'the-value' });
    expect(mock.lastRequest().url).toBe('/ari/channels/c1/variable?variable=CTI_PRIORITY');
  });

  it('emits close when the socket drops', async () => {
    await client.connect();
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await mock.stop();
    await expect(closed).resolves.toBeUndefined();
  });
});
