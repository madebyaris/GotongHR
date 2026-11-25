import { composeFromEnv } from "../composition.ts";
import { readConfig } from "../config.ts";

async function main(): Promise<void> {
  const config = readConfig(process.env);
  const composed = await composeFromEnv(process.env);
  await composed.app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "boot failed";
  process.stderr.write(`${JSON.stringify({ msg: "boot failed", error: message })}\n`);
  process.exit(1);
});
