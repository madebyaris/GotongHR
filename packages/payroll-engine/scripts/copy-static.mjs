import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

mkdirSync("dist/tables", { recursive: true });
for (const name of readdirSync("src/tables")) {
  if (name.endsWith(".json")) copyFileSync(`src/tables/${name}`, `dist/tables/${name}`);
}
copyFileSync(
  "src/__tests__/golden/pph21.verified.json",
  "dist/tables/pph21.verified.json",
);

mkdirSync("dist/coretax/xsd", { recursive: true });
for (const name of readdirSync("src/coretax/xsd")) {
  if (name.toLowerCase().endsWith(".xsd")) copyFileSync(`src/coretax/xsd/${name}`, `dist/coretax/xsd/${name}`);
}
