import { assertPostgresReachable } from "../src/require-database.ts";

try {
  await assertPostgresReachable();
} catch (error) {
  const message = error instanceof Error ? error.message : "PostgreSQL is unreachable";
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
