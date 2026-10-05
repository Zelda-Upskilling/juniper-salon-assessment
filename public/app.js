const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let state,
  creating = false,
  selectedOffer = "",
  manualSelection = false,
  lastRevision = -1,
  pendingCommand = null,
  busy = false,
  lastClientState = "";
const names = {
  idle: "Ready",
  searching: "Matching",
  offering: "Offer in progress",
  held: "Needs Square update",
  booked: "Booking recorded",
  withdrawn: "Withdrawn",
  unfilled: "Unfilled",
};
const time = (ms, options = {}) =>
  new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  });
const dateTime = (ms) =>
  time(ms, { weekday: "short", month: "short", day: "numeric" });
const localInput = (ms) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(ms)
    .replace(" ", "T");
// Convert Los Angeles wall-clock input without depending on the evaluator's timezone.
function fromSalonInput(value) {
  const parts = value.split(/[-T:]/).map(Number);
  let guess = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  for (let i = 0; i < 3; i++) {
    const wall = localInput(guess).split(/[-T:]/).map(Number);
    guess +=
      Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]) -
      Date.UTC(wall[0], wall[1] - 1, wall[2], wall[3], wall[4]);
  }
  if (localInput(guess) !== value)
    throw new Error(
      "That local time does not exist. Choose another appointment time.",
    );
  return new Date(guess).toISOString();
}
function toast(message, error = false, retry = false) {
  $("toast").hidden = false;
  $("toast").className = error ? "error" : "";
  $("toast").textContent = message;
  if (retry) {
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = "Retry same action";
    button.onclick = () => send(pendingCommand, true);
    $("toast").append(" ", button);
  }
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(12000),
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        body.message || body.error || "The request could not be completed.",
      ),
      { known: true },
    );
  return body;
}
async function send(input, retry = false) {
  if (busy) return;
  busy = true;
  const command = retry ? input : { ...input, requestId: crypto.randomUUID() };
  pendingCommand = command;
  try {
    const result = await jsonFetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    pendingCommand = null;
    toast(result.message);
    if (command.type === "reply")
      $("client-feedback").textContent = result.message;
    if (command.type === "start") {
      creating = false;
      manualSelection = false;
      selectedOffer = "";
      $("staff-note").value = "";
      $("square-confirmed").checked = false;
    }
    await refresh();
  } catch (error) {
    toast(
      error.known
        ? error.message
        : "Connection interrupted. The action may have been saved. Retry the same action safely.",
      true,
      !error.known,
    );
    if (command.type === "reply")
      $("client-feedback").textContent = error.message;
  } finally {
    busy = false;
  }
}
async function refresh() {
  try {
    const next = await jsonFetch("/api/desk");
    if (state && next.revision < state.revision) return;
    state = next;
    $("connection").textContent = "Desk connected";
    $("connection").className = "connection";
    if (state.revision !== lastRevision) {
      lastRevision = state.revision;
      render();
    }
    tick();
  } catch {
    $("connection").textContent = "Reconnecting · actions may wait";
    $("connection").className = "connection offline";
  }
}
function render() {
  const active = state.offers.find((o) =>
    ["sending", "offered", "held"].includes(o.status),
  );
  if (!manualSelection)
    selectedOffer = active?.id || state.offers.at(-1)?.id || "";
  $("phase").textContent = creating ? "New opening" : names[state.phase];
  const formVisible = creating || state.phase === "idle";
  $("start-form").hidden = !formVisible;
  $("active-opening").hidden = formVisible;
  $("opening-title").textContent = formVisible
    ? "Add a canceled appointment"
    : `${state.opening.service} with ${state.opening.stylist}`;
  if (state.opening)
    $("appointment-detail").textContent =
      `${dateTime(state.opening.startsAt)} · ${state.opening.minutes} min · ${state.opening.mode === "demo" ? "Simulated date / 20-second offers" : "15-minute offers"}`;
  for (const [id, phases] of Object.entries({
    "step-match": ["searching"],
    "step-offer": ["offering"],
    "step-hold": ["held"],
    "step-book": ["booked"],
  }))
    $(id).className = phases.includes(state.phase) ? "current" : "";
  $("next-action").textContent = {
    idle: "Ready for an opening.",
    searching: "Finding the next eligible client…",
    offering: active
      ? `${active.name} ${active.status === "sending" ? "is receiving a simulated offer." : "has the exclusive offer. The next client is contacted automatically if they decline or the deadline passes."}`
      : "Moving to the next person…",
    held: `${active?.name || "The client"} accepted. This is a hold, not a confirmed booking.\nUpdate Square, then record the booking below.`,
    booked:
      "Booking recorded by staff. The opening is closed and outreach has stopped.",
    withdrawn:
      "This opening was withdrawn. Pending offers are canceled; later acceptance is blocked.",
    unfilled:
      "This opening remains unfilled. Check the journal and decide whether to contact someone manually.",
  }[state.phase];
  $("hold-controls").hidden = state.phase !== "held";
  $("withdraw").hidden = !["searching", "offering", "held"].includes(
    state.phase,
  );
  $("new-opening").hidden = ["idle", "searching", "offering", "held"].includes(
    state.phase,
  );
  renderOverview();
  renderWaitlist();
  if ($("client-dialog").open) renderProfile();
  $("offer-select").innerHTML = state.offers.length
    ? state.offers
        .map(
          (o) =>
            `<option value="${esc(o.id)}">${esc(o.name)} · ${esc(o.status.replaceAll("_", " "))}</option>`,
        )
        .join("")
    : '<option value="">No offers yet</option>';
  $("offer-select").value = selectedOffer;
  renderClient();
  $("events").innerHTML = state.events.length
    ? [...state.events]
        .reverse()
        .map(
          (e) =>
            `<div class="event ${e.kind}"><time>${esc(time(e.at, { second: "2-digit" }))}</time><span>${esc(e.text)}</span></div>`,
        )
        .join("")
    : '<p class="empty">Your opening’s story will appear here.</p>';
  $("workflow-label").textContent = state.workflowId;
  const questions = state.questions.filter((q) => !q.resolved);
  $("questions").hidden = !questions.length;
  $("questions").innerHTML =
    '<span class="eyebrow">STAFF ATTENTION</span><h2>A client has a question.</h2>' +
    questions
      .map(
        (q) =>
          `<p><strong>${esc(q.name)}</strong>: ${esc(q.text)}</p><button class="secondary" data-resolve="${esc(q.offerId)}">Mark handled</button>`,
      )
      .join("");
  $("questions")
    .querySelectorAll("[data-resolve]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          send({ type: "resolve", offerId: b.dataset.resolve })),
    );
}
function renderClient() {
  const offer = state?.offers.find((o) => o.id === selectedOffer);
  const key = offer ? offer.id + ":" + offer.status : "";
  if (key !== lastClientState) {
    $("client-feedback").textContent = "";
    lastClientState = key;
  }
  $("client-actions").hidden = !offer;
  if (!offer) {
    $("client-message").textContent =
      "Your client’s offer will appear here when outreach starts.";
    $("deadline").textContent = "";
    return;
  }
  const opening = state.opening;
  const details = `${dateTime(opening.startsAt)} · ${opening.minutes} minutes\n`;
  const copy = {
    sending: "Preparing your offer…",
    offered: `Hi ${offer.name.split(" ")[0]}! An earlier ${opening.service.toLowerCase()} with ${opening.stylist} is available.\n${details}This offer is just for you until ${time(offer.deadline, { second: "2-digit" })}. Say yes to hold it; the salon will confirm after updating Square.`,
    held: `This spot is held for you, ${offer.name.split(" ")[0]}.\n${details}The salon still needs to confirm the change in Square. Your existing appointment is unchanged for now.`,
    booked: `The salon recorded your booking.\n${details}In this prototype, Square updates and messages are simulated.`,
    expired:
      "This offer has expired. The opening is no longer available to you.",
    declined: "You declined this offer. Your existing booking is unchanged.",
    failed:
      "This simulated message could not be delivered. The salon moved to the next client.",
    canceled:
      "This opening is no longer available. Your offer has been canceled.",
    released:
      "The salon released this hold. Staff should contact you personally; your existing booking is unchanged.",
    opted_out:
      "You will not receive further offers. Your existing booking is unchanged.",
  };
  $("client-message").textContent = copy[offer.status];
  // Leave the accept control available for expired offers to demonstrate server-side rejection.
  $("accept").textContent = [
    "expired",
    "canceled",
    "declined",
    "released",
    "failed",
  ].includes(offer.status)
    ? "Try replying to this old offer"
    : "Yes, hold this spot";
  $("accept").disabled = ["sending", "held", "booked", "opted_out"].includes(
    offer.status,
  );
  $("decline").disabled = offer.status !== "offered";
  $("ask").disabled = offer.status !== "offered";
  $("question-text").disabled = offer.status !== "offered";
  tick();
}
function tick() {
  const offer = state?.offers.find((o) => o.id === selectedOffer);
  if (!offer) return;
  if (offer.status === "offered") {
    const remaining = Math.max(
      0,
      Math.ceil((offer.deadline - (Date.now() + state.clockOffset)) / 1000),
    );
    $("deadline").textContent = remaining
      ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} remaining · ${state.opening.mode === "demo" ? "accelerated demonstration" : "exclusive offer"}`
      : "Deadline passed · moving to the next client…";
  } else
    $("deadline").textContent =
      offer.status === "held"
        ? "Reserved until staff confirms or releases."
        : offer.status === "booked"
          ? "Recorded by staff."
          : "";
}
$("start-form").onsubmit = (event) => {
  event.preventDefault();
  try {
    send({
      type: "start",
      scenario: $("scenario").value,
      opening: {
        service: $("service").value,
        stylist: $("stylist").value,
        minutes: Number($("minutes").value),
        mode: $("mode").value,
        startsAt: fromSalonInput($("startsAt").value),
        timezone: "America/Los_Angeles",
      },
    });
  } catch (error) {
    toast(error.message, true);
  }
};
$("offer-select").onchange = () => {
  selectedOffer = $("offer-select").value;
  manualSelection = true;
  $("client-feedback").textContent = "";
  renderClient();
};
$("accept").onclick = () =>
  send({ type: "reply", offerId: selectedOffer, reply: "accept" });
$("decline").onclick = () =>
  send({ type: "reply", offerId: selectedOffer, reply: "decline" });
$("ask").onclick = () =>
  send({
    type: "reply",
    offerId: selectedOffer,
    reply: "question",
    text: $("question-text").value || "Please contact me.",
  });
$("stop").onclick = () =>
  send({ type: "reply", offerId: selectedOffer, reply: "stop" });
const heldId = () => state.offers.find((o) => o.status === "held")?.id;
$("confirm").onclick = () =>
  send({
    type: "confirm",
    offerId: heldId(),
    text: $("staff-note").value,
    squareConfirmed: $("square-confirmed").checked,
  });
$("release").onclick = () =>
  send({ type: "release", offerId: heldId(), text: $("staff-note").value });
$("withdraw").onclick = () =>
  send({ type: "withdraw", text: "Opening withdrawn by staff." });
$("new-opening").onclick = () => {
  creating = true;
  manualSelection = false;
  render();
  $("start-form").scrollIntoView({ behavior: "smooth", block: "center" });
};
$("mode").onchange = () => {
  $("startsAt").value = localInput(
    $("mode").value === "demo"
      ? Date.parse("2030-06-10T19:00:00Z")
      : Date.now() + 2 * 3600000,
  );
  $("clock-note").textContent =
    $("mode").value === "demo"
      ? "Quick demo uses a simulated June 10, 2030 salon clock and 20-second offers."
      : "Standard mode uses real Los Angeles time and 15-minute offers. Texts remain simulated.";
};
let selectedClient = null;
function clientOffer(c) {
  return state.offers.find((o) => o.clientId === c.id);
}
function clientWaiting(c) {
  return !["held", "booked"].includes(clientOffer(c)?.status);
}
function fitReason(c) {
  if (!c.consent) return "Do not text · permission needed";
  if (!state.opening || creating)
    return "Match checked when you start an opening";
  if (c.stylist !== "Any" && c.stylist !== state.opening.stylist)
    return `Wants ${c.stylist} · this slot is with ${state.opening.stylist}`;
  if (c.minutes > state.opening.minutes)
    return `Needs ${c.minutes} min · this slot has ${state.opening.minutes}`;
  if (c.service !== state.opening.service)
    return `Wants ${c.service} · this slot is ${state.opening.service}`;
  if (c.reason) return "Not available at this time";
  return "Matches this opening";
}
function contactStatus(c) {
  const o = clientOffer(c);
  return (
    {
      sending: "Sending offer",
      offered: "Waiting for reply",
      held: "Accepted · update Square",
      booked: "Booked for latest opening",
      declined: "Declined this opening",
      expired: "No reply before deadline",
      failed: "Message not delivered",
      canceled: "Offer withdrawn",
      released: "Hold released",
      opted_out: "Asked to stop texts",
    }[o?.status] || (!c.consent ? "Do not contact" : "Not contacted yet")
  );
}
function contactTime(c) {
  const o = clientOffer(c);
  return (
    o?.sentAt ??
    state.events.find((e) =>
      e.text.startsWith(`${c.name} has the exclusive offer.`),
    )?.at
  );
}
function bookingTime(c) {
  return (
    clientOffer(c)?.bookedAt ??
    state.events.find((e) =>
      e.text.startsWith(`Booking recorded by staff for ${c.name}.`),
    )?.at
  );
}
function renderWaitlist() {
  const query = $("client-search").value.toLowerCase().trim(),
    filter = $("client-filter").value;
  const clients = [...state.clients]
    .sort((a, b) => a.joined - b.joined)
    .filter((c) => c.name.toLowerCase().includes(query))
    .filter(
      (c) =>
        filter === "all" ||
        (filter === "waiting" && clientWaiting(c)) ||
        (filter === "contacted" && !!clientOffer(c)) ||
        (filter === "booked" && clientOffer(c)?.status === "booked"),
    );
  $("list-context").textContent =
    `${clients.length} of ${state.clients.length} clients shown · Signup order, oldest first. ${state.opening ? "Contact history is for the latest opening." : "No clients have been contacted yet."}`;
  $("clients").innerHTML = clients.length
    ? clients
        .map((c) => {
          const o = clientOffer(c),
            sent = contactTime(c);
          return `<button type="button" class="client-row profile-link" data-client="${esc(c.id)}" aria-label="View ${esc(c.name)} contact details"><span class="queue-number" title="Signup order">${c.joined}</span><span class="client-identity"><strong>${esc(c.name)}</strong><small>${esc(c.service)} · ${c.minutes} min · ${c.stylist === "Any" ? "Any stylist" : esc(c.stylist) + " preferred"}</small><small>Joined ${esc(time(c.joinedAt, { month: "short", day: "numeric" }))}</small></span><span class="client-progress"><span class="client-status ${["offered", "held", "booked"].includes(o?.status) ? "live" : ""}">${esc(contactStatus(c))}</span><small>${esc(o ? (sent ? "Last text: " + dateTime(sent) : "No delivered text") : fitReason(c))}</small><span class="details-link">View details →</span></span></button>`;
        })
        .join("")
    : '<p class="empty">No clients match this filter.</p>';
  $("clients")
    .querySelectorAll("[data-client]")
    .forEach((b) => (b.onclick = () => openClient(b.dataset.client)));
}
function renderOverview() {
  const active = state.offers.find((o) =>
    ["sending", "offered", "held"].includes(o.status),
  );
  const unresolved = state.questions.filter((q) => !q.resolved).length;
  $("count-waiting").textContent = state.clients.filter(clientWaiting).length;
  $("count-offered").textContent = state.offers.filter((o) =>
    ["sending", "offered"].includes(o.status),
  ).length;
  $("count-attention").textContent =
    unresolved + state.offers.filter((o) => o.status === "held").length;
  $("count-booked").textContent = state.offers.filter(
    (o) => o.status === "booked",
  ).length;
  let title = "Choose the opening you want to fill",
    copy =
      "Enter the canceled appointment below. We will offer it to matching clients in signup order.",
    button = "Set up an opening";
  let action = () => {
    if (state.phase !== "idle") creating = true;
    render();
    $("service").focus();
    $("opening-card").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  if (!creating && state.phase === "held") {
    title = `${active.name} said yes. Finish the booking in Square.`;
    copy =
      "The spot is held. Nobody else will receive an offer until you confirm or release it.";
    button = "Confirm this booking";
    action = () => {
      $("staff-note").focus();
      $("hold-controls").scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    };
  } else if (!creating && ["searching", "offering"].includes(state.phase)) {
    title = active
      ? `Waiting for ${active.name} to reply`
      : "Finding the next client who fits";
    copy =
      "You can carry on with the salon. A decline or missed deadline moves to the next matching client automatically.";
    button = "View current client";
    action = () => {
      if (active) openClient(active.clientId);
    };
  } else if (!creating && state.phase === "booked") {
    title = "This opening is filled.";
    copy =
      "The booking is recorded. Add the next canceled appointment when you are ready.";
    button = "Add another opening";
  } else if (
    !creating &&
    (state.phase === "withdrawn" || state.phase === "unfilled")
  ) {
    title =
      state.phase === "unfilled"
        ? "No booking for this opening yet"
        : "This opening is closed";
    copy =
      "Review the client list and contact history before adding another opening.";
    button = "Add another opening";
  }
  if (!creating && unresolved) {
    title = `${unresolved} client question${unresolved > 1 ? "s" : ""} need${unresolved === 1 ? "s" : ""} a reply`;
    copy =
      "Open the question below. Their offer deadline keeps running while you respond.";
    button = "See client question";
    action = () =>
      $("questions").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  $("desk-next-title").textContent = title;
  $("desk-next-copy").textContent = copy;
  $("desk-next-button").textContent = button;
  $("desk-next-button").onclick = action;
  $("overview-deadline").textContent =
    active?.status === "offered"
      ? `Offer ends at ${time(active.deadline, { second: "2-digit" })}`
      : "No reply needed right now";
  document
    .querySelectorAll(".workflow-guide li")
    .forEach((li, i) =>
      li.classList.toggle(
        "current",
        (i === 0 && (creating || state.phase === "idle")) ||
          (i === 1 && ["searching", "offering"].includes(state.phase)) ||
          (i === 2 && ["held", "booked"].includes(state.phase)),
      ),
    );
}
function openClient(id) {
  selectedClient = id;
  renderProfile();
  if (!$("client-dialog").open) $("client-dialog").showModal();
  $("client-dialog").scrollTop = 0;
}
function renderProfile() {
  const c = state.clients.find((c) => c.id === selectedClient);
  if (!c) return;
  const o = clientOffer(c),
    sent = contactTime(c),
    booked = bookingTime(c);
  const history = state.events.filter((e) => e.text.includes(c.name));
  const row = (label, value) =>
    `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  $("client-profile").innerHTML =
    `<h2 id="profile-name">${esc(c.name)}</h2><p class="profile-status">${esc(contactStatus(c))}</p>
    <div class="contact-box"><div><span class="eyebrow">MOBILE · DEMO NUMBER</span><strong>${esc(c.mobile)}</strong><span>${c.consent ? "Permission to text: yes" : "Do not text: no permission or opted out"}</span></div><button class="secondary" id="copy-number">Copy demo number</button></div><p id="copy-status" class="fine" role="status">No real texts or calls are made by this prototype.</p>
    <dl class="profile-facts">${row("Joined the waitlist", dateTime(c.joinedAt) + ` · position ${c.joined}`)}${row("Service requested", `${c.service} · ${c.minutes} minutes`)}${row("Stylist preference", c.stylist === "Any" ? "Any stylist is fine" : c.stylist + " only")}${row("Available for an earlier visit", dateTime(c.availableFrom) + " to " + time(c.availableUntil))}${row("Appointment before this offer", dateTime(c.existingAppointment) + " · fictional Square entry")}${row("Match for this opening", fitReason(c))}${row("Last offer text", sent ? dateTime(sent) : "No delivered message for this opening")}${row("Booking recorded", booked ? dateTime(booked) : "No new booking recorded")}${o?.status === "booked" ? row("New appointment", dateTime(state.opening.startsAt)) : ""}${o?.status === "held" ? row("Held appointment", dateTime(state.opening.startsAt) + " · needs Square confirmation") : ""}</dl>
    <div class="profile-history"><h3>Contact history for this opening</h3><p class="fine">${state.opening?.mode === "demo" ? "Demo dates and times. " : ""}Earlier conversations outside this app are not imported.</p>${history.length ? `<ol>${history.map((e) => `<li><time>${esc(dateTime(e.at))}</time><span>${esc(e.text)}</span></li>`).join("")}</ol>` : "<p>No contact recorded yet. The app will contact matching clients after you start an opening.</p>"}</div>
    ${o ? '<button id="profile-preview" class="primary">Open this client’s demo conversation</button>' : '<p class="fine">No offer to preview. Start an opening to contact matching clients in order.</p>'}`;
  $("copy-number").onclick = async () => {
    try {
      await navigator.clipboard.writeText(c.mobile);
      $("copy-status").textContent =
        "Demo number copied. This is a fictional contact.";
    } catch {
      $("copy-status").textContent = "Select the number above to copy it.";
    }
  };
  if (o)
    $("profile-preview").onclick = () => {
      selectedOffer = o.id;
      manualSelection = true;
      $("offer-select").value = o.id;
      renderClient();
      $("client-dialog").close();
      $("simulator").open = true;
      $("simulator").scrollIntoView({ behavior: "smooth", block: "start" });
    };
}
document.querySelectorAll(".overview a")[0].onclick = () => {
  $("client-filter").value = "waiting";
  $("client-search").value = "";
  renderWaitlist();
};
document.querySelectorAll(".overview a")[3].onclick = () => {
  $("client-filter").value = "booked";
  $("client-search").value = "";
  renderWaitlist();
};
$("client-search").oninput = renderWaitlist;
$("client-filter").onchange = renderWaitlist;
$("close-client").onclick = () => $("client-dialog").close();

$("mode").onchange();
refresh();
setInterval(refresh, 1500);
setInterval(tick, 250);
