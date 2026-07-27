import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * One structured log line per HTTP request: method, path, status, duration,
 * and the resolved tenant when a guard has attached one. Feeds the JSON
 * logger so requests are queryable by tenant/status/latency, and the
 * Prometheus counters that drive api autoscaling (Phase 12b).
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const startedAt = Date.now();

    // Logs may carry the concrete path; metrics must not. A label built from
    // req.url would mint a new time series per recording token or tenant slug
    // and blow up Prometheus cardinality, so metrics use the route template
    // only and bucket anything unmatched together.
    const path = req.route?.path ?? req.url?.split('?')[0];
    const routeLabel = req.route?.path ?? 'unmatched';

    const emit = (outcome: 'ok' | 'error', status: number) => {
      const durationMs = Date.now() - startedAt;
      this.logger.log({
        msg: 'request',
        method: req.method,
        path,
        status,
        durationMs,
        tenant: req.tenant?.entity?.slug,
        outcome,
      });
      this.metrics.httpRequests.inc({ method: req.method, route: routeLabel, status });
      this.metrics.httpDuration.observe({ method: req.method, route: routeLabel }, durationMs / 1000);
    };

    return next.handle().pipe(
      tap({
        next: () => emit('ok', res.statusCode),
        error: (err) => emit('error', err?.status ?? 500),
      }),
    );
  }
}
