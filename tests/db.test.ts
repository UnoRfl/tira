// Rules + guarantee tests on real Postgres (PGlite), PLAN.md §10.
// Calls run under SET ROLE anon/authenticated, so grants are exercised too.
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const SHIM = read('../src/db/shim.sql');
const INIT = read('../supabase/migrations/20261117000001_init.sql');
const FIX = read('../supabase/migrations/20261117000003_helper_search_path.sql');
const FIX4 = read('../supabase/migrations/20261118000004_review_fixes.sql');
const FIX5 = read('../supabase/migrations/20261118000005_notification_sender.sql');
const FIX7 = read('../supabase/migrations/20261118000007_ip_from_proxy.sql');
const FIX8 = read('../supabase/migrations/20261120000008_guest_ip_mobile_nat.sql');
const SEED = read('../supabase/seed.sql');

const CLUB = '00000000-0000-4000-8000-000000000001';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';

type Who = null | { sub: string; email: string };
let db: PGlite;

async function call<T = any>(who: Who, fn: string, args: Record<string, unknown>, ip = '203.0.113.7'): Promise<T> {
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  await db.exec(`reset role`);
  await db.query(`select set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`, [
    who ? JSON.stringify({ sub: who.sub, email: who.email, role: 'authenticated' }) : '',
    JSON.stringify({ 'x-forwarded-for': ip }),
  ]);
  await db.exec(`set role ${who ? 'authenticated' : 'anon'}`);
  try {
    const res = await db.query<{ r: T }>(sql, names.map((n) => args[n]));
    return res.rows[0].r;
  } finally {
    await db.exec(`reset role`);
  }
}

async function errOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'no error'; } catch (e: any) { return e.code === '23P01' ? '23P01' : e.message; }
}

async function user(email: string, role: 'player' | 'staff' | 'owner' = 'player'): Promise<Who> {
  const sub = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [sub, email]);
  const who = { sub, email };
  await call(who, 'ensure_profile', { p_club: CLUB, p_name: email.split('@')[0], p_consent: true });
  if (role !== 'player') await db.query(`update public.profiles set role = $1 where id = $2`, [role, sub]);
  return who;
}

// Manila dates: d days from today, and the first weekday (Mon–Fri) within 1..3 days.
function manilaDate(d: number) {
  const t = new Date(Date.now() + 8 * 3600e3 + d * 86400e3);
  return t.toISOString().slice(0, 10);
}
function nextWeekday() {
  for (let d = 1; d <= 3; d++) {
    const day = new Date(manilaDate(d) + 'T12:00:00Z').getUTCDay();
    if (day >= 1 && day <= 5) return manilaDate(d);
  }
  throw new Error('no weekday');
}
const at = (date: string, hm: string) => `${date}T${hm}:00+08:00`;
const TOMORROW = nextWeekday(); // a weekday, so morning test slots never land on weekend prime time
const tok = () => 'device-' + randomUUID();

beforeEach(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SHIM);
  await db.exec(INIT);
  await db.exec(FIX);
  await db.exec(FIX4);
  await db.exec(FIX5);
  await db.exec(FIX7);
  await db.exec(FIX8);
  await db.exec(SEED);
});

