#!/usr/bin/env node
// CTI on-prem connector agent.
//
// Runs inside the customer network next to the PBX. Dials OUT to the cloud
// CTI over WebSocket (TLS in production) and pipes the local AMI socket
// through the tunnel — the customer opens no inbound ports, and this agent
// never holds AMI credentials (login happens from the cloud side).
//
// Dependency-free: Node >= 21 (global WebSocket). Configure via env:
//   CTI_URL          e.g. wss://cti.example.com/connector-ws
//   CONNECTOR_TOKEN  issued when the PBX connection is registered
//   AMI_HOST         default 127.0.0.1
//   AMI_PORT         default 5038
import { connect } from 'node:net';

const CTI_URL = process.env.CTI_URL;
const TOKEN = process.env.CONNECTOR_TOKEN;
const AMI_HOST = process.env.AMI_HOST ?? '127.0.0.1';
const AMI_PORT = Number(process.env.AMI_PORT ?? 5038);
if (!CTI_URL || !TOKEN) {
  console.error('CTI_URL and CONNECTOR_TOKEN are required');
  process.exit(1);
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
let backoffMs = 1000;

function session() {
  const ws = new WebSocket(`${CTI_URL}?token=${encodeURIComponent(TOKEN)}`);
  ws.binaryType = 'arraybuffer';
  let ami = null;
  let closed = false;

  const teardown = (why) => {
    if (closed) return;
    closed = true;
    log(`session down (${why}); reconnecting in ${backoffMs / 1000}s`);
    try { ami?.destroy(); } catch {}
    try { ws.close(); } catch {}
    setTimeout(session, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };

  ws.onopen = () => {
    log(`tunnel up -> ${CTI_URL}, opening AMI ${AMI_HOST}:${AMI_PORT}`);
    ami = connect({ host: AMI_HOST, port: AMI_PORT });
    ami.on('connect', () => { backoffMs = 1000; log('AMI socket connected'); });
    ami.on('data', (chunk) => { if (ws.readyState === WebSocket.OPEN) ws.send(chunk); });
    ami.on('close', () => teardown('AMI closed'));
    ami.on('error', (e) => log(`AMI error: ${e.message}`));
  };
  ws.onmessage = (event) => {
    if (ami && !ami.destroyed) ami.write(Buffer.from(event.data));
  };
  ws.onclose = (e) => teardown(`tunnel closed ${e.code}${e.reason ? ` ${e.reason}` : ''}`);
  ws.onerror = () => {};
}

log('CTI connector agent starting');
session();
