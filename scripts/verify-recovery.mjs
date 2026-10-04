import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Client, Connection } from "@temporalio/client";
const queue = `recovery-${randomUUID()}`,
  id = `recovery-${randomUUID()}`;
let child;
const logs = [];
async function startWorker() {
  child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
    env: { ...process.env, TASK_QUEUE: queue },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const p = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Recovery Worker did not start")),
      20000,
    );
    const read = (chunk) => {
      const line = chunk.toString();
      logs.push(line);
      if (line.includes("Worker is polling")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    p.stdout.on("data", read);
    p.stderr.on("data", read);
    p.once("exit", (code) => {
      if (code) {
        clearTimeout(timeout);
        reject(new Error(`Worker exited ${code}`));
      }
    });
  });
}
const connection = await Connection.connect({ address: "localhost:7233" });
const client = new Client({ connection });
let handle;
try {
  await startWorker();
  handle = await client.workflow.start("salonDesk", {
    workflowId: id,
    taskQueue: queue,
    args: [],
  });
  const command = (body) =>
    handle.executeUpdate("command", {
      args: [{ requestId: randomUUID(), ...body }],
    });
  const now = Date.parse("2030-06-10T17:00:00Z");
  await command({
    type: "start",
    opening: {
      id: randomUUID(),
      service: "Haircut",
      stylist: "Lena",
      minutes: 60,
      startsAt: new Date(now + 7200000).toISOString(),
      mode: "demo",
      timezone: "America/Los_Angeles",
    },
    clients: [
      {
        id: "recovery-client",
        name: "Recovery Test Client",
        mobile: "555-0100",
        service: "Haircut",
        minutes: 60,
        stylist: "Any",
        availableFrom: new Date(now).toISOString(),
        availableUntil: new Date(now + 18000000).toISOString(),
        joined: 1,
        consent: true,
        delivery: "ok",
      },
    ],
  });
  async function offered() {
    for (let i = 0; i < 100; i++) {
      const s = await handle.query("getDesk");
      if (s.offers[0]?.status === "offered") return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("No active offer");
  }
  const before = await offered();
  const dead = child;
  dead.kill("SIGKILL");
  await new Promise((resolve) => dead.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await startWorker();
  const after = await offered();
  assert.equal(after.offers[0].id, before.offers[0].id);
  assert.equal(after.offers[0].deadline, before.offers[0].deadline);
  assert.equal(after.offers.length, 1);
  const accepted = await command({
    type: "reply",
    offerId: after.offers[0].id,
    reply: "accept",
  });
  assert.equal(accepted.ok, true);
  const state = await handle.query("getDesk");
  assert.equal(state.phase, "held");
  const result = {
    verifiedAt: new Date().toISOString(),
    workflowId: id,
    taskQueue: queue,
    workerTermination: "SIGKILL",
    before: {
      offerId: before.offers[0].id,
      deadline: before.offers[0].deadline,
    },
    after: { offerId: after.offers[0].id, deadline: after.offers[0].deadline },
    offerCount: state.offers.length,
    phaseAfterAcceptance: state.phase,
    result: "PASS",
  };
  await fs.mkdir("evidence", { recursive: true });
  await fs.writeFile(
    "evidence/worker-recovery.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (handle)
    await handle.terminate("Isolated recovery verification completed");
  if (child) child.kill("SIGTERM");
  await connection.close();
}
