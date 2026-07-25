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
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const CTI_URL = process.env.CTI_URL;
const TOKEN = process.env.CONNECTOR_TOKEN;
const AMI_HOST = process.env.AMI_HOST ?? '127.0.0.1';
const AMI_PORT = Number(process.env.AMI_PORT ?? 5038);
// Local recordings dir the agent serves over the file channel (basename-only).
const RECORDINGS_DIR = process.env.AGENT_RECORDINGS_DIR ?? '/var/spool/asterisk/monitor';
const FILE_URL = CTI_URL?.replace('/connector-ws', '/connector-files');
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

// --- file channel: serve recording files on demand (basename-only) --------
let fileBackoffMs = 1000;
function fileSession() {
  const ws = new WebSocket(`${FILE_URL}?token=${encodeURIComponent(TOKEN)}`);
  ws.onopen = () => {
    fileBackoffMs = 1000;
    log(`file channel up -> ${FILE_URL} (serving ${RECORDINGS_DIR})`);
  };
  ws.onmessage = async (event) => {
    let req;
    try { req = JSON.parse(event.data); } catch { return; }
    if (req.t !== 'fetch') return;
    const send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    try {
      const buf = await readFile(join(RECORDINGS_DIR, basename(req.file)));
      // chunk to stay under WS frame limits
      for (let i = 0; i < buf.length; i += 48_000) {
        send({ t: 'chunk', id: req.id, data: buf.subarray(i, i + 48_000).toString('base64') });
      }
      send({ t: 'eof', id: req.id });
    } catch (err) {
      send({ t: 'error', id: req.id, message: err.message });
    }
  };
  ws.onclose = () => {
    log(`file channel closed; reconnecting in ${fileBackoffMs / 1000}s`);
    setTimeout(fileSession, fileBackoffMs);
    fileBackoffMs = Math.min(fileBackoffMs * 2, 30_000);
  };
  ws.onerror = () => {};
}

log('CTI connector agent starting');
session();
fileSession();
