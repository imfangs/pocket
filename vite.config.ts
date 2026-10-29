import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { frontendVersion, versionManifest } from "./bin/build-version.mjs";
const version = frontendVersion(fileURLToPath(new URL(".", import.meta.url)));
export default defineConfig({
  plugins: [react(), versionManifest(version), {
    name: "feedback-third-party-notices",
    apply: "build",
    generateBundle() {
      const base = new URL("./packages/feedback-kit/", import.meta.url);
      const notice = readFileSync(new URL("THIRD_PARTY_NOTICES.md", base), "utf8");
      const licenses = readdirSync(new URL("licenses/", base)).sort().map(name =>
        `\n\n${name}\n\n${readFileSync(new URL(`licenses/${name}`, base), "utf8")}`);
      this.emitFile({ type: "asset", fileName: "feedback-kit-notices.txt", source: notice + licenses.join("") });
    },
  }],
  define: { __POCKET_BUILD_ID__: JSON.stringify(version) },
  worker: { format: "es" },
  server: { proxy: { "/api": "http://127.0.0.1:4397" } },
});
