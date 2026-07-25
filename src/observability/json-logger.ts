import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';

/**
 * Structured JSON logger for production: one JSON object per line, so log
 * aggregators (Loki, ELK, CloudWatch) can index by level/context and any
 * embedded fields. Set via `app.useLogger()` in main.ts when LOG_FORMAT=json
 * (the default); LOG_FORMAT=pretty keeps Nest's coloured ConsoleLogger for
 * local dev.
 *
 * Correlation: messages in the event pipeline already embed `[tenant]` and
 * callIds; structured callers can pass an object as the message and it is
 * merged into the JSON line.
 */
export class JsonLogger implements LoggerService {
  private write(level: LogLevel, message: unknown, context?: string, trace?: string): void {
    const base: Record<string, unknown> = { ts: new Date().toISOString(), level, context };
    if (message && typeof message === 'object') Object.assign(base, message);
    else base.msg = message;
    if (trace) base.trace = trace;
    process.stdout.write(JSON.stringify(base) + '\n');
  }

  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }
  // Nest calls error(message, stack?, context?)
  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }
}

/** Factory: JSON in prod, Nest's pretty console for local dev. */
export function makeLogger(): LoggerService {
  return (process.env.LOG_FORMAT ?? 'json') === 'pretty' ? new ConsoleLogger() : new JsonLogger();
}
