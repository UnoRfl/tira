import { useCallback, useState } from 'react';
import { api } from '../api';
import { Empty, ErrorBox, Loading, Sheet, Spinner } from '../components/Sheet';
import { useApp } from '../ctx';
import {
  STATUS_LABEL, downloadCSV, errText, fmtDay, fmtTime, localDate, manilaISO, peso, useLoad, usePoll, uuid, type Booking,
} from '../lib';

type Day = { bookings: Booking[]; blackouts: { court_id: string; start: string; end: string; reason: string; id: string }[]; needs_review: Booking[] };
type Tab = 'board' | 'review' | 'members' | 'block' | 'report';
const TABS: Record<Tab, string> = { board: 'Today', review: 'Review', members: 'Members', block: 'Block courts', report: 'Report' };

export function Desk() {
  const { me, club } = useApp();
  const [tab, setTab] = useState<Tab>('board');
  const [date, setDate] = useState(localDate(0, club.timezone));
  const isStaff = me?.role === 'staff' || me?.role === 'owner';
  const day = useLoad(() => (isStaff ? api.rpc<Day>('desk_day', { p_club: club.id, p_date: date }) : Promise.resolve(null as unknown as Day)), [date, club.id, isStaff]);
  const quiet = useCallback(() => { if (isStaff) day.reload(true); }, [day.reload, isStaff]);
  usePoll(quiet, 20000);

  if (!isStaff) {
    return <section className="wrap section"><div className="card"><Empty title="Staff only">Sign in with a desk account.</Empty></div></section>;
  }

  const review = day.data?.needs_review.length ?? 0;
  return (
    <section className="wrap section stack" style={{ gap: 22 }}>
      <div className="spread" style={{ alignItems: 'end' }}>
        <div><span className="eyebrow">Front desk</span><h2 style={{ marginTop: 10 }}>{club.name}</h2></div>
        <div className="tabs" role="tablist">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} role="tab" aria-pressed={tab === t} onClick={() => setTab(t)}>
              {TABS[t]}{t === 'review' && review > 0 && <span className="count">{review}</span>}
            </button>
          ))}
        </div>
      </div>
      {tab === 'board' && <Board date={date} setDate={setDate} day={day} />}
      {tab === 'review' && <Review day={day} />}
      {tab === 'members' && <Members />}
      {tab === 'block' && <Block onDone={() => day.reload(true)} />}
      {tab === 'report' && <Report />}
    </section>
  );
}

