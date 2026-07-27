import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Which half of the platform this process is. One image, three roles
 * (Phase 12): `connector` owns PBX sockets and is the sole event source,
 * `api` serves HTTP + agent WebSockets, `worker` drains the BullMQ queues.
 * `all` is the single-process mode used in development and by the compose
 * stack — it behaves as all three at once.
 */
export type CtiRole = 'all' | 'api' | 'connector' | 'worker';

export const CTI_ROLES: readonly CtiRole[] = ['all', 'api', 'connector', 'worker'] as const;

export function readRole(env: NodeJS.ProcessEnv = process.env): CtiRole {
  const raw = (env.CTI_ROLE ?? 'all').trim().toLowerCase();
  if (!CTI_ROLES.includes(raw as CtiRole)) {
    throw new Error(`Invalid CTI_ROLE '${raw}'. Expected one of: ${CTI_ROLES.join(', ')}`);
  }
  return raw as CtiRole;
}

export function roleOwnsPbx(role: CtiRole): boolean {
  return role === 'all' || role === 'connector';
}

export function roleServesHttp(role: CtiRole): boolean {
  return role === 'all' || role === 'api';
}

/**
 * Stable-per-process identity. In Kubernetes `hostname()` is the pod name,
 * which is already unique — but a restarted pod reuses it, and a stale lease
 * must not look self-owned to the new process. The random suffix makes every
 * process distinct, which is what the lease compare-and-renew relies on.
 */
export const POD_ID = `${process.env.POD_ID ?? hostname()}-${randomBytes(4).toString('hex')}`;

/**
 * DI token for this process's identity. Injected rather than read from the
 * constant so a test can stand up two "pods" inside one process — which is
 * the only way to exercise the ownership handover that makes N>1 safe.
 */
export const POD_IDENTITY = Symbol('POD_IDENTITY');
