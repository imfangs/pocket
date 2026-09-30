import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { frontendVersion, versionManifest } from "./bin/build-version.mjs";
const version = frontendVersion(fileURLToPath(new URL(".", import.meta.url)));
export default defineConfig({
  plugins: [react(), versionManifest(version)],
  define: { __POCKET_BUILD_ID__: JSON.stringify(version) },
  server: { proxy: { "/api": "http://127.0.0.1:4397" } },
});
