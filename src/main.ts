import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

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
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  mountSwagger(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`CTI platform listening on :${port}`);
}
void bootstrap();
