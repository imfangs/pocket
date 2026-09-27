import { copyFileSync, writeFileSync } from "node:fs";
copyFileSync(
  new URL("../edge/worker.mjs", import.meta.url),
  new URL("../dist/_worker.js", import.meta.url),
);
writeFileSync(
  new URL("../dist/_routes.json", import.meta.url),
  JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }),
);
