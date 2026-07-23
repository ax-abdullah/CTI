import { AddressInfo } from 'node:net';
import { createServer, Server, Socket } from 'node:net';
import { AmiClient } from '../src/pbx-connector/ami-client';

/**
 * A mock AMI server: sends the banner, answers Login/Ping with an
 * ActionID-matched Response frame, and can push unsolicited events.
 * Exercises the real AmiClient over a real TCP socket.
 */
class MockAmi {
  private server: Server;
  private sockets = new Set<Socket>();
  port!: number;

  async start(opts: { acceptLogin?: boolean } = {}): Promise<void> {
    const acceptLogin = opts.acceptLogin ?? true;
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.write('Asterisk Call Manager/7.0.1\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let sep: number;
        while ((sep = buffer.indexOf('\r\n\r\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 4);
          this.handleFrame(socket, frame, acceptLogin);
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private handleFrame(socket: Socket, frame: string, acceptLogin: boolean): void {
    const fields: Record<string, string> = {};
    for (const line of frame.split('\r\n')) {
      const i = line.indexOf(': ');
      if (i !== -1) fields[line.slice(0, i)] = line.slice(i + 2);
    }
    const actionId = fields.ActionID ?? '';
    if (fields.Action === 'Login') {
      const ok = acceptLogin;
      socket.write(
        `Response: ${ok ? 'Success' : 'Error'}\r\nActionID: ${actionId}\r\n` +
          `Message: ${ok ? 'Authentication accepted' : 'Authentication failed'}\r\n\r\n`,
      );
    } else if (fields.Action === 'Ping') {
      socket.write(`Response: Success\r\nActionID: ${actionId}\r\nPing: Pong\r\n\r\n`);
    }
  }

  pushEvent(frame: string): void {
    for (const s of this.sockets) s.write(frame.endsWith('\r\n\r\n') ? frame : `${frame}\r\n\r\n`);
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe('AmiClient (integration)', () => {
  let mock: MockAmi;

  afterEach(async () => {
    await mock?.stop();
  });

  it('connects and authenticates against the banner + Login handshake', async () => {
    mock = new MockAmi();
    await mock.start({ acceptLogin: true });
    const client = new AmiClient({ host: '127.0.0.1', port: mock.port, username: 'cti', secret: 's' });

    await expect(client.connect()).resolves.toBeUndefined();
    client.destroy();
  });

  it('rejects on failed authentication', async () => {
    mock = new MockAmi();
    await mock.start({ acceptLogin: false });
    const client = new AmiClient({ host: '127.0.0.1', port: mock.port, username: 'cti', secret: 'bad' });

    await expect(client.connect()).rejects.toThrow(/authentication failed/i);
  });

  it('matches an action to its response by ActionID', async () => {
    mock = new MockAmi();
    await mock.start();
    const client = new AmiClient({ host: '127.0.0.1', port: mock.port, username: 'cti', secret: 's' });
    await client.connect();

    const res = await client.sendAction({ Action: 'Ping' });
    expect(res.Response).toBe('Success');
    expect(res.Ping).toBe('Pong');
    client.destroy();
  });

  it('emits unsolicited events', async () => {
    mock = new MockAmi();
    await mock.start();
    const client = new AmiClient({ host: '127.0.0.1', port: mock.port, username: 'cti', secret: 's' });
    await client.connect();

    const event = await new Promise<Record<string, string>>((resolve) => {
      client.on('event', resolve);
      mock.pushEvent('Event: Newchannel\r\nChannel: PJSIP/1001-00000001\r\nUniqueid: 123.0\r\nLinkedid: 123.0');
    });
    expect(event.Event).toBe('Newchannel');
    expect(event.Channel).toBe('PJSIP/1001-00000001');
    client.destroy();
  });

  it('emits close when the transport drops', async () => {
    mock = new MockAmi();
    await mock.start();
    const client = new AmiClient({ host: '127.0.0.1', port: mock.port, username: 'cti', secret: 's' });
    await client.connect();

    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    await mock.stop();
    await expect(closed).resolves.toBeUndefined();
  });
});
