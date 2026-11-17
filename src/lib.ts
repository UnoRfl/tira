import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, onAuthChange } from './api';

export type Club = {
  id: string; name: string; timezone: string; currency: string;
  price_per_hour_cents: number; slot_minutes: number[]; granularity: number;
  public_window_days: number; member_window_days: number; cancel_cutoff_min: number;
  courts: { id: string; name: string }[];
};
export type Occupied = { start: string; end: string; kind: string; held: boolean; mine: boolean; booking_id: string | null };
export type Availability = {
  closed: boolean; date: string; opens?: string; closes?: string; now: string; prime?: string[];
  courts: { id: string; name: string; occupied: Occupied[] }[];
};
export type Booking = {
  id: string; ref_code: string; status: string; court_id: string; court_name: string;
  start: string; end: string; price_cents: number; currency: string; paid_status: string;
  source: string; hold_expires_at: string | null;
  contact_id?: string; name?: string; email?: string; phone?: string; is_member?: boolean; strikes?: number;
};
export type Me = {
  user_id: string | null; profile: boolean; role?: 'player' | 'staff' | 'owner';
  contact?: { id: string; name: string; email: string; phone: string | null; is_member: boolean; member_until: string | null; strikes: number; needs_consent: boolean };
};

export const TZ = 'Asia/Manila';

export const peso = (cents: number) => '₱' + (cents / 100).toLocaleString('en-PH', { maximumFractionDigits: 0 });

export const fmtTime = (iso: string | Date, tz = TZ) =>
  new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
export const fmtDay = (iso: string | Date, tz = TZ) =>
  new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).format(new Date(iso));
export const fmtDayLong = (iso: string | Date, tz = TZ) =>
  new Intl.DateTimeFormat('en-PH', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz }).format(new Date(iso));

/** YYYY-MM-DD in the club's timezone, `days` from today. */
export function localDate(days = 0, tz = TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(Date.now() + days * 86400e3));
}
/** ISO instant for a local date + HH:MM in Manila (UTC+8, no DST). */
export const manilaISO = (date: string, hm: string) => `${date}T${hm}:00+08:00`;

const ERR: Record<string, string> = {
  slot_taken: 'Just taken. Pick another time.',
  sign_in_required: 'Verify your email first.',
  verify_for_prime: 'Peak time: verify your email first.',
  one_hold_at_a_time: 'Finish your other booking first.',
  slow_down: 'Too many tries. Wait a few minutes.',
  outside_window: 'Not open for booking yet.',
  too_many_active: 'You already have 3 upcoming bookings.',
  daily_limit: 'Max 2 hours per day.',
  banned: 'Booking paused. Please see the desk.',
  members_only: 'Members only at this time.',
  hold_expired: 'Your hold ran out. Try again.',
  past_cutoff: 'Too close to start. Call the desk.',
  closed: 'The club is closed then.',
  in_the_past: 'That time has passed.',
  bad_start: 'Pick a start on the half hour.',
  bad_length: 'Pick 60 or 90 minutes.',
  consent_required: 'Please accept the privacy notice.',
  staff_only: 'Staff only.',
  bad_code: 'Wrong or expired code.',
  send_failed: 'Could not send the code.',
  not_found: 'No booking with that code.',
  not_yours: 'That booking is not yours.',
  cannot_cancel: 'This booking can’t be cancelled.',
  name_required: 'Name needed.',
};
export const errText = (e: any) => ERR[e?.code] ?? (navigator.onLine ? 'Something went wrong. Try again.' : 'You’re offline.');

export const uuid = () => crypto.randomUUID();

/** Re-render when the auth session changes. */
export function useSession() {
  return useSyncExternalStore((cb) => onAuthChange(cb) as () => void, () => api.session(), () => null);
}

/** Generic async loader with loading/error state. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async (quiet = false) => {
    const n = ++seq.current;
    if (!quiet) setLoading(true);
    try { const d = await fn(); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError(e); }
    finally { if (n === seq.current) setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Poll every `ms` while the page is visible; refetch on focus (PLAN §6, Phase 1). */
export function usePoll(f: () => void, ms = 20000) {
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') f(); };
    const id = setInterval(tick, ms);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, [f, ms]);
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export function useHash(): [string, (h: string) => void] {
  const [h, setH] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const f = () => { setH(location.hash.slice(1) || '/'); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return [h, (n) => { location.hash = n; }];
}

export const STATUS_LABEL: Record<string, string> = {
  held: 'On hold', confirmed: 'Booked', checked_in: 'Checked in', completed: 'Played',
  cancelled: 'Cancelled', expired: 'Expired', no_show: 'No-show', needs_review: 'Review',
};

export function downloadCSV(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
