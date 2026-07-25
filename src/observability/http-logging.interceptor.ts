import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/**
 * One structured log line per HTTP request: method, path, status, duration,
 * and the resolved tenant when a guard has attached one. Feeds the JSON
 * logger so requests are queryable by tenant/status/latency.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const startedAt = Date.now();

    const emit = (outcome: 'ok' | 'error', status: number) =>
      this.logger.log({
        msg: 'request',
        method: req.method,
        path: req.route?.path ?? req.url?.split('?')[0],
        status,
        durationMs: Date.now() - startedAt,
        tenant: req.tenant?.entity?.slug,
        outcome,
      });

    return next.handle().pipe(
      tap({
        next: () => emit('ok', res.statusCode),
        error: (err) => emit('error', err?.status ?? 500),
      }),
    );
  }
}
