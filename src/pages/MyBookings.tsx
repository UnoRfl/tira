import { useState } from 'react';
import { api } from '../api';
import { Empty, ErrorBox, Loading, Spinner } from '../components/Sheet';
import { SignIn } from '../components/SignIn';
import { useApp } from '../ctx';
import { STATUS_LABEL, errText, fmtTime, peso, useLoad, type Booking } from '../lib';

export function MyBookings() {
  const { me, club, toast } = useApp();
  const { data, error, loading, reload } = useLoad(
    () => (me?.profile ? api.rpc<Booking[]>('my_bookings') : Promise.resolve([] as Booking[])),
    [me?.user_id, me?.profile],
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!me?.profile) {
    return (
      <section className="wrap section" style={{ maxWidth: 460 }}>
        <span className="eyebrow">My bookings</span>
        <h2 style={{ margin: '10px 0 22px' }}>Sign in to see your courts</h2>
        <div className="card"><SignIn onDone={() => reload()} /></div>
      </section>
    );
  }

  const now = Date.now();
  const upcoming = (data ?? []).filter((b) => new Date(b.end).getTime() > now && ['confirmed', 'held', 'checked_in'].includes(b.status)).reverse();
  const past = (data ?? []).filter((b) => !upcoming.includes(b));
  const courtIdx = (id: string) => Math.max(0, club.courts.findIndex((c) => c.id === id)) % 2;
  const dayPart = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleDateString('en-PH', { ...o, timeZone: club.timezone });

  async function cancel(b: Booking) {
    if (!confirm(`Cancel ${b.court_name} at ${fmtTime(b.start)}?`)) return;
    setBusyId(b.id);
    try { await api.rpc('cancel_booking', { p_booking: b.id }); toast('Booking cancelled'); reload(true); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusyId(null); }
  }

  const Item = ({ b, dim }: { b: Booking; dim?: boolean }) => {
    const canCancel = b.status === 'confirmed' && now < new Date(b.start).getTime() - club.cancel_cutoff_min * 60e3;
    return (
      <div className={`booking ${dim ? 'dim' : ''}`}>
        <div className={`date c${courtIdx(b.court_id)}`}><small>{dayPart(b.start, { weekday: 'short' })}</small><b>{dayPart(b.start, { day: 'numeric' })}</b></div>
        <div style={{ display: 'grid', gap: 3 }}>
          <div className="row" style={{ gap: 12 }}><span className="title">{b.court_name}</span><span className={`status ${b.status}`}>{STATUS_LABEL[b.status] ?? b.status}</span></div>
          <div className="small muted">{fmtTime(b.start)} – {fmtTime(b.end)} · {peso(b.price_cents)}</div>
          <div className="ref">{b.ref_code}</div>
        </div>
        <div className="row actions">
          {canCancel && <button className="btn sm danger" disabled={busyId === b.id} onClick={() => cancel(b)}>{busyId === b.id ? <Spinner /> : 'Cancel'}</button>}
          {b.status === 'confirmed' && !canCancel && !dim && <span className="tiny faint">Call the desk to cancel</span>}
        </div>
      </div>
    );
  };

  return (
    <section className="wrap section stack" style={{ maxWidth: 720, gap: 28 }}>
      <div className="spread" style={{ alignItems: 'end' }}>
        <div>
          <span className="eyebrow">My bookings</span>
          <h2 style={{ marginTop: 10 }}>Hi, {me.contact?.name.split(' ')[0] || 'there'}</h2>
          <div className="row" style={{ marginTop: 10 }}>
            {me.contact?.is_member && <span className="tag peri">Member</span>}
            {!!me.contact?.strikes && <span className="tag rose">{me.contact.strikes} no-show{me.contact.strikes > 1 ? 's' : ''}</span>}
          </div>
        </div>
        <a className="btn accent" href="#/">Book a court</a>
      </div>
      {error ? <ErrorBox text={errText(error)} onRetry={() => reload()} />
        : loading && !data ? <Loading />
        : (
          <>
            <div className="stack">
              <h3>Upcoming</h3>
              {upcoming.length ? <div className="list">{upcoming.map((b) => <Item key={b.id} b={b} />)}</div>
                : <div className="card"><Empty title="Nothing booked yet"><a href="#/" className="link">Find an open court</a></Empty></div>}
            </div>
            {past.length > 0 && (
              <div className="stack">
                <h3>History</h3>
                <div className="list">{past.map((b) => <Item key={b.id} b={b} dim />)}</div>
              </div>
            )}
          </>
        )}
    </section>
  );
}