function Board({ date, setDate, day }: { date: string; setDate: (d: string) => void; day: ReturnType<typeof useLoad<Day>> }) {
  const { club, toast } = useApp();
  const [ref, setRef] = useState('');
  const [found, setFound] = useState<Booking | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();

  async function act(b: Booking, fn: string, args: Record<string, unknown>, msg: string) {
    setBusy(b.id);
    try { const r = await api.rpc<Booking>(fn, args); toast(msg); day.reload(true); if (found?.id === b.id) setFound(r); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(null); }
  }

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (!ref.trim()) return;
    try { setFound(await api.rpc<Booking>('desk_lookup', { p_club: club.id, p_ref: ref })); }
    catch (er) { setFound(null); toast(errText(er), 'err'); }
  }

  const list = day.data?.bookings ?? [];
  const occ = list.reduce((s, b) => s + (new Date(b.end).getTime() - new Date(b.start).getTime()) / 60e3, 0);
  const openMin = 14 * 60 * club.courts.length;
  const unpaid = list.filter((b) => b.paid_status === 'unpaid' && b.status !== 'needs_review').length;

  const Actions = ({ b }: { b: Booking }) => {
    const e = new Date(b.end).getTime();
    return (
      <div className="row" style={{ gap: 6 }}>
        {b.status === 'confirmed' && <>
          <button className="btn sm accent" disabled={busy === b.id} onClick={() => act(b, 'check_in', { p_booking: b.id, p_paid: true }, 'Checked in and paid')}>Check in + paid</button>
          <button className="btn sm" disabled={busy === b.id} onClick={() => act(b, 'check_in', { p_booking: b.id, p_paid: false }, 'Checked in')}>Check in</button>
        </>}
        {b.status === 'checked_in' && b.paid_status === 'unpaid' && (
          <button className="btn sm accent" disabled={busy === b.id} onClick={() => act(b, 'check_in', { p_booking: b.id, p_paid: true }, 'Marked paid')}>Mark paid</button>
        )}
        {b.status === 'confirmed' && e > now && (
          <button className="btn sm ghost" style={{ color: 'var(--rose-deep)' }} disabled={busy === b.id}
            onClick={() => confirm(`Cancel ${b.name}'s booking? They'll be notified.`) && act(b, 'cancel_booking', { p_booking: b.id }, 'Cancelled')}>Cancel</button>
        )}
      </div>
    );
  };

  const Row = ({ b }: { b: Booking }) => {
    const s = new Date(b.start).getTime(), e = new Date(b.end).getTime();
    return (
      <div className={`slotrow ${s <= now && now < e ? 'live' : ''}`}>
        <div className="t">{fmtTime(b.start).replace(' ', ' ')}<small>{(e - s) / 60e3} min</small></div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="spread" style={{ gap: 8 }}>
            <span className="who">{b.name || 'Guest'} {b.is_member && <span className="tag peri">M</span>} {!!b.strikes && <span className="tag rose">{b.strikes}×</span>}</span>
            <span className={`status ${b.status}`}>{STATUS_LABEL[b.status]}</span>
          </div>
          <div className="meta"><b>{b.ref_code}</b> · {peso(b.price_cents)} {b.paid_status === 'unpaid' ? 'to collect' : 'paid'}{b.source === 'desk' ? ' · walk-in' : ''}</div>
          <Actions b={b} />
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="kpis">
        <div className="kpi" style={{ ['--k' as any]: 'var(--sage-deep)' }}><b>{list.length}</b><span>bookings</span></div>
        <div className="kpi" style={{ ['--k' as any]: 'var(--peri-deep)' }}><b>{Math.round((occ / openMin) * 100)}%</b><span>courts used</span></div>
        <div className="kpi" style={{ ['--k' as any]: 'var(--honey-deep)' }}><b>{unpaid}</b><span>to collect</span></div>
        <div className="kpi" style={{ ['--k' as any]: 'var(--peach-deep)' }}><b>{day.data?.needs_review.length ?? 0}</b><span>to review</span></div>
      </div>

      <div className="toolbar">
        <div className="datenav">
          <button className="btn icon" onClick={() => setDate(shift(date, -1))} aria-label="Previous day">‹</button>
          <b>{fmtDay(date + 'T12:00:00+08:00')}</b>
          <button className="btn icon" onClick={() => setDate(shift(date, 1))} aria-label="Next day">›</button>
          {date !== localDate(0) && <button className="btn sm ghost" onClick={() => setDate(localDate(0))}>Today</button>}
        </div>
        <div className="row">
          <form onSubmit={lookup} className="search">
            <input className="input" placeholder="Code" aria-label="Booking code" value={ref} onChange={(e) => setRef(e.target.value)} />
            <button className="btn sm" style={{ height: 42 }}>Find</button>
          </form>
          <button className="btn primary" style={{ height: 42 }} onClick={() => setWalkIn(true)}>+ Walk-in</button>
        </div>
      </div>

      {found && (
        <div className="card stack" style={{ boxShadow: 'var(--clay), 0 0 0 2.5px var(--ink)' }}>
          <div className="spread"><h3>{found.name} <span className="faint num" style={{ letterSpacing: '.12em', marginLeft: 6 }}>{found.ref_code}</span></h3>
            <button className="btn icon" onClick={() => setFound(null)} aria-label="Close">✕</button></div>
          <div className="row small muted" style={{ gap: 16 }}>
            <span>{found.court_name}</span><span>{fmtDay(found.start)} · {fmtTime(found.start)}–{fmtTime(found.end)}</span>
            <span className={`status ${found.status}`}>{STATUS_LABEL[found.status]}</span><span>{found.phone || found.email}</span>
          </div>
          <Actions b={found} />
        </div>
      )}

      {day.error ? <ErrorBox text={errText(day.error)} onRetry={() => day.reload()} />
        : day.loading && !day.data ? <Loading />
        : (
          <div className="desk-grid">
            {club.courts.map((c, i) => {
              const rows = list.filter((b) => b.court_id === c.id).map((b) => ({ t: b.start, b }));
              const blocks = day.data!.blackouts.filter((x) => x.court_id === c.id).map((x) => ({ t: x.start, x }));
              const items = [...rows, ...blocks].sort((a, b) => a.t.localeCompare(b.t));
              return (
                <div key={c.id} className="lane">
                  <div className={`court-head c${i % 2}`}><i />{c.name}<small>{rows.length} booked</small></div>
                  {items.length ? items.map((it) => 'b' in it ? <Row key={it.b.id} b={it.b} /> : (
                    <div key={it.x.id + it.x.start} className="slotrow block">
                      <div className="t">{fmtTime(it.x.start)}<small>to {fmtTime(it.x.end)}</small></div>
                      <div className="spread"><span className="who">{it.x.reason}</span>
                        <button className="btn sm" onClick={async () => { await api.rpc('remove_blackout', { p_blackout: it.x.id }); toast('Court reopened'); day.reload(true); }}>Reopen</button>
                      </div>
                    </div>
                  )) : <div className="inset center small muted" style={{ padding: 28 }}>No bookings</div>}
                </div>
              );
            })}
          </div>
        )}

      {walkIn && <WalkIn date={date} onClose={() => setWalkIn(false)} onDone={() => { setWalkIn(false); day.reload(true); }} />}
    </>
  );
}

