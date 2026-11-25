import { requiredEnv } from "@gotonghr/db";
import pg from "pg";

const { Client } = pg;

export async function resetIdentity(): Promise<void> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    await admin.query(`
      TRUNCATE TABLE
        id_branches,
        id_legal_entities,
        id_sessions,
        id_memberships,
        id_users,
        id_roles,
        id_tenants,
        id_rate_limits,
        ba_two_factor,
        ba_invitation,
        ba_member,
        ba_session,
        ba_account,
        ba_verification,
        ba_organization,
        ba_user
      CASCADE
    `);
  } finally {
    await admin.end();
  }
}

export async function superuserQuery<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[],
): Promise<T[]> {
  const admin = new Client({ connectionString: requiredEnv(process.env, "DATABASE_URL_SUPERUSER") });
  await admin.connect();
  try {
    const result = await admin.query<T>(text, values);
    return result.rows;
  } finally {
    await admin.end();
  }
}

export function setCookieLines(response: {
  headers: { "set-cookie"?: string | string[] | number | undefined };
}): string[] {
  const raw = response.headers["set-cookie"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

export function cookieHeader(cookies: string[]): string {
  return cookies
    .map((line) => line.split(";")[0]?.trim() ?? "")
    .filter((part) => part.includes("="))
    .join("; ");
}

export function readErrorCode(response: { body: string }): string | undefined {
  const parsed = JSON.parse(response.body) as { error: { code?: string } | null };
  return parsed.error?.code;
}

export function readErrorRecord(response: { body: string }): {
  code?: string;
  fields?: { field: string; message: string }[];
} | null {
  const parsed = JSON.parse(response.body) as {
    error: { code?: string; fields?: { field: string; message: string }[] } | null;
  };
  return parsed.error;
}
