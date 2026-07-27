import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { readRole, roleServesHttp } from './cluster/cluster.types';
import { makeLogger } from './observability/json-logger';

function mountSwagger(app: Parameters<typeof SwaggerModule.createDocument>[0]): void {
  const config = new DocumentBuilder()
    .setTitle('CTI Platform API')
    .setDescription(
      'Multi-tenant CTI middleware connecting Asterisk/FreePBX to CRMs: ' +
        'click-to-call, screen pops, automated call logging, presence, and recordings.\n\n' +
        'Real-time channels (not in this spec): `WS /softphone-ws?token=<agent JWT>` streams ' +
        "the agent's call.* and agent.state events; `WS /connector-ws?token=<connector token>` " +
        'is the reverse on-prem AMI tunnel. Webhook contract: signed POSTs with ' +
        '`X-CTI-Timestamp` + `X-CTI-Signature` = hex HMAC-SHA256(secret, `${timestamp}.${body}`).',
    )
    .setVersion('0.5.0')
    .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, 'tenant-key')
    .addApiKey({ type: 'apiKey', name: 'X-Admin-Key', in: 'header' }, 'admin-key')
    .addApiKey({ type: 'apiKey', name: 'X-Zoho-Token', in: 'header' }, 'zoho-callback-token')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'agent-token')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}

async function bootstrap() {
  // One image, three roles (ADR-0012). Defaults to `all` — the single-process
  // mode used in development and by the compose stack.
  const role = readRole();

  const app = await NestFactory.create(AppModule.forRole(role), { bufferLogs: true });
  app.useLogger(makeLogger()); // structured JSON logs (LOG_FORMAT=pretty for dev)
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // SIGTERM/SIGINT run every module's shutdown hook: AMI sockets close, BullMQ
  // workers drain, Redis/PG disconnect, leases are released so a peer takes
  // over immediately, and agent sockets are closed with a reconnect hint.
  app.enableShutdownHooks();

  // Swagger documents the tenant-facing API, which only `api` replicas serve.
  if (roleServesHttp(role)) mountSwagger(app);

  // Every role listens: `connector` and `worker` still need to answer the
  // liveness/readiness probes and expose /metrics for scraping.
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`CTI platform [role=${role}] listening on :${port}`);
}
void bootstrap();
