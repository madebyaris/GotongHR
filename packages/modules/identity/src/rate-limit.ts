import type { FastifyRequest } from "fastify";
import pg from "pg";

const limitedPaths = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
]);

export function isCredentialRoute(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return limitedPaths.has(path);
}

export function rateLimitKey(request: FastifyRequest): string {
  const path = request.url.split("?")[0] ?? request.url;
  return `${request.ip}:${path}`;
}

export function createPostgresRateLimitStore(pool: pg.Pool) {
  return class PostgresRateLimitStore {
    constructor(_options: unknown) {}

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
      _max: number,
    ): void {
      void consume(pool, key, timeWindow).then(
        (result) => callback(null, result),
        (error: unknown) =>
          callback(error instanceof Error ? error : new Error("rate limit store failed")),
      );
    }

    child(): PostgresRateLimitStore {
      return this;
    }
  };
}

async function consume(
  pool: pg.Pool,
  key: string,
  timeWindowMs: number,
): Promise<{ current: number; ttl: number }> {
  const result = await pool.query<{ hits: number; ttl_ms: number }>(
    `INSERT INTO id_rate_limits AS rl (key, hits, expires_at)
     VALUES ($1, 1, clock_timestamp() + make_interval(secs => $2::double precision / 1000.0))
     ON CONFLICT (key) DO UPDATE
     SET hits = CASE
           WHEN rl.expires_at <= clock_timestamp() THEN 1
           ELSE rl.hits + 1
         END,
         expires_at = CASE
           WHEN rl.expires_at <= clock_timestamp()
             THEN clock_timestamp() + make_interval(secs => $2::double precision / 1000.0)
           ELSE rl.expires_at
         END
     RETURNING hits, GREATEST(1, floor(extract(epoch FROM (expires_at - clock_timestamp())) * 1000))::int AS ttl_ms`,
    [key, timeWindowMs],
  );
  const row = result.rows[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  return { current: Number(row.hits), ttl: Number(row.ttl_ms) };
}
