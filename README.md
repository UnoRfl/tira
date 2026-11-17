# Tira (Phase 1 core)

Website for the club's 2 courts. Vite + TypeScript + React, Supabase (Postgres) back end, claymorphism UI.
Plan: `../PLAN.md` · owners' summary: `../OWNERS-BRIEF.md`.

## Run it

```
npm install
npm run dev        # http://localhost:5180
npm test           # 24 database tests on real Postgres (PGlite)
npm run build
```

With no `.env`, the site runs in **demo mode**: the real migration runs inside the browser (PGlite), the
email code is shown on screen, and nothing leaves the device. "Reset" in the yellow bar wipes it.
Desk demo login: `desk@club.test`.

## Live (Supabase)

Supabase project `bloavrswkwhfrotpsswq` (named Courtly in the dashboard) (Singapore, free plan) is set up: migrations 1–3 applied, seed run, cron `court-sweep` every minute, security advisor clean apart from the intended items. `.env` points the site at it (delete `.env` to get demo mode back). Still to do by hand:

1. (Was: create a project.) Later, move it to a club-owned Supabase org (Project settings → Transfer).
2. (Done) Apply `supabase/migrations/*` (the second file schedules `sweep()` with pg_cron), then edit and run `supabase/seed.sql`.
3. Auth → Email template: put `{{ .Token }}` in the body so players get a 6-digit code (no magic links).
4. `.env`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable key is meant to be public).
5. Make the first owner: `update profiles set role = 'owner' where id = (select id from auth.users where email = '…');`
6. Run the security advisor; anon should only be able to execute `club_info`, `availability`, `hold_slot`.

## Artwork

All images are AI-generated from `BRAND-PROMPTS.md` and dropped into `public/brand/` with the exact filenames.

## What's in

- `court_blocks` exclusion constraint over `('held','active')` — holds, bookings and blackouts all compete.
- `hold_slot` (idempotent, lazy expiry, guest limits, never prime for unverified), `attach_contact`,
  `confirm_booking`, `cancel_booking` (cutoff), `move_booking` (release then insert),
  blackout dry run → resolve → apply, walk-ins, check-in/paid, no-show review + strikes, members, CSV import, usage report.
- Tables are RLS-locked with no policies; everything goes through security-definer functions.
- `notifications` is an outbox: rows are written, **nothing sends them yet** (needs an Edge Function + Resend/Semaphore keys).

## Not done yet

- Real parallel race test (50 users × 2 courts) — needs local Supabase/Docker; PGlite is one connection.
- Email/SMS sending, offline queued check-ins on the desk board, Phase 2+ (payments, rules form, waitlist…).
- Privacy notice is a draft; the club must name a privacy contact.
