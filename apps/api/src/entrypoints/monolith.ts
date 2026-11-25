import { startOutboxDispatcher } from "@gotonghr/audit";
import { requiredEnv } from "@gotonghr/db";
import { composeFromEnv } from "../composition.ts";
import { runShutdown } from "../shutdown.ts";

async function main(): Promise<void> {
  const composed = await composeFromEnv(process.env);
  const dispatcher = startOutboxDispatcher({
    boss: composed.boss,
    connectionString: requiredEnv(process.env, "DATABASE_URL_QUEUE"),
  });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    runShutdown(async () => {
      await dispatcher.stop();
      await composed.close();
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await composed.app.listen({ host: composed.config.host, port: composed.config.port });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "boot failed";
  process.stderr.write(`${JSON.stringify({ msg: "boot failed", error: message })}\n`);
  process.exit(1);
});
