import { startOutboxDispatcher } from "@gotonghr/audit";
import { requiredEnv } from "@gotonghr/db";
import { composeFromEnv } from "../composition.ts";
import { runShutdown } from "../shutdown.ts";

export async function listenFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const composed = await composeFromEnv(env);
  const dispatcher =
    composed.config.role === "monolith" || composed.config.role === "worker"
      ? startOutboxDispatcher({
          boss: composed.boss,
          connectionString: requiredEnv(env, "DATABASE_URL_QUEUE"),
        })
      : null;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    runShutdown(async () => {
      if (dispatcher) await dispatcher.stop();
      await composed.close();
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await composed.app.listen({ host: composed.config.host, port: composed.config.port });
}

export function bootRole(): void {
  listenFromEnv().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "boot failed";
    process.stderr.write(`${JSON.stringify({ msg: "boot failed", error: message })}\n`);
    process.exit(1);
  });
}
