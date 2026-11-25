import { composeFromEnv } from "../composition.ts";

async function main(): Promise<void> {
  const composed = await composeFromEnv(process.env);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void composed.close().then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
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
