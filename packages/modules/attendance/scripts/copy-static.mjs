import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/schedules", { recursive: true });
copyFileSync(
  "src/schedules/holidays-2026.draft.json",
  "dist/schedules/holidays-2026.draft.json",
);
