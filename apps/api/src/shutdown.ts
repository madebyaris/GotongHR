export const SHUTDOWN_DEADLINE_MS = 8_000;

interface ShutdownIo {
  exit(code: number): void;
  write(line: string): void;
}

const defaultIo: ShutdownIo = {
  exit: (code) => {
    process.exit(code);
  },
  write: (line) => {
    process.stderr.write(line);
  },
};

function logLine(msg: string, error?: string): string {
  return `${JSON.stringify(error === undefined ? { msg } : { msg, error })}\n`;
}

/** Stops the process if close stalls, and logs a failed close before exiting. */
export function runShutdown(
  close: () => Promise<void>,
  io: ShutdownIo = defaultIo,
  deadlineMs = SHUTDOWN_DEADLINE_MS,
): void {
  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    io.exit(code);
  };
  const timer = setTimeout(() => {
    io.write(logLine("shutdown stalled"));
    finish(1);
  }, deadlineMs);
  if (typeof timer.unref === "function") timer.unref();
  io.write(logLine("shutdown started"));
  void close().then(
    () => {
      finish(0);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "shutdown failed";
      io.write(logLine("shutdown failed", message));
      finish(1);
    },
  );
}
