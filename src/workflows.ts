import {
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type { Command, Desk, Offer, Result } from "./types";
import { canOffer, DEMO_NOW, eligible } from "./rules";
const { deliverOffer } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
  scheduleToCloseTimeout: "15 seconds",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "2 seconds",
    maximumAttempts: 3,
  },
});
export const getDesk = defineQuery<Desk>("getDesk");
export const command = defineUpdate<Result, [Command]>("command");
export async function salonDesk(): Promise<void> {
  const state: Desk = {
    opening: null,
    phase: "idle",
    clients: [],
    offers: [],
    events: [],
    questions: [],
    clockOffset: 0,
    now: 0,
    revision: 0,
    staffNote: "",
    totals: { opened: 0, booked: 0 },
  };
  const now = () => Date.now() + state.clockOffset;
  const active = () =>
    state.offers.find((o) => ["sending", "offered", "held"].includes(o.status));
  const event = (
    text: string,
    kind: "info" | "success" | "attention" = "info",
  ) => {
    state.events.push({ at: now(), text, kind });
    state.events = state.events.slice(-200);
    state.revision++;
  };
  const suppressed = new Set<string>(); // Durable opt-outs survive subsequent openings and Worker restarts.
  setHandler(getDesk, () => ({ ...state, now: now() }));
  setHandler(command, (cmd) => {
    const reject = (message: string): Result => ({ ok: false, message });
    const accept = (message: string): Result => ({ ok: true, message });
    if (cmd.type === "start") {
      if (["searching", "offering", "held"].includes(state.phase))
        return reject("Finish or withdraw the current opening first.");
      if (!cmd.opening || !cmd.clients)
        return reject("Opening and waitlist are required.");
      const offset = cmd.opening.mode === "demo" ? DEMO_NOW - Date.now() : 0;
      const blocked = canOffer(
        cmd.opening,
        Date.now() + offset,
        cmd.opening.mode === "demo" ? 20000 : 900000,
      );
      if (blocked) return reject(blocked);
      state.clockOffset = offset;
      state.opening = cmd.opening;
      state.clients = cmd.clients.map((c) => ({
        ...c,
        consent: c.consent && !suppressed.has(c.id),
      }));
      state.offers = [];
      state.events = [];
      state.questions = [];
      state.staffNote = "";
      state.phase = "searching";
      state.totals.opened++;
      event("Outreach started. One exclusive offer at a time.");
      return accept("Outreach started.");
    }
    if (cmd.type === "reply") {
      const offer = state.offers.find((o) => o.id === cmd.offerId);
      if (!offer) return reject("This offer is no longer available.");
      if (cmd.reply === "stop") {
        suppressed.add(offer.clientId);
        state.clients.find((c) => c.id === offer.clientId)!.consent = false;
        if (["sending", "offered"].includes(offer.status)) {
          offer.status = "opted_out";
          state.phase = "searching";
        }
        event(
          `${offer.name} opted out. No more offers will be sent to this client.`,
          "attention",
        );
        return accept(
          "You will not receive further offers. An existing hold or booking is unchanged.",
        );
      }
      if (
        offer.status !== "offered" ||
        now() >= offer.deadline ||
        state.phase !== "offering"
      )
        return reject(
          "This offer has expired or the opening is no longer available to you.",
        );
      if (cmd.reply === "question") {
        state.questions.push({
          offerId: offer.id,
          name: offer.name,
          text: cmd.text || "Please contact me.",
          resolved: false,
        });
        event(
          `${offer.name} has a question. The original deadline is unchanged.`,
          "attention",
        );
        return accept(
          "Staff will see your question. Your offer deadline is unchanged.",
        );
      }
      if (cmd.reply === "accept") {
        offer.status = "held";
        state.phase = "held";
        event(
          `${offer.name} accepted. Hold reserved; staff must complete the change in Square.`,
          "attention",
        );
        return accept(
          "This spot is held for you. The salon will confirm after updating Square.",
        );
      }
      if (cmd.reply === "decline") {
        offer.status = "declined";
        state.phase = "searching";
        event(`${offer.name} declined. Moving to the next eligible client.`);
        return accept(
          "Thanks for letting us know. Your existing booking is unchanged.",
        );
      }
      return reject("Choose a valid response.");
    }
    if (cmd.type === "withdraw") {
      if (!["searching", "offering", "held"].includes(state.phase))
        return reject("There is no active opening to withdraw.");
      const offer = active();
      if (offer) offer.status = "canceled";
      state.phase = "withdrawn";
      state.staffNote = cmd.text || "Opening withdrawn by staff.";
      event(
        state.staffNote +
          " All pending offers canceled; later acceptance is blocked.",
        "attention",
      );
      return accept(
        "Opening withdrawn. Contact any held client personally; no real SMS was sent.",
      );
    }
    if (cmd.type === "resolve") {
      const question = state.questions.find(
        (q) => q.offerId === cmd.offerId && !q.resolved,
      );
      if (!question) return reject("No unresolved question for this offer.");
      question.resolved = true;
      event(`Staff handled ${question.name}'s question.`);
      return accept("Question marked handled.");
    }
    if (cmd.type === "confirm" || cmd.type === "release") {
      const offer = active();
      if (state.phase !== "held" || !offer || cmd.offerId !== offer.id)
        return reject(
          "This hold is no longer current. Refresh the staff view.",
        );
      if (cmd.type === "confirm") {
        if (!cmd.squareConfirmed || !cmd.text?.trim())
          return reject(
            "Confirm you updated Square and enter a staff note first.",
          );
        offer.status = "booked";
        state.phase = "booked";
        state.staffNote = cmd.text;
        state.totals.booked++;
        event(
          `Booking recorded by staff for ${offer.name}. ${cmd.text}`,
          "success",
        );
        return accept("Booking recorded. Outreach is closed.");
      }
      if (!cmd.text?.trim())
        return reject("Enter a reason before releasing this hold.");
      offer.status = "released";
      state.phase = "searching";
      event(
        `Staff released ${offer.name}'s hold: ${cmd.text}. Moving to the next client.`,
        "attention",
      );
      return accept(
        "Hold released. Contact the client personally; their original Square booking is unchanged.",
      );
    }
    return reject("Unknown action.");
  });
  for (;;) {
    if (state.phase === "searching" && state.opening) {
      const opening = state.opening;
      const duration = opening.mode === "demo" ? 20000 : 900000;
      const blocked = canOffer(opening, now(), duration);
      const client = [...state.clients]
        .sort((a, b) => a.joined - b.joined)
        .find(
          (c) =>
            !eligible(c, opening) &&
            !state.offers.some((o) => o.clientId === c.id),
        );
      if (blocked || !client) {
        state.phase = "unfilled";
        event(
          blocked ||
            "No eligible clients remain. The opening is unfilled; staff action needed.",
          "attention",
        );
        continue;
      }
      const offer: Offer = {
        id: `${opening.id}:${client.id}`,
        clientId: client.id,
        name: client.name,
        deadline: 0,
        status: "sending",
        message: `Juniper Salon: ${opening.service} with ${opening.stylist}. Reply before your deadline to hold this opening. Square confirmation follows separately.`,
      };
      state.offers.push(offer);
      state.phase = "offering";
      event(`Sending a simulated offer to ${client.name}.`);
      let delivered = false;
      let attempts = 0;
      try {
        const result = await deliverOffer({
          offerId: offer.id,
          delivery: client.delivery,
        });
        delivered = result.delivered;
        attempts = result.attempts;
      } catch {
        delivered = false;
      }
      const current = state.offers.find((o) => o.id === offer.id);
      // A withdrawal or opt-out during an Activity must never resurrect the offer.
      if (
        !current ||
        current.status !== "sending" ||
        state.opening?.id !== opening.id
      )
        continue;
      if (!delivered) {
        current.status = "failed";
        state.phase = "searching";
        event(
          `Delivery to ${client.name} failed. Moving to the next eligible client.`,
          "attention",
        );
        continue;
      }
      const tooLate = canOffer(opening, now(), duration);
      if (tooLate) {
        current.status = "canceled";
        state.phase = "unfilled";
        event(tooLate, "attention");
        continue;
      }
      current.status = "offered";
      current.deadline = now() + duration;
      event(
        `${client.name} has the exclusive offer.${attempts > 1 ? ` Delivery recovered after ${attempts} attempts.` : ""}`,
      );
      continue;
    }
    const offer = active();
    if (state.phase === "offering" && offer?.status === "offered") {
      const revision = state.revision;
      await condition(
        () => state.revision !== revision,
        Math.max(1, offer.deadline - now()),
      );
      if (offer.status === "offered" && now() >= offer.deadline) {
        offer.status = "expired";
        state.phase = "searching";
        event(
          `${offer.name}'s offer expired. Moving to the next eligible client.`,
        );
      }
    } else {
      const revision = state.revision;
      await condition(() => state.revision !== revision);
    }
  }
}