describe('the one guarantee', () => {
  it('a hold blocks an overlapping hold on the same court (holds compete)', async () => {
    const a = await user('a@x.test'); const b = await user('b@x.test');
    await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(await errOf(call(b, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:30'), p_minutes: 60, p_client_request_id: randomUUID() }))).toBe('23P01');
    // other court is fine
    const ok = await call(b, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '13:30'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(ok.status).toBe('held');
  });

  it('half-open ranges: back-to-back slots do not clash', async () => {
    const a = await user('a@x.test'); const b = await user('b@x.test');
    await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    const r = await call(b, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '14:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(r.status).toBe('held');
  });

  it('a blackout blocks holds, and a hold blocks a blackout until resolved', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test');
    await call(staff, 'apply_blackout', { p_club: CLUB, p_courts: [C1], p_start: at(TOMORROW, '15:00'), p_end: at(TOMORROW, '17:00'), p_reason: 'Resurfacing', p_resolutions: [] });
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '16:00'), p_minutes: 60, p_client_request_id: randomUUID() }))).toBe('23P01');

    const h = await call(a, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '15:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    await call(a, 'confirm_booking', { p_booking: h.id });
    const plan = await call(staff, 'plan_blackout', { p_club: CLUB, p_courts: [C2], p_start: at(TOMORROW, '15:00'), p_end: at(TOMORROW, '16:00') });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].name).toBe('a');
    expect(await errOf(call(staff, 'apply_blackout', { p_club: CLUB, p_courts: [C2], p_start: at(TOMORROW, '15:00'), p_end: at(TOMORROW, '16:00'), p_reason: 'x', p_resolutions: [] }))).toBe('23P01');
    // resolve by moving it to 13:00 → applies, booking survives, player notified
    await call(staff, 'apply_blackout', { p_club: CLUB, p_courts: [C2], p_start: at(TOMORROW, '15:00'), p_end: at(TOMORROW, '16:00'), p_reason: 'x',
      p_resolutions: [{ booking_id: h.id, action: 'move', court_id: C2, start: at(TOMORROW, '13:00') }] });
    const mine = await call(a, 'my_bookings', {});
    expect(mine[0].status).toBe('confirmed');
    expect(new Date(mine[0].start).toISOString()).toBe(new Date(at(TOMORROW, '13:00')).toISOString());
    const n = await db.query(`select kind from public.notifications where kind = 'moved_by_club'`);
    expect(n.rows).toHaveLength(1);
  });

  it('a failed blackout leaves nothing behind (one transaction)', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test');
    const h = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '15:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    await call(a, 'confirm_booking', { p_booking: h.id });
    await errOf(call(staff, 'apply_blackout', { p_club: CLUB, p_courts: [C1, C2], p_start: at(TOMORROW, '14:00'), p_end: at(TOMORROW, '16:00'), p_reason: 'x', p_resolutions: [] }));
    const b = await db.query(`select count(*)::int n from public.blackouts`);
    expect((b.rows[0] as any).n).toBe(0);
  });
});

