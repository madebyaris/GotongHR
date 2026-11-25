import type { FastifyRequest } from "fastify";
import pg from "pg";

const limitedPaths = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/send-otp",
  "/api/auth/two-factor/verify-otp",
]);

export function isCredentialRoute(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return limitedPaths.has(path);
}

/**
 * `request.ip` already applies Fastify `trustProxy`. CF-Connecting-IP is
 * read only when the operator has set GOTONG_TRUST_CLOUDFLARE, so a client
 * that can reach the origin cannot spoof the rate-limit key.
 */
export function clientAddress(
  request: { ip: string; headers: FastifyRequest["headers"] },
  trustCloudflare: boolean,
): string {
  if (!trustCloudflare) return request.ip;
  const header = request.headers["cf-connecting-ip"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return request.ip;
  const ip = raw.split(",")[0]?.trim();
  return ip && ip.length > 0 ? ip : request.ip;
}

export function rateLimitKey(request: FastifyRequest, trustCloudflare: boolean): string {
  const path = request.url.split("?")[0] ?? request.url;
  return `${clientAddress(request, trustCloudflare)}:${path}`;
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
