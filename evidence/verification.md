# Verification record

Verified locally on October 4, 2026. These checks do not establish assessment-grader acceptance or real salon outcomes.

- Clean temporary checkout of our own public repository; locked dependencies installed with `npm ci`; one-command `./run.sh` launched the app using the existing local Temporal volume.
- `npm run typecheck`: passed.
- `npm test`: 10 tests passed, zero failed. Temporal time-skipping tests covered customer rules and state transitions.
- `node scripts/verify-api.mjs`: five JSON error-path checks passed (404, malformed JSON, invalid opening, invalid response, oversized payload).
- `node scripts/verify-recovery.mjs`: passed. A separately spawned Worker was forcibly terminated and restarted; offer ID and deadline were unchanged, exactly one offer remained, and acceptance created a hold. Raw result: `worker-recovery.json`.
- Chrome: started outreach, asked a question, accepted a hold, rejected booking confirmation without a staff note/check, marked the question handled, recorded a simulated Square booking, and restored the booked state after a page reload.
- Responsive layout: visually checked at 487 CSS pixels wide with no horizontal page overflow; saved `prototype-mobile.jpg`.
- Restarted the local Temporal container while preserving its named volume; the API recovered and the booked state remained available.
- `prototype-hold.jpg`: actual staff and simulated-client view before booking confirmation.
- `temporal-workflow.jpg`: actual `salonDesk` execution history, showing its workflow identity and event history. The long-running desk remains open for later openings.
- `starter-complete.jpg`: neutral starter completed before prototype development.

All waitlist clients are fictional. The June 10, 2030 clock and 20-second offers are accelerated demo inputs. Live SMS, live Square writes, production security, and real business improvement were not tested.

- Presentation: PDF has exactly four 16:9 pages. Every rendered page was visually inspected; required problem, behavior, simulation boundaries, and next step are present.