const shift = (d: string, n: number) => {
  const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};
const halfHours = (from = 7, to = 21) => {
  const out: string[] = [];
  for (let h = from; h < to; h++) for (const m of ['00', '30']) out.push(`${String(h).padStart(2, '0')}:${m}`);
  return out;
};
const hmLabel = (hm: string) => fmtTime(manilaISO('2026-01-01', hm));
const floorHalf = (hm: string) => { const [h, m] = hm.split(':').map(Number); return `${String(h).padStart(2, '0')}:${m < 30 ? '00' : '30'}`; };

function WalkIn({ date, onClose, onDone }: { date: string; onClose: () => void; onDone: () => void }) {
  const { club, toast } = useApp();
  const nowHm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: club.timezone }).format(new Date());
  const opts = halfHours().filter((h) => date !== localDate(0) || h >= floorHalf(nowHm));
  const [court, setCourt] = useState(club.courts[0].id);
  const [start, setStart] = useState(opts[0] ?? '07:00');
  const [minutes, setMinutes] = useState(60);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rid] = useState(uuid);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const b = await api.rpc<Booking>('walk_in', { p_court: court, p_start: manilaISO(date, start), p_minutes: minutes, p_name: name, p_phone: phone, p_email: '', p_client_request_id: rid });
      toast(`Walk-in booked · ${b.ref_code}`); onDone();
    } catch (er) { setErr(errText(er)); setBusy(false); }
  }

  return (
    <Sheet onClose={onClose} title="Walk-in">
      <form className="stack" style={{ gap: 16 }} onSubmit={save}>
        <div className="options" role="radiogroup" aria-label="Court">
          {club.courts.map((c) => <button type="button" role="radio" key={c.id} className="option" aria-checked={court === c.id} onClick={() => setCourt(c.id)}><b>{c.name}</b></button>)}
        </div>
        <div className="row" style={{ gap: 12 }}>
          <label className="field grow"><span>Start</span>
            <select className="input" value={start} onChange={(e) => setStart(e.target.value)}>{opts.map((h) => <option key={h} value={h}>{hmLabel(h)}</option>)}</select>
          </label>
          <label className="field grow"><span>Length</span>
            <select className="input" value={minutes} onChange={(e) => setMinutes(+e.target.value)}>{club.slot_minutes.map((m) => <option key={m} value={m}>{m} min</option>)}</select>
          </label>
        </div>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label className="field"><span>Phone</span><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        {err && <div className="note err">{err}</div>}
        <button className="btn primary lg block" disabled={busy || !name.trim()}>{busy ? <Spinner /> : `Book and check in · ${peso((club.price_per_hour_cents * minutes) / 60)}`}</button>
      </form>
    </Sheet>
  );
}

