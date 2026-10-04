import { activityInfo } from "@temporalio/activity";
// No SMS is sent. The stable receipt models a provider idempotency key.
// A real provider must honor this key across retries before enabling real messages.
export async function deliverOffer(input: {
  offerId: string;
  delivery: "ok" | "fail" | "retry";
}): Promise<{ delivered: boolean; receipt: string; attempts: number }> {
  const attempts = activityInfo().attempt;
  if (input.delivery === "retry" && attempts === 1)
    throw new Error("Simulated transient provider outage");
  return {
    delivered: input.delivery !== "fail",
    receipt: `simulated:${input.offerId}`,
    attempts,
  };
}
