export type Client = {
  id: string;
  name: string;
  mobile: string;
  service: string;
  minutes: number;
  stylist: string;
  availableFrom: string;
  availableUntil: string;
  joined: number;
  consent: boolean;
  delivery: "ok" | "fail" | "retry";
};
export type Opening = {
  id: string;
  service: string;
  stylist: string;
  minutes: number;
  startsAt: string;
  mode: "demo" | "standard";
  timezone: string;
};
export type Offer = {
  id: string;
  clientId: string;
  name: string;
  deadline: number;
  status:
    | "sending"
    | "offered"
    | "declined"
    | "expired"
    | "failed"
    | "held"
    | "booked"
    | "canceled"
    | "released"
    | "opted_out";
  message: string;
};
export type Event = {
  at: number;
  text: string;
  kind: "info" | "success" | "attention";
};
export type Desk = {
  opening: Opening | null;
  phase:
    | "idle"
    | "searching"
    | "offering"
    | "held"
    | "booked"
    | "withdrawn"
    | "unfilled";
  clients: Client[];
  offers: Offer[];
  events: Event[];
  questions: {
    offerId: string;
    name: string;
    text: string;
    resolved: boolean;
  }[];
  clockOffset: number;
  now: number;
  revision: number;
  staffNote: string;
  totals: { opened: number; booked: number };
};
export type Command = {
  requestId: string;
  type: "start" | "reply" | "confirm" | "release" | "withdraw" | "resolve";
  opening?: Opening;
  clients?: Client[];
  offerId?: string;
  reply?: "accept" | "decline" | "question" | "stop";
  text?: string;
  squareConfirmed?: boolean;
};
export type Result = { ok: boolean; message: string };
