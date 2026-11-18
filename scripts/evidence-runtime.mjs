import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function provenance() {
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    node: process.version,
    platform: process.platform + "-" + process.arch,
    startedAt: new Date().toISOString(),
  };
}

export async function temporary(prefix) {
  return mkdtemp(join(tmpdir(), "coshop-" + prefix + "-"));
}

export async function withRuntime(run, options = {}) {
  const directory = await temporary("state");
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: "0",
    DATA_DIR: directory,
    INVITE_SIGNING_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    PUBLIC_ORIGIN: "",
    SHOPIFY_STORE_DOMAIN: "",
    SHOPIFY_STOREFRONT_TOKEN: "",
    SHOPIFY_WEBHOOK_SECRET: "",
    CREATE_LIMIT_PER_HOUR: "100",
    JOIN_LIMIT_PER_10_MIN: "1000",
    ROOM_TTL_MS: "86400000",
    HEARTBEAT_INTERVAL_MS: "20000",
    HEARTBEAT_TIMEOUT_MS: "65000",
    ...options.env,
  };
  const child = spawn(process.execPath, [...(options.nodeArgs || []), "server.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  child.stdout.setEncoding("utf8");
  let timer;
  try {
    const port = await Promise.race([
      new Promise((resolve) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const ready = output.match(/coshop: http:\/\/localhost:(\d+)/);
          if (ready) resolve(ready[1]);
        });
      }),
      exited.then(() => { throw new Error("Local room runtime exited during startup."); }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Local runtime startup timed out.")), 10000);
      }),
    ]);
    clearTimeout(timer);
    return await run("http://127.0.0.1:" + port);
  } finally {
    clearTimeout(timer);
    child.kill();
    await exited;
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function nodeCommand(args, env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  return (await once(child, "exit"))[0] ?? 1;
}

export async function roomRequest(base, path, body, token) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
