import type { Client, Opening } from "./types";

// Fictional profile data for the local demonstration, not a Square import.
export function demoProfile(client: Client, opening: Opening): Client {
  const n = Math.max(1, client.joined);
  const start = Date.parse(opening.startsAt);
  return {
    ...client,
    mobile: `+1 (202) 555-${String(100 + n).padStart(4, "0")}`,
    stylist:
      client.stylist === "Other stylist"
        ? opening.stylist === "Lena"
          ? "Carla"
          : "Lena"
        : client.stylist,
    joinedAt:
      client.joinedAt ?? new Date(start - (9 - n) * 86400000).toISOString(),
    existingAppointment:
      client.existingAppointment ??
      new Date(start + (n + 3) * 86400000).toISOString(),
  };
}
export function sampleClients(opening: Opening, scenario = "normal"): Client[] {
  const base = {
    mobile: "",
    service: opening.service,
    minutes: opening.minutes,
    stylist: "Any",
    availableFrom: new Date(
      Date.parse(opening.startsAt) - 3600000,
    ).toISOString(),
    availableUntil: new Date(
      Date.parse(opening.startsAt) + 4 * 3600000,
    ).toISOString(),
    consent: true,
    delivery: "ok" as const,
  };
  return [
    {
      ...base,
      id: "anna",
      name: "Anna Rivera",
      joined: 1,
      delivery:
        scenario === "failed"
          ? ("fail" as const)
          : scenario === "retry"
            ? ("retry" as const)
            : ("ok" as const),
    },
    {
      ...base,
      id: "mei",
      name: "Mei Chen",
      joined: 2,
      stylist: opening.stylist,
    },
    { ...base, id: "maya", name: "Maya Brooks", joined: 3 },
    {
      ...base,
      id: "jules",
      name: "Jules Reed",
      joined: 4,
      stylist: opening.stylist === "Lena" ? "Carla" : "Lena",
    },
    {
      ...base,
      id: "noor",
      name: "Noor Ellis",
      joined: 5,
      minutes: opening.minutes + 30,
    },
    { ...base, id: "sofia", name: "Sofia Park", joined: 6, consent: false },
  ].map((c) => demoProfile(c, opening));
}
