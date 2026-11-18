import { build } from "vite";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
await build({ configFile: fileURLToPath(new URL("vite.config.js", root)) });
if (!process.argv.includes("--assets-only")) {
  // Do not leave an older Sites bundle looking like this Worker's entrypoint.
  await rm(new URL("dist/server/index.js", root), { force: true });
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("node_modules/wrangler/bin/wrangler.js", root)),
      "deploy",
      "--dry-run",
      "--outdir",
      "dist/server",
    ],
    {
      cwd: fileURLToPath(root),
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(
  "Built coshop: shared rooms, live Shopify catalog and hosted checkout.",
);
