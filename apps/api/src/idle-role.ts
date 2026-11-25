export function logIdleRole(role: string): void {
  process.stdout.write(
    `${JSON.stringify({ role, msg: "entrypoint is not mounted in this slice" })}\n`,
  );
  process.exit(0);
}
