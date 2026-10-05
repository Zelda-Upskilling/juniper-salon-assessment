import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  Client as TemporalClient,
  Connection,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Client, Command, Desk, Opening, Result } from "./types";
import { salonDesk } from "./workflows";
import { eligible, DEMO_NOW } from "./rules";
import { sampleClients, demoProfile } from "./demo-clients";
const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(process.cwd(), "public")));
const workflowId = process.env.DESK_WORKFLOW_ID || "juniper-desk-v1";
let connectionPromise: Promise<TemporalClient> | undefined;
async function desk() {
  connectionPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS || "localhost:7233",
  }).then(
    (connection) => new TemporalClient({ connection, namespace: "default" }),
  );
  const client = await connectionPromise;
  try {
    await client.workflow.start(salonDesk, {
      workflowId,
      taskQueue: "juniper-salon",
      args: [],
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      connectionPromise = undefined;
      throw error;
    }
  }
  return client.workflow.getHandle(workflowId);
}
function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
const text = (v: unknown, max = 500) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
function parseCommand(body: any): Command {
  if (!body || typeof body !== "object" || Array.isArray(body))
    bad("A JSON action is required.");
  if (!text(body.requestId, 100))
    bad("A requestId is required for safe retries.");
  if (
    !["start", "reply", "confirm", "release", "withdraw", "resolve"].includes(
      body.type,
    )
  )
    bad("Unknown action.");
  if (
    body.text !== undefined &&
    (typeof body.text !== "string" || body.text.length > 500)
  )
    bad("Notes must contain at most 500 characters.");
  const cmd: Command = {
    requestId: body.requestId,
    type: body.type,
    text: body.text,
  };
  if (body.type === "start") {
    const o = body.opening;
    if (
      !o ||
      !["Haircut", "Color touch-up", "Blowout"].includes(o.service) ||
      !["Lena", "Carla"].includes(o.stylist) ||
      !Number.isInteger(o.minutes) ||
      o.minutes < 15 ||
      o.minutes > 180 ||
      !["demo", "standard"].includes(o.mode) ||
      !text(o.startsAt, 40) ||
      !Number.isFinite(Date.parse(o.startsAt))
    )
      bad("Enter a valid service, stylist, duration, and appointment time.");
    if (o.timezone !== "America/Los_Angeles")
      bad("This prototype uses America/Los_Angeles.");
    if (!["normal", "failed", "retry"].includes(body.scenario || "normal"))
      bad("Unknown demonstration scenario.");
    const opening: Opening = {
      id: randomUUID(),
      service: o.service,
      stylist: o.stylist,
      minutes: o.minutes,
      mode: o.mode,
      startsAt: new Date(o.startsAt).toISOString(),
      timezone: o.timezone,
    };
    cmd.opening = opening;
    cmd.clients = sampleClients(opening, body.scenario);
  }
  if (["reply", "confirm", "release", "resolve"].includes(body.type)) {
    if (!text(body.offerId, 150)) bad("An offerId is required.");
    cmd.offerId = body.offerId;
  }
  if (body.type === "reply") {
    if (!["accept", "decline", "question", "stop"].includes(body.reply))
      bad("Choose a valid client response.");
    cmd.reply = body.reply;
  }
  if (body.type === "confirm")
    cmd.squareConfirmed = body.squareConfirmed === true;
  return cmd;
}
app.get("/api/health", async (_req, res) => {
  const h = await desk();
  await h.describe();
  res.json({ ok: true, workflowId });
});
app.get("/api/desk", async (_req, res) => {
  const handle = await desk();
  const state = await handle.query<Desk>("getDesk");
  const preview: Opening = state.opening ?? {
    id: "preview",
    service: "Haircut",
    stylist: "Lena",
    minutes: 60,
    startsAt: new Date(DEMO_NOW + 7200000).toISOString(),
    mode: "demo",
    timezone: "America/Los_Angeles",
  };
  const clients = (
    state.clients.length ? state.clients : sampleClients(preview)
  ).map((c) => demoProfile(c, preview));
  res.json({
    ...state,
    workflowId,
    clients: clients.map((c) => ({
      ...c,
      reason: state.opening ? eligible(c, state.opening) : null,
    })),
  });
});
app.get("/api/defaults", (_req, res) =>
  res.json({
    demoNow: DEMO_NOW,
    demoAppointment: new Date(DEMO_NOW + 2 * 3600000).toISOString(),
    timezone: "America/Los_Angeles",
  }),
);
app.post("/api/command", async (req, res) => {
  const cmd = parseCommand(req.body);
  const handle = await desk();
  const result = await handle.executeUpdate<Result, [Command]>("command", {
    args: [cmd],
    updateId: cmd.requestId,
  });
  res.status(result.ok ? 200 : 409).json(result);
});
app.use("/api", (_req, res) =>
  res.status(404).json({ ok: false, error: "API endpoint not found." }),
);
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    error.type === "entity.too.large"
      ? 413
      : error instanceof SyntaxError
        ? 400
        : error.status || 503;
  if (status === 503) res.setHeader("Retry-After", "2");
  res.status(status).json({
    ok: false,
    error:
      status === 503
        ? "The salon service is reconnecting. Your workflow is saved; retry shortly."
        : status === 413
          ? "Request is too large."
          : error.message || "Invalid request.",
  });
});
app.listen(Number(process.env.PORT || 3000), "127.0.0.1", () =>
  console.log("Juniper Salon: http://localhost:3000"),
);
