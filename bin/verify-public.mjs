const base = process.argv[2];
if (!base) throw new Error("URL required");
for (const path of ["/api/catalog", "/api/export"]) {
  const r = await fetch(new URL(path, base));
  if (r.status !== 401)
    throw new Error(`${path} must require authentication: ${r.status}`);
}
const manifest = await fetch(new URL("/manifest.webmanifest", base)).then((r) =>
  r.json(),
);
if (manifest.display !== "standalone") throw new Error("Manifest unavailable");
console.log(
  JSON.stringify({ ok: true, anonymousProtected: true, manifest: true }),
);