function Review({ day }: { day: ReturnType<typeof useLoad<Day>> }) {
  const { toast } = useApp();
  const list = day.data?.needs_review ?? [];
  async function decide(b: Booking, noShow: boolean) {
    try { await api.rpc('review_booking', { p_booking: b.id, p_no_show: noShow }); toast(noShow ? 'No-show recorded' : 'Marked as played'); day.reload(true); }
    catch (e) { toast(errText(e), 'err'); }
  }
  if (!list.length) return <div className="card"><Empty title="All clear">No one to review.</Empty></div>;
  return (
    <div className="list">
      {list.map((b) => (
        <div key={b.id} className="person">
          <div className="avatar">{initials(b.name)}</div>
          <div><div className="who" style={{ fontFamily: 'var(--display)', fontWeight: 750 }}>{b.name}</div>
            <div className="small muted">{b.court_name} · {fmtDay(b.start)} {fmtTime(b.start)} · {b.strikes ?? 0} strikes</div></div>
          <div className="row actions">
            <button className="btn sm" onClick={() => decide(b, false)}>They came</button>
            <button className="btn sm danger" onClick={() => decide(b, true)}>No-show</button>
          </div>
        </div>
      ))}
    </div>
  );
}
const initials = (n?: string) => (n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

type Contact = { id: string; name: string; email: string | null; phone: string | null; is_member: boolean; member_until: string | null; strikes: number; verified: boolean };

function Members() {
  const { club, toast } = useApp();
  const [q, setQ] = useState('');
  const res = useLoad(() => api.rpc<Contact[]>('search_contacts', { p_club: club.id, p_q: q }), [q]);
  const [edit, setEdit] = useState<Contact | null>(null);
  const [until, setUntil] = useState('');
  const [csv, setCsv] = useState(false);

  async function save(c: Contact, d: string | null) {
    try { await api.rpc('set_member', { p_contact: c.id, p_until: d, p_ref: null }); toast(d ? 'Membership saved' : 'Membership removed'); setEdit(null); res.reload(true); }
    catch (e) { toast(errText(e), 'err'); }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row">
        <input className="input grow" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <button className="btn" onClick={() => setCsv(true)}>Import CSV</button>
      </div>
      {res.error ? <ErrorBox text={errText(res.error)} /> : res.loading && !res.data ? <Loading /> : !res.data?.length ? <div className="card"><Empty title="No one found" /></div> : (
        <div className="list">
          {res.data.map((c) => (
            <div key={c.id} className="person">
              <div className={`avatar ${c.is_member ? 'm' : ''}`}>{initials(c.name)}</div>
              <div>
                <div className="row" style={{ gap: 8 }}><span style={{ fontFamily: 'var(--display)', fontWeight: 750 }}>{c.name || '—'}</span>
                  {c.is_member && <span className="tag peri">Member{c.member_until ? ` → ${c.member_until}` : ''}</span>}
                  {c.strikes > 0 && <span className="tag rose">{c.strikes} strikes</span>}
                </div>
                <div className="small muted">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="row actions">
                {edit?.id === c.id ? (
                  <>
                    <input type="date" className="input" style={{ height: 40, width: 160 }} value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Member until" />
                    <button className="btn sm primary" disabled={!until} onClick={() => save(c, until)}>Save</button>
                    {c.is_member && <button className="btn sm danger" onClick={() => save(c, null)}>Remove</button>}
                  </>
                ) : (
                  <button className="btn sm" onClick={() => { setEdit(c); setUntil(c.member_until ?? shift(localDate(0), 365)); }}>{c.is_member ? 'Edit' : 'Make member'}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {csv && <ImportCsv onClose={() => setCsv(false)} onDone={() => { setCsv(false); res.reload(true); }} />}
    </div>
  );
}

function ImportCsv({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { club, toast } = useApp();
  const [text, setText] = useState('name,email,phone,member_until\n');
  const [busy, setBusy] = useState(false);
  const rows = parseCsv(text);
  async function go() {
    setBusy(true);
    try { const r = await api.rpc<{ created: number; updated: number }>('import_contacts', { p_club: club.id, p_rows: rows }); toast(`${r.created} added · ${r.updated} updated`); onDone(); }
    catch (e) { toast(errText(e), 'err'); setBusy(false); }
  }
  return (
    <Sheet onClose={onClose} title="Import people">
      <div className="stack">
        <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <textarea className="input small" style={{ fontFamily: 'ui-monospace, monospace' }} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="small muted">{rows.length} rows ready</div>
        <button className="btn primary lg block" disabled={busy || !rows.length} onClick={go}>{busy ? <Spinner /> : 'Import'}</button>
      </div>
    </Sheet>
  );
}
function parseCsv(t: string): Record<string, string>[] {
  const lines = t.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (l: string) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => { const c = split(l); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); }).filter((r) => r.name || r.email);
}

function Block({ onDone }: { onDone: () => void }) {
  const { club, toast } = useApp();
  const [courts, setCourts] = useState<string[]>(club.courts.map((c) => c.id));
  const [date, setDate] = useState(localDate(1));
  const [from, setFrom] = useState('07:00');
  const [to, setTo] = useState('09:00');
  const [reason, setReason] = useState('');
  const [plan, setPlan] = useState<{ conflicts: (Booking & { kind: string })[] } | null>(null);
  const [res, setRes] = useState<Record<string, { action: 'cancel' | 'move'; court_id: string; start: string }>>({});
  const [busy, setBusy] = useState(false);
  const args = { p_club: club.id, p_courts: courts, p_start: manilaISO(date, from), p_end: manilaISO(date, to) };

  async function check() {
    setBusy(true);
    try {
      const p = await api.rpc<{ conflicts: (Booking & { kind: string })[] }>('plan_blackout', args);
      setPlan(p);
      setRes(Object.fromEntries(p.conflicts.filter((c) => c.kind === 'booking').map((c) => [c.id, { action: 'cancel' as const, court_id: c.court_id, start: '' }])));
    } catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true);
    const resolutions = Object.entries(res).map(([id, r]) => r.action === 'cancel' ? { booking_id: id, action: 'cancel' }
      : { booking_id: id, action: 'move', court_id: r.court_id, start: manilaISO(date, r.start) });
    try {
      await api.rpc('apply_blackout', { ...args, p_reason: reason, p_resolutions: resolutions });
      toast('Courts blocked'); setPlan(null); onDone();
    } catch (e: any) {
      toast(e.code === 'slot_taken' ? 'Something changed. Check again.' : errText(e), 'err'); setPlan(null);
    } finally { setBusy(false); }
  }
  const otherBlocks = plan?.conflicts.filter((c) => c.kind !== 'booking').length ?? 0;
  const moveReady = Object.values(res).every((r) => r.action === 'cancel' || r.start);
  const reset = () => setPlan(null);

  return (
    <div className="card stack" style={{ maxWidth: 660, gap: 18 }}>
      <div className="options" role="group" aria-label="Courts">
        {club.courts.map((c) => (
          <button key={c.id} className="option" aria-checked={courts.includes(c.id)} role="checkbox"
            onClick={() => { reset(); setCourts((s) => s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]); }}><b>{c.name}</b></button>
        ))}
      </div>
      <div className="row" style={{ gap: 12 }}>
        <label className="field grow"><span>Date</span><input type="date" className="input" value={date} onChange={(e) => { reset(); setDate(e.target.value); }} /></label>
        <label className="field grow"><span>From</span><select className="input" value={from} onChange={(e) => { reset(); setFrom(e.target.value); }}>{halfHours().map((h) => <option key={h} value={h}>{hmLabel(h)}</option>)}</select></label>
        <label className="field grow"><span>To</span><select className="input" value={to} onChange={(e) => { reset(); setTo(e.target.value); }}>{[...halfHours().slice(1), '21:00'].map((h) => <option key={h} value={h}>{hmLabel(h)}</option>)}</select></label>
      </div>
      <label className="field"><span>Reason</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tournament, repairs…" /></label>
      {!plan ? (
        <button className="btn primary lg" disabled={busy || !courts.length || to <= from} onClick={check}>{busy ? <Spinner /> : 'Check for bookings'}</button>
      ) : (
        <div className="stack">
          {plan.conflicts.length === 0 ? <div className="note ok">No bookings in the way.</div> : <div className="note info">{plan.conflicts.length} booking{plan.conflicts.length > 1 ? 's' : ''} in the way</div>}
          {otherBlocks > 0 && <div className="note err">Already blocked in this range.</div>}
          {plan.conflicts.filter((c) => c.kind === 'booking').map((c) => (
            <div key={c.id} className="inset stack" style={{ gap: 10 }}>
              <div><b>{c.name}</b> <span className="small muted">· {c.court_name} {fmtTime(c.start)}–{fmtTime(c.end)} · {c.phone || c.email}</span></div>
              <div className="row">
                <div className="tabs">
                  <button aria-pressed={res[c.id]?.action === 'cancel'} onClick={() => setRes((s) => ({ ...s, [c.id]: { ...s[c.id], action: 'cancel' } }))}>Cancel and notify</button>
                  <button aria-pressed={res[c.id]?.action === 'move'} onClick={() => setRes((s) => ({ ...s, [c.id]: { ...s[c.id], action: 'move' } }))}>Move</button>
                </div>
                {res[c.id]?.action === 'move' && (
                  <>
                    <select className="input" style={{ width: 'auto', height: 46 }} value={res[c.id].court_id} onChange={(e) => setRes((s) => ({ ...s, [c.id]: { ...s[c.id], court_id: e.target.value } }))}>
                      {club.courts.map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                    </select>
                    <select className="input" style={{ width: 'auto', height: 46 }} value={res[c.id].start} onChange={(e) => setRes((s) => ({ ...s, [c.id]: { ...s[c.id], start: e.target.value } }))}>
                      <option value="">Time…</option>
                      {halfHours().map((h) => <option key={h} value={h}>{hmLabel(h)}</option>)}
                    </select>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="row">
            <button className="btn ghost" onClick={reset}>Back</button>
            <button className="btn primary grow" disabled={busy || otherBlocks > 0 || !moveReady} onClick={apply}>{busy ? <Spinner /> : 'Block courts'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

type ReportRow = { day: string; court: string; open_minutes: number; booked_minutes: number; bookings: number; online: number; no_shows: number; booked_cents: number };

function Report() {
  const { club } = useApp();
  const [from, setFrom] = useState(shift(localDate(0), -27));
  const [to, setTo] = useState(localDate(0));
  const r = useLoad(() => api.rpc<ReportRow[]>('usage_report', { p_club: club.id, p_from: from, p_to: to }), [from, to]);
  const rows = r.data ?? [];
  const sum = (k: keyof ReportRow) => rows.reduce((s, x) => s + (x[k] as number), 0);
  const occ = sum('open_minutes') ? sum('booked_minutes') / sum('open_minutes') : 0;
  const n = sum('bookings');
  const byDay = Object.values(rows.reduce<Record<string, { day: string; open: number; booked: number }>>((m, x) => {
    (m[x.day] ??= { day: x.day, open: 0, booked: 0 }); m[x.day].open += x.open_minutes; m[x.day].booked += x.booked_minutes; return m;
  }, {}));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="toolbar">
        <div className="row">
          <input type="date" className="input" style={{ height: 42, width: 170 }} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span className="faint">to</span>
          <input type="date" className="input" style={{ height: 42, width: 170 }} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        </div>
        <button className="btn sm" style={{ height: 42 }} disabled={!rows.length} onClick={() => downloadCSV(`tira_usage_${from}_${to}.csv`, rows)}>Export CSV</button>
      </div>
      {r.error ? <ErrorBox text={errText(r.error)} /> : r.loading && !r.data ? <Loading /> : (
        <>
          <div className="kpis">
            <div className="kpi" style={{ ['--k' as any]: 'var(--peri-deep)' }}><b>{Math.round(occ * 100)}%</b><span>courts used</span></div>
            <div className="kpi" style={{ ['--k' as any]: 'var(--sage-deep)' }}><b>{peso(sum('booked_cents'))}</b><span>booked</span></div>
            <div className="kpi" style={{ ['--k' as any]: 'var(--honey-deep)' }}><b>{n ? Math.round((sum('online') / n) * 100) : 0}%</b><span>booked online</span></div>
            <div className="kpi" style={{ ['--k' as any]: 'var(--rose-deep)' }}><b>{n ? Math.round((sum('no_shows') / n) * 100) : 0}%</b><span>no-shows</span></div>
          </div>
          <div className="card" style={{ padding: '10px 22px' }}>
            <table className="t">
              <tbody>
                {byDay.slice().reverse().map((d) => {
                  const p = d.open ? d.booked / d.open : 0;
                  return (
                    <tr key={d.day}>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 700 }}>{fmtDay(d.day + 'T12:00:00+08:00')}</td>
                      <td style={{ width: '70%' }}><div className="bar"><i style={{ width: `${Math.round(p * 100)}%` }} /></div></td>
                      <td className="num" style={{ textAlign: 'right' }}>{Math.round(p * 100)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