describe('server functions', () => {
  it('hold_slot is idempotent on client_request_id', async () => {
    const a = await user('a@x.test'); const rid = randomUUID();
    const r1 = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: rid });
    const r2 = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: rid });
    expect(r2.id).toBe(r1.id);
  });

  it('move by 30 min on the same court works (release first, then insert)', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test');
    const h = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 90, p_client_request_id: randomUUID() });
    await call(a, 'confirm_booking', { p_booking: h.id });
    const m = await call(staff, 'move_booking', { p_booking: h.id, p_court: C1, p_start: at(TOMORROW, '13:30') });
    expect(new Date(m.start).toISOString()).toBe(new Date(at(TOMORROW, '13:30')).toISOString());
  });

  it('a failed move keeps the old slot', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test'); const b = await user('b@x.test');
    const h = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    await call(a, 'confirm_booking', { p_booking: h.id });
    await call(b, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(await errOf(call(staff, 'move_booking', { p_booking: h.id, p_court: C2, p_start: at(TOMORROW, '13:00') }))).toBe('23P01');
    const blocks = await db.query(`select status from public.court_blocks where ref_id = $1`, [h.id]);
    expect(blocks.rows).toEqual([{ status: 'active' }]);
  });

  it('expired holds are released lazily so the slot can be taken', async () => {
    const a = await user('a@x.test'); const b = await user('b@x.test');
    const h = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    await db.query(`update public.court_blocks set hold_expires_at = now() - interval '1 second' where ref_id = $1`, [h.id]);
    const r = await call(b, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(r.status).toBe('held');
    expect(await errOf(call(a, 'confirm_booking', { p_booking: h.id }))).toBe('hold_expired');
  });

  it('price: ₱500 per court-hour, locked at hold time', async () => {
    const a = await user('a@x.test');
    const r = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 90, p_client_request_id: randomUUID() });
    expect(r.price_cents).toBe(75000);
  });

  it('rejects bad starts, lengths, closed hours and past slots', async () => {
    const a = await user('a@x.test'); const rid = () => randomUUID();
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:15'), p_minutes: 60, p_client_request_id: rid() }))).toBe('bad_start');
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 45, p_client_request_id: rid() }))).toBe('bad_length');
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '20:30'), p_minutes: 60, p_client_request_id: rid() }))).toBe('closed');
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '06:00'), p_minutes: 60, p_client_request_id: rid() }))).toBe('closed');
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(manilaDate(-1), '13:00'), p_minutes: 60, p_client_request_id: rid() }))).toBe('in_the_past');
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(manilaDate(5), '13:00'), p_minutes: 60, p_client_request_id: rid() }))).toBe('outside_window');
  });

  it('members book further ahead (rolling window 7 vs 3 days)', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test');
    const me = await call(a, 'me', {});
    await call(staff, 'set_member', { p_contact: me.contact.id, p_until: manilaDate(60) });
    const r = await call(a, 'hold_slot', { p_court: C1, p_start: at(manilaDate(5), '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(r.status).toBe('held');
  });

  it('caps: max 3 active and 120 minutes per day', async () => {
    const a = await user('a@x.test');
    const h = async (court: string, t: string, m = 60, d = TOMORROW) => {
      const x = await call(a, 'hold_slot', { p_court: court, p_start: at(d, t), p_minutes: m, p_client_request_id: randomUUID() });
      return call(a, 'confirm_booking', { p_booking: x.id });
    };
    await h(C1, '08:00'); await h(C1, '09:00');
    expect(await errOf(h(C1, '10:00'))).toBe('daily_limit');
    await h(C1, '13:00', 60, manilaDate(2));
    expect(await errOf(h(C1, '14:00', 60, manilaDate(2)))).toBe('too_many_active');
  });

  it('cancel cutoff applies to players, not staff', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test');
    const today = manilaDate(0);
    // insert a confirmed booking starting in 1 hour (bypassing the window rules)
    const s = new Date(Math.ceil((Date.now() + 3600e3) / 1800e3) * 1800e3).toISOString();
    const me = await call(a, 'me', {});
    const b = await db.query<{ id: string }>(`insert into public.bookings (ref_code, club_id, contact_id, court_id, slot, status, price_cents, currency, client_request_id)
      values ('CUT001', $1, $2, $3, tstzrange($4::timestamptz, $4::timestamptz + interval '1 hour'), 'confirmed', 50000, 'PHP', gen_random_uuid()) returning id`, [CLUB, me.contact.id, C1, s]);
    const id = b.rows[0].id; void today;
    expect(await errOf(call(a, 'cancel_booking', { p_booking: id }))).toBe('past_cutoff');
    expect((await call(staff, 'cancel_booking', { p_booking: id })).status).toBe('cancelled');
  });

  it('no-shows: needs_review → staff confirm → strike → banned at 3', async () => {
    const staff = await user('desk@x.test', 'staff'); const a = await user('a@x.test');
    const me = await call(a, 'me', {});
    for (let i = 0; i < 3; i++) {
      const b = await db.query<{ id: string }>(`insert into public.bookings (ref_code, club_id, contact_id, court_id, slot, status, price_cents, currency, client_request_id)
        values ($5, $1, $2, $3, tstzrange(now() - interval '2 days' - make_interval(hours => $4), now() - interval '2 days' - make_interval(hours => $4) + interval '1 hour'), 'confirmed', 50000, 'PHP', gen_random_uuid()) returning id`,
        [CLUB, me.contact.id, C1, i * 2, 'NS000' + i]);
      await call(staff, 'desk_day', { p_club: CLUB, p_date: manilaDate(0) }); // sweeps
      const st = await db.query(`select status from public.bookings where id = $1`, [b.rows[0].id]);
      expect(st.rows[0]).toEqual({ status: 'needs_review' });
      await call(staff, 'review_booking', { p_booking: b.rows[0].id, p_no_show: true });
    }
    expect((await call(a, 'me', {})).contact.strikes).toBe(3);
    expect(await errOf(call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() }))).toBe('banned');
  });

  it('desk booking for later is confirmed with the name on it (checked in only if it starts now)', async () => {
    const staff = await user('desk@x.test', 'staff');
    const r = await call(staff, 'walk_in', { p_court: C2, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_name: 'Walk In', p_phone: '0917', p_email: '', p_client_request_id: randomUUID() });
    expect(r.status).toBe('confirmed');
    expect(r.name).toBe('Walk In');
  });
});

