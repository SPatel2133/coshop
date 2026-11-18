import { createRequire } from "node:module";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { nodeCommand, provenance, temporary, withRuntime } from "./evidence-runtime.mjs";
import { benchmark } from "./evidence-benchmark.mjs";
import { diagnose } from "./evidence-diagnosis.mjs";

const mode = process.argv[2];
const report = { ...provenance(), runtime: "Local Node SQLite over loopback", mode };
const output = await temporary("evidence");

async function reproduce() {
  const require = createRequire(import.meta.url);
  const cli = require.resolve("@playwright/test/cli");
  const env = { ...process.env, VITE_ROOM_BACKEND_ORIGIN: "" };
  const built = await nodeCommand(["scripts/build.mjs", "--assets-only"], env);
  if (built) return { passed: false, stage: "build", exitCode: built };
  return withRuntime(async (base) => {
    const code = await nodeCommand([
      cli, "test", "tests/design.spec.js", "--workers=1", "--reporter=html,json",
      "--output", join(output, "test-data"), "-g", "three shoppers converge",
    ], {
      ...env,
      COSHOP_TEST_URL: base,
      COSHOP_EVIDENCE: "",
      PLAYWRIGHT_HTML_OPEN: "never",
      PLAYWRIGHT_HTML_OUTPUT_DIR: join(output, "playwright-report"),
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, "playwright.json"),
    });
    return { passed: code === 0, exitCode: code, scenario: "three shoppers converge" };
  });
}

try {
  if (mode === "reproduce") Object.assign(report, await reproduce());
  else if (mode === "measure") Object.assign(report, await withRuntime(benchmark));
  else if (mode === "diagnose") Object.assign(report, await diagnose(output));
  else throw new Error("Choose reproduce, measure, or diagnose.");
} catch (error) {
  console.error(error.message);
  Object.assign(report, { passed: false, failedStage: mode });
}
await writeFile(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.passed ? "PASS" : "FAIL"} — evidence at ${output}`);
process.exitCode = report.passed ? 0 : 1;
