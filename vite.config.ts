import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync } from "node:fs";
import { frontendVersion, versionManifest } from "./bin/build-version.mjs";
import { readUsageAnalyticsConfig, resolveUsageAnalyticsPath } from "./bin/usage-analytics-config.mjs";
const root = fileURLToPath(new URL(".", import.meta.url));
readUsageAnalyticsConfig(root);
const version = frontendVersion(root);
function pdfSupportAssets() {
  const assets = new Map<string, URL>();
  const collect = (directory: URL, output: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name === "quickjs-eval.wasm") continue;
      if (item.isDirectory()) collect(new URL(item.name + "/", directory), `${output}/${item.name}`);
      else if (item.isFile()) assets.set(`${output}/${item.name}`, new URL(item.name, directory));
    }
  };
  const pdf = new URL("./node_modules/pdfjs-dist/", import.meta.url);
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) collect(new URL(directory + "/", pdf), `assets/pdfjs/${directory}`);
  return assets;
}
export default defineConfig({
  resolve: { alias: [{
    find: /^\.\.\/config\/usage-analytics\.example\.json$/,
    replacement: resolveUsageAnalyticsPath(root),
  }] },
  plugins: [react(), versionManifest(version), {
    name: "application-third-party-notices",
    apply: "build",
    generateBundle() {
      for (const [source, fileName] of [
        ["THIRD_PARTY_NOTICES.md", "third-party-notices.txt"],
        ["THIRD_PARTY_LICENSES.txt", "third-party-licenses.txt"],
      ]) this.emitFile({ type: "asset", fileName, source: readFileSync(new URL(`./${source}`, import.meta.url)) });
    },
  }, {
    name: "feedback-third-party-notices",
    apply: "build",
    generateBundle() {
      const base = new URL("./packages/feedback-kit/", import.meta.url);
      const notice = readFileSync(new URL("THIRD_PARTY_NOTICES.md", base), "utf8");
      const licenses = readdirSync(new URL("licenses/", base)).sort().map(name =>
        `\n\n${name}\n\n${readFileSync(new URL(`licenses/${name}`, base), "utf8")}`);
      this.emitFile({ type: "asset", fileName: "feedback-kit-notices.txt", source: notice + licenses.join("") });
    },
  }, {
    name: "document-preview-assets",
    configureServer(server) {
      const assets = pdfSupportAssets();
      server.middlewares.use((request, response, next) => {
        let pathname: string;
        try { pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname).slice(1); }
        catch { return next(); }
        const asset = assets.get(pathname);
        if (!asset || !["GET", "HEAD"].includes(request.method || "")) return next();
        const bytes = readFileSync(asset);
        response.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        response.setHeader("Content-Length", bytes.length);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(request.method === "HEAD" ? undefined : bytes);
      });
    },
    generateBundle() {
      for (const [fileName, asset] of pdfSupportAssets()) this.emitFile({ type: "asset", fileName, source: readFileSync(asset) });
      const sources = [
        ["react-pdf", "LICENSE"], ["pdfjs-dist", "LICENSE"], ["mammoth", "LICENSE"], ["exceljs", "LICENSE"],
        ["fast-xml-parser", "LICENSE"], ["dompurify", "LICENSE"], ["fflate-modern", "LICENSE"],
      ];
      const text = sources.map(([name, file]) => `\n${name}\n\n${readFileSync(new URL(`./node_modules/${name}/${file}`, import.meta.url), "utf8")}`).join("\n\n");
      this.emitFile({ type: "asset", fileName: "document-preview-notices.txt", source: text });
    },
  }],
  define: { __POCKET_BUILD_ID__: JSON.stringify(version) },
  worker: { format: "es" },
  server: { proxy: { "/api": "http://127.0.0.1:4397" } },
});