describe('unverified guests (§5 fix 1.3)', () => {
  it('can hold a non-prime slot, 1 open hold per device (new pick replaces it), 2 per IP, 3-minute TTL', async () => {
    const t = tok();
    const r = await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: t });
    const ttl = (new Date(r.hold_expires_at).getTime() - Date.now()) / 60e3;
    expect(ttl).toBeGreaterThan(2.5); expect(ttl).toBeLessThanOrEqual(3.01);
    const r2 = await call(null, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: t }, '198.51.100.1');
    expect(r2.status).toBe('held');
    const old = await db.query(`select status from public.bookings where id = $1`, [r.id]);
    expect((old.rows[0] as any).status).toBe('cancelled');
    // a second phone on the same IP may hold (shared mobile IP); a third may not
    expect((await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '14:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }, '198.51.100.1')).status).toBe('held');
    expect(await errOf(call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '15:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }, '198.51.100.1'))).toBe('one_hold_at_a_time');
  });

  it('never holds prime slots', async () => {
    const wd = nextWeekday();
    expect(await errOf(call(null, 'hold_slot', { p_court: C1, p_start: at(wd, '18:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }))).toBe('verify_for_prime');
  });

  it('8 guest holds per IP per 10 minutes', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await call(null, 'hold_slot', { p_court: i < 4 ? C1 : C2, p_start: at(TOMORROW, `1${i % 4}:00`), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() });
      await db.query(`update public.court_blocks set hold_expires_at = now() - interval '1 s' where ref_id = $1`, [r.id]);
    }
    expect(await errOf(call(null, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '15:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }))).toBe('slow_down');
  });

  it('a faked X-Forwarded-For prefix does not dodge the IP limits (proxy appends the real ip last)', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await call(null, 'hold_slot', { p_court: i < 4 ? C1 : C2, p_start: at(TOMORROW, `1${i % 4}:00`), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }, `10.0.0.${i}, 203.0.113.7`);
      await db.query(`update public.court_blocks set hold_expires_at = now() - interval '1 s' where ref_id = $1`, [r.id]);
    }
    expect(await errOf(call(null, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '15:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }, '6.6.6.6, 203.0.113.7'))).toBe('slow_down');
  });

  it('attach after verification runs the rules and extends the hold', async () => {
    const t = tok();
    const h = await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: t });
    const a = await user('a@x.test');
    expect(await errOf(call(a, 'attach_contact', { p_booking: h.id, p_device_token: tok() }))).toBe('not_yours');
    const r = await call(a, 'attach_contact', { p_booking: h.id, p_device_token: t });
    expect((new Date(r.hold_expires_at).getTime() - Date.now()) / 60e3).toBeGreaterThan(4.5);
    expect((await call(a, 'confirm_booking', { p_booking: h.id })).status).toBe('confirmed');
  });

  it('attach that fails the rules releases the hold', async () => {
    const a = await user('a@x.test');
    for (const t0 of ['08:00', '09:00']) {
      const x = await call(a, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, t0), p_minutes: 60, p_client_request_id: randomUUID() });
      await call(a, 'confirm_booking', { p_booking: x.id });
    }
    const t = tok();
    const h = await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: t });
    const r = await call(a, 'attach_contact', { p_booking: h.id, p_device_token: t });
    expect(r.error).toBe('daily_limit');
    const av = await call(null, 'availability', { p_club: CLUB, p_date: TOMORROW });
    expect(av.courts[0].occupied).toHaveLength(0);
  });
});

describe('grants and privacy (§10)', () => {
  it('anon can read availability but never names', async () => {
    const a = await user('secret-name@x.test');
    await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '13:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    const av = await call(null, 'availability', { p_club: CLUB, p_date: TOMORROW });
    expect(av.courts[0].occupied).toHaveLength(1);
    expect(JSON.stringify(av)).not.toContain('secret');
  });

  it('anon cannot call writes beyond hold_slot, internal helpers, or read tables', async () => {
    expect(await errOf(call(null, 'confirm_booking', { p_booking: randomUUID() }))).toMatch(/permission denied/);
    expect(await errOf(call(null, 'sweep', {}))).toMatch(/permission denied/);
    expect(await errOf(call(null, '_cfg', { p_club: CLUB }))).toMatch(/permission denied/);
    await db.exec('set role anon');
    expect(await errOf(db.query('select * from public.contacts'))).toMatch(/permission denied/);
    await db.exec('reset role');
  });

  it('players cannot use desk functions', async () => {
    const a = await user('a@x.test');
    expect(await errOf(call(a, 'desk_day', { p_club: CLUB, p_date: TOMORROW }))).toBe('staff_only');
    expect(await errOf(call(a, 'set_member', { p_contact: randomUUID(), p_until: manilaDate(30) }))).toBe('staff_only');
  });

  it('first sign-in needs privacy consent', async () => {
    const sub = randomUUID();
    await db.query(`insert into auth.users (id, email) values ($1, 'new@x.test')`, [sub]);
    expect(await errOf(call({ sub, email: 'new@x.test' }, 'ensure_profile', { p_club: CLUB, p_name: 'New' }))).toBe('consent_required');
  });
});

describe('review fixes (2026-11-18)', () => {
  it('window counts whole calendar days: the last public day is bookable all day, the next is not', async () => {
    const a = await user('a@x.test');
    const r = await call(a, 'hold_slot', { p_court: C1, p_start: at(manilaDate(3), '20:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(r.status).toBe('held');
    expect(await errOf(call(a, 'hold_slot', { p_court: C2, p_start: at(manilaDate(4), '12:00'), p_minutes: 60, p_client_request_id: randomUUID() }))).toBe('outside_window');
    expect(await errOf(call(null, 'hold_slot', { p_court: C2, p_start: at(manilaDate(4), '12:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }))).toBe('outside_window');
  });

  it('a guest can release their own hold, and a new pick replaces the old hold', async () => {
    const t = tok();
    const h1 = await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: t });
    const h2 = await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '12:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: t });
    expect(h2.status).toBe('held');
    const s1 = await db.query(`select status from public.bookings where id = $1`, [h1.id]);
    expect((s1.rows[0] as any).status).toBe('cancelled');
    // someone else cannot release it; the owner can, and the slot is free again
    expect(await errOf(call(null, 'release_hold', { p_booking: h2.id, p_device_token: tok() }))).toBe('not_yours');
    await call(null, 'release_hold', { p_booking: h2.id, p_device_token: t });
    const b = await user('b@x.test');
    const r = await call(b, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '12:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(r.status).toBe('held');
  });

  it('two phones on one shared mobile IP can both hold; a third waits', async () => {
    await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() });
    const b = await call(null, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() });
    expect(b.status).toBe('held');
    expect(await errOf(call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '12:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() }))).toBe('one_hold_at_a_time');
  });

  it('staff can void a walk-in; a later desk booking is confirmed, not checked in', async () => {
    const s = await user('s@x.test', 'staff');
    const w = await call(s, 'walk_in', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_name: 'Typo', p_phone: '', p_email: '', p_client_request_id: randomUUID() });
    expect(w.status).toBe('confirmed');
    await call(s, 'check_in', { p_booking: w.id, p_paid: false });
    const c = await call(s, 'cancel_booking', { p_booking: w.id });
    expect(c.status).toBe('cancelled');
    const a = await user('a@x.test');
    const r = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(r.status).toBe('held');
  });

  it('players still cannot cancel a checked-in booking; no profile = cannot cancel guest holds', async () => {
    const h = await call(null, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID(), p_device_token: tok() });
    const sub = randomUUID(); await db.query(`insert into auth.users (id, email) values ($1, 'np@x.test')`, [sub]);
    expect(await errOf(call({ sub, email: 'np@x.test' }, 'cancel_booking', { p_booking: h.id }))).toBe('not_yours');
  });

  it('desk actions on an unknown id say not_found', async () => {
    const s = await user('s@x.test', 'staff');
    expect(await errOf(call(s, 'check_in', { p_booking: randomUUID(), p_paid: true }))).toBe('not_found');
    expect(await errOf(call(s, 'review_booking', { p_booking: randomUUID(), p_no_show: true }))).toBe('not_found');
  });
});

describe('fallbacks: refresh / back mid-booking', () => {
  it('a player who left a hold behind can start a new one; the old one is dropped', async () => {
    const a = await user('a@x.test');
    const h1 = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    const h2 = await call(a, 'hold_slot', { p_court: C2, p_start: at(TOMORROW, '12:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    expect(h2.status).toBe('held');
    const s = await db.query(`select status from public.bookings where id = $1`, [h1.id]);
    expect((s.rows[0] as any).status).toBe('cancelled');
    // confirmed bookings are never touched by a new hold
    await call(a, 'confirm_booking', { p_booking: h2.id });
    await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '14:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    const mine = await call(a, 'my_bookings', {});
    expect(mine.find((b: any) => b.id === h2.id).status).toBe('confirmed');
  });

  it('retrying the same request (double tap / network retry) returns the same hold, not a second one', async () => {
    const a = await user('a@x.test'); const rid = randomUUID();
    const x = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: rid });
    const y = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: rid });
    expect(y.id).toBe(x.id);
    await call(a, 'confirm_booking', { p_booking: x.id });
    const z = await call(a, 'confirm_booking', { p_booking: x.id });
    expect(z.status).toBe('confirmed');
  });
});

describe('email outbox sender', () => {
  const key = async () => ((await db.query(`select value from private.settings where key = 'notify_key'`)).rows[0] as any).value as string;
  async function confirmed(email: string) {
    const a = await user(email);
    const h = await call(a, 'hold_slot', { p_court: C1, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_client_request_id: randomUUID() });
    await call(a, 'confirm_booking', { p_booking: h.id });
    return { a, h };
  }

  it('refuses a wrong or missing key, even for anon', async () => {
    await confirmed('a@x.test');
    expect(await errOf(call(null, 'claim_notifications', { p_key: 'nope', p_limit: 10 }))).toBe('bad_key');
    expect(await errOf(call(null, 'claim_notifications', { p_key: null, p_limit: 10 }))).toBe('bad_key');
    expect(await errOf(call(null, 'finish_notification', { p_key: 'nope', p_id: 1, p_error: null }))).toBe('bad_key');
    const a = await user('b@x.test');
    expect(await errOf(call(a, 'claim_notifications', { p_key: 'nope', p_limit: 10 }))).toBe('bad_key');
  });

  it('claims each email once, marks it sent, and retries a failure', async () => {
    const { h } = await confirmed('a@x.test');
    const k = await key();
    const first = await call(null, 'claim_notifications', { p_key: k, p_limit: 10 });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'booking_confirmed', email: 'a@x.test', club: 'Tira' });
    expect(first[0].payload.ref_code).toBe(h.ref_code);
    // a second sender running at the same time gets nothing
    expect(await call(null, 'claim_notifications', { p_key: k, p_limit: 10 })).toHaveLength(0);
    // failure → offered again
    await call(null, 'finish_notification', { p_key: k, p_id: first[0].id, p_error: 'smtp down' });
    const again = await call(null, 'claim_notifications', { p_key: k, p_limit: 10 });
    expect(again.map((x: any) => x.id)).toEqual([first[0].id]);
    await call(null, 'finish_notification', { p_key: k, p_id: first[0].id, p_error: null });
    expect(await call(null, 'claim_notifications', { p_key: k, p_limit: 10 })).toHaveLength(0);
    const row = (await db.query(`select sent_at is not null as sent, attempts, last_error from public.notifications`)).rows[0] as any;
    expect(row).toMatchObject({ sent: true, attempts: 2, last_error: null });
  });

  it('cancel and club moves queue their own emails; walk-ins without email are closed, not sent', async () => {
    const { a, h } = await confirmed('a@x.test');
    await call(a, 'cancel_booking', { p_booking: h.id });
    const s = await user('s@x.test', 'staff');
    await call(s, 'walk_in', { p_court: C2, p_start: at(TOMORROW, '10:00'), p_minutes: 60, p_name: 'No Mail', p_phone: '', p_email: '', p_client_request_id: randomUUID() });
    await db.query(`insert into public.notifications (club_id, contact_id, kind) select club_id, id, 'cancelled_by_club' from public.contacts where name = 'No Mail'`);
    const got = await call(null, 'claim_notifications', { p_key: await key(), p_limit: 10 });
    expect(got.map((x: any) => x.kind)).toEqual(['booking_confirmed', 'cancelled']);
    const closed = (await db.query(`select last_error from public.notifications where last_error = 'no_email'`)).rows;
    expect(closed).toHaveLength(1);
  });
});
