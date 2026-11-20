// Packages the production Worker from a clean checkout and stamps its commit.
// Dry run by default; pass --deploy to upload and send 100% of traffic.
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rootUrl = new URL("../", import.meta.url);
const root = fileURLToPath(rootUrl);
const bundle = new URL("dist/release/worker.js", rootUrl);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const deploy = process.argv.includes("--deploy");

if (git("status", "--porcelain")) {
  console.error("Refusing to package a Worker from a modified checkout.");
  process.exit(1);
}
const commit = git("rev-parse", "HEAD");
if (!/^[0-9a-f]{40}$/.test(commit)) process.exit(1);

const run = (args, env = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...env },
  });
  if (result.status !== 0) process.exit(result.status || 1);
};
// A failed or skipped dry run must not leave an older bundle to inspect.
await rm(new URL("dist/release", rootUrl), { recursive: true, force: true });
run(["scripts/build.mjs", "--assets-only"], { VITE_ROOM_BACKEND_ORIGIN: "" });
run([
  "node_modules/wrangler/bin/wrangler.js",
  "deploy",
  "--env=",
  // ROOM_FRONTEND_ORIGIN lives only in the Worker's runtime settings.
  "--keep-vars",
  "--define",
  `COSHOP_BUILD_COMMIT:"${commit}"`,
  "--message",
  `GitHub release ${commit}`,
  ...(deploy ? [] : ["--dry-run", "--outdir", "dist/release"]),
]);
if (!deploy && !(await readFile(bundle, "utf8")).includes(`"${commit}"`)) {
  console.error("The packaged Worker does not report " + commit + ".");
  process.exit(1);
}
console.log((deploy ? "Deployed" : "Dry run packaged") + ` commit ${commit}.`);
