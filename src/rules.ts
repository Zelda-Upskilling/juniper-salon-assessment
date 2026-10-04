import type { Client, Opening } from "./types";
export const DEMO_NOW = Date.parse("2030-06-10T17:00:00Z"); // Explicitly simulated: 10am Los Angeles.
export function localHour(time: number, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(time),
  );
}
export function inContactHours(time: number, timezone: string): boolean {
  const hour = localHour(time, timezone);
  return hour >= 9 && hour < 19;
}
export function eligible(client: Client, opening: Opening): string | null {
  if (!client.consent) return "No permission to contact";
  if (client.service !== opening.service) return "Different service";
  if (client.minutes > opening.minutes) return "Service is too long";
  if (client.stylist !== "Any" && client.stylist !== opening.stylist)
    return "Different stylist";
  const start = Date.parse(opening.startsAt);
  if (
    Date.parse(client.availableFrom) > start ||
    Date.parse(client.availableUntil) < start + client.minutes * 60000
  )
    return "Outside availability";
  return null;
}
export function canOffer(
  opening: Opening,
  now: number,
  duration: number,
): string | null {
  if (!inContactHours(now, opening.timezone))
    return "Outside 9 am–7 pm contact hours. Staff action needed.";
  if (!inContactHours(now + duration - 1, opening.timezone))
    return "Not enough contact time left for a full offer. Staff action needed.";
  if (now + duration > Date.parse(opening.startsAt) - 30 * 60000)
    return "Not enough time for an offer and 30 minutes of travel. Staff action needed.";
  return null;
}
