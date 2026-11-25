import { runBootstrap } from "../bootstrap.ts";

async function main(): Promise<void> {
  const result = await runBootstrap(process.env);
  process.stdout.write(
    `${JSON.stringify({ tenantId: result.tenantId, created: result.created })}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "bootstrap failed";
  process.stderr.write(`${JSON.stringify({ msg: "bootstrap failed", error: message })}\n`);
  process.exit(1);
});
