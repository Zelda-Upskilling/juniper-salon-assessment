import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { salonDesk } from "../src/workflows";
import { canOffer, DEMO_NOW, eligible } from "../src/rules";
import * as activities from "../src/activities";
import type { Client, Command, Desk, Opening, Result } from "../src/types";
const opening = (): Opening => ({
  id: randomUUID(),
  service: "Haircut",
  stylist: "Lena",
  minutes: 60,
  startsAt: new Date(DEMO_NOW + 7200000).toISOString(),
  mode: "demo",
  timezone: "America/Los_Angeles",
});
const clients = (): Client[] =>
  ["Anna", "Mei", "Maya"].map((name, index) => ({
    id: name.toLowerCase(),
    name,
    mobile: "555-0100",
    service: "Haircut",
    minutes: 60,
    stylist: "Any",
    availableFrom: new Date(DEMO_NOW).toISOString(),
    availableUntil: new Date(DEMO_NOW + 18000000).toISOString(),
    joined: index,
    consent: true,
    delivery: "ok",
  }));
test("matching and contact boundaries reflect Lena’s rules", () => {
  const o = opening(),
    c = clients()[0];
  assert.equal(eligible(c, o), null);
  for (const change of [
    { consent: false },
    { minutes: 90 },
    { stylist: "Carla" },
    { service: "Color" },
    { availableUntil: new Date(DEMO_NOW + 7200000).toISOString() },
  ])
    assert.ok(eligible({ ...c, ...change }, o));
  assert.ok(canOffer(o, Date.parse("2030-06-10T15:00:00Z"), 900000)); // 8am
  assert.ok(
    canOffer(
      { ...o, startsAt: new Date(DEMO_NOW + 44 * 60000).toISOString() },
      DEMO_NOW,
      900000,
    ),
  );
  assert.equal(
    canOffer(
      { ...o, startsAt: new Date(DEMO_NOW + 45 * 60000).toISOString() },
      DEMO_NOW,
      900000,
    ),
    null,
  );
});
test("Temporal acceptance, failure and recovery contracts", async (t) => {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: "juniper-tests",
    workflowsPath: require.resolve("../src/workflows"),
    activities,
  });
  try {
    await worker.runUntil(async () => {
      async function fixture(list = clients()) {
        const h = await env.client.workflow.start(salonDesk, {
          workflowId: randomUUID(),
          taskQueue: "juniper-tests",
          args: [],
        });
        const cmd = (
          input: Omit<Command, "requestId">,
          requestId = randomUUID(),
        ) =>
          h.executeUpdate<Result, [Command]>("command", {
            args: [{ ...input, requestId }],
            updateId: requestId,
          });
        const state = () => h.query<Desk>("getDesk");
        const until = async (predicate: (s: Desk) => boolean) => {
          for (let i = 0; i < 200; i++) {
            const s = await state();
            if (predicate(s)) return s;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error("Workflow state did not become ready");
        };
        assert.equal(
          (await cmd({ type: "start", opening: opening(), clients: list })).ok,
          true,
        );
        return { h, cmd, state, until };
      }
      await t.test(
        "one winner, idempotent acceptance, explicit Square confirmation",
        async () => {
          const f = await fixture();
          const s = await f.until((s) =>
            s.offers.some((o) => o.status === "offered"),
          );
          const id = s.offers[0].id;
          const key = randomUUID();
          const results = await Promise.all([
            f.cmd({ type: "reply", offerId: id, reply: "accept" }, key),
            f.cmd({ type: "reply", offerId: id, reply: "accept" }, key),
          ]);
          assert.ok(results.every((r) => r.ok));
          assert.equal((await f.state()).phase, "held");
          assert.equal(
            (await f.cmd({ type: "reply", offerId: id, reply: "accept" })).ok,
            false,
          );
          assert.equal(
            (await f.cmd({ type: "confirm", offerId: id })).ok,
            false,
          );
          assert.equal(
            (
              await f.cmd({
                type: "start",
                opening: opening(),
                clients: clients(),
              })
            ).ok,
            false,
          );
          await env.sleep("40 seconds");
          assert.equal((await f.state()).offers.length, 1);
          assert.equal(
            (
              await f.cmd({
                type: "confirm",
                offerId: id,
                squareConfirmed: true,
                text: "Demo Square update recorded",
              })
            ).ok,
            true,
          );
          assert.equal((await f.state()).totals.booked, 1);
          await f.h.terminate();
        },
      );
      await t.test(
        "questions do not extend deadlines; late replies fail",
        async () => {
          const f = await fixture();
          const before = await f.until(
            (s) => s.offers[0]?.status === "offered",
          );
          const offer = before.offers[0];
          await f.cmd({
            type: "reply",
            offerId: offer.id,
            reply: "question",
            text: "Can I arrive early?",
          });
          assert.equal((await f.state()).offers[0].deadline, offer.deadline);
          await env.sleep("21 seconds");
          await f.until(
            (s) => s.offers.length >= 2 && s.offers[1].status === "offered",
          );
          assert.equal(
            (await f.cmd({ type: "reply", offerId: offer.id, reply: "accept" }))
              .ok,
            false,
          );
          assert.equal((await f.state()).offers[0].status, "expired");
          await f.h.terminate();
        },
      );
      await t.test(
        "decline and release advance without reoffering to the same client",
        async () => {
          const f = await fixture();
          let s = await f.until((s) => s.offers[0]?.status === "offered");
          await f.cmd({
            type: "reply",
            offerId: s.offers[0].id,
            reply: "decline",
          });
          s = await f.until((s) => s.offers[1]?.status === "offered");
          await f.cmd({
            type: "reply",
            offerId: s.offers[1].id,
            reply: "accept",
          });
          assert.equal(
            (await f.cmd({ type: "release", offerId: s.offers[1].id })).ok,
            false,
          );
          await f.cmd({
            type: "release",
            offerId: s.offers[1].id,
            text: "Client cannot attend; notified personally",
          });
          s = await f.until((s) => s.offers[2]?.status === "offered");
          assert.equal(s.offers[2].name, "Maya");
          await f.h.terminate();
        },
      );
      await t.test(
        "failed delivery advances; transient delivery retries",
        async () => {
          const list = clients();
          list[0].delivery = "fail";
          list[1].delivery = "retry";
          const f = await fixture(list);
          const s = await f.until((s) => s.offers[1]?.status === "offered");
          assert.equal(s.offers[0].status, "failed");
          assert.ok(s.events.some((e) => e.text.includes("2 attempts")));
          await f.h.terminate();
        },
      );
      await t.test(
        "withdrawn offers cannot be accepted; opt-outs survive new openings",
        async () => {
          const f = await fixture();
          let s = await f.until((s) => s.offers[0]?.status === "offered");
          const id = s.offers[0].id;
          await f.cmd({ type: "withdraw" });
          assert.equal(
            (await f.cmd({ type: "reply", offerId: id, reply: "accept" })).ok,
            false,
          );
          await f.cmd({ type: "reply", offerId: id, reply: "stop" });
          await f.cmd({
            type: "start",
            opening: opening(),
            clients: clients(),
          });
          s = await f.until((s) => s.offers[0]?.status === "offered");
          assert.equal(s.offers[0].name, "Mei");
          assert.equal(s.clients[0].consent, false);
          await f.h.terminate();
        },
      );
      await t.test("competing replies have exactly one winner", async () => {
        const f = await fixture();
        const s = await f.until((s) => s.offers[0]?.status === "offered");
        const results = await Promise.all([
          f.cmd({ type: "reply", offerId: s.offers[0].id, reply: "accept" }),
          f.cmd({ type: "reply", offerId: s.offers[0].id, reply: "accept" }),
        ]);
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.equal(
          (await f.state()).offers.filter((o) => o.status === "held").length,
          1,
        );
        await f.h.terminate();
      });
      await t.test(
        "withdrawal during delivery retry cannot resurrect the offer",
        async () => {
          const list = clients();
          list[0].delivery = "retry";
          const f = await fixture(list);
          await f.cmd({ type: "withdraw" });
          await env.sleep("5 seconds");
          const s = await f.state();
          assert.equal(s.phase, "withdrawn");
          assert.ok(s.offers.every((o) => o.status === "canceled"));
          await f.h.terminate();
        },
      );
      await t.test("empty eligible list ends unfilled", async () => {
        const f = await fixture(
          clients().map((c) => ({ ...c, consent: false })),
        );
        const s = await f.until((s) => s.phase === "unfilled");
        assert.equal(s.offers.length, 0);
        await f.h.terminate();
      });
    });
  } finally {
    await env.teardown();
  }
});
