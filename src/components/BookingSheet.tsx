import { useEffect, useRef, useState } from 'react';
import { api, deviceToken } from '../api';
import { useApp } from '../ctx';
import { errText, fmtDayLong, fmtTime, peso, useNow, uuid, type Availability, type Booking } from '../lib';
import { isPrimePick, lengthsThatFit, type Pick } from './CourtGrid';
import { BrandImg, Sheet, Spinner } from './Sheet';
import { SignIn } from './SignIn';

type Stage = 'pick' | 'verify' | 'confirm' | 'done';
const LEN: Record<number, string> = { 60: '1 hour', 90: '1½ hours', 120: '2 hours' };

export function BookingSheet({ av, pick, onClose, onChanged }: {
  av: Availability; pick: Pick; onClose: () => void; onChanged: () => void;
}) {
  const { club, me } = useApp();
  const fits = lengthsThatFit(av, club, pick);
  const [minutes, setMinutes] = useState<number>(fits[0] ?? club.slot_minutes[0]);
  const [stage, setStage] = useState<Stage>('pick');
  const [booking, setBookingRaw] = useState<Booking | null>(null);
  const [holdTotal, setHoldTotal] = useState(300);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const rid = useRef(uuid());
  const now = useNow(500);

  const setBooking = (b: Booking | null) => {
    setBookingRaw(b);
    if (b?.hold_expires_at) setHoldTotal(Math.max(1, Math.round((new Date(b.hold_expires_at).getTime() - Date.now()) / 1000)));
  };

  const court = av.courts[pick.courtIdx];
  const end = new Date(new Date(pick.start).getTime() + minutes * 60e3).toISOString();
  const price = (club.price_per_hour_cents * minutes) / 60;
  const prime = isPrimePick(av, club, pick, minutes);
  const signedIn = !!me?.profile;
  const left = booking?.hold_expires_at ? Math.max(0, Math.floor((new Date(booking.hold_expires_at).getTime() - now) / 1000)) : null;

  useEffect(() => {
    if (left === 0 && (stage === 'confirm' || stage === 'verify') && booking) {
      setErr(errText({ code: 'hold_expired' }));
      setBooking(null); rid.current = uuid(); setStage('pick'); onChanged();
    }
  }, [left, stage, booking, onChanged]);

  async function hold(asGuest: boolean) {
    const b = await api.rpc<Booking>('hold_slot', {
      p_court: pick.courtId, p_start: pick.start, p_minutes: minutes, p_client_request_id: rid.current,
      ...(asGuest ? { p_device_token: deviceToken() } : {}),
    });
    setBooking(b);
    onChanged();
    return b;
  }

  function fail(e: unknown) { setErr(errText(e)); rid.current = uuid(); setBooking(null); setStage('pick'); onChanged(); }

  async function start() {
    setBusy(true); setErr('');
    try {
      if (signedIn) { await hold(false); setStage('confirm'); }
      else if (prime) setStage('verify');           // peak slots: verify before any hold
      else { await hold(true); setStage('verify'); } // hold for 3 min while they verify
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  }

  async function afterVerify() {
    setBusy(true); setErr('');
    try {
      if (booking) {
        const r = await api.rpc<Booking & { error?: string }>('attach_contact', { p_booking: booking.id, p_device_token: deviceToken() });
        if (r.error) return fail({ code: r.error });
        setBooking(r); onChanged();
      } else {
        rid.current = uuid();
        await hold(false);
      }
      setStage('confirm');
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!booking) return;
    setBusy(true); setErr('');
    try {
      const b = await api.rpc<Booking>('confirm_booking', { p_booking: booking.id });
      setBookingRaw(b); setStage('done'); onChanged();
    } catch (e) { if ((e as any).code === 'hold_expired') fail(e); else setErr(errText(e)); }
    finally { setBusy(false); }
  }

  function close() {
    if (booking && booking.status === 'held' && signedIn) {
      api.rpc('cancel_booking', { p_booking: booking.id }).then(onChanged, () => undefined);
    }
    onClose();
  }

  const c = pick.courtIdx % 2;
  const SlotCard = (
    <div className={`slot-card c${c}`}>
      <span className="k">{court.name}</span>
      <span className="t">{fmtTime(pick.start, club.timezone)} – {fmtTime(end, club.timezone)}</span>
      <span className="d">{fmtDayLong(pick.start, club.timezone)}</span>
      <span className="p">{peso(booking?.price_cents ?? price)}</span>
    </div>
  );

  const Hold = left !== null && stage !== 'done' && (
    <div className="hold" aria-live="polite">
      <div className={`hold-bar ${left < 60 ? 'low' : ''}`}><i style={{ width: `${(left / holdTotal) * 100}%` }} /></div>
      <div className="hold-label"><span>Held for you</span><span className="num">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span></div>
    </div>
  );

  const title = { pick: 'Book this court', verify: 'Verify your email', confirm: 'Confirm booking', done: 'You’re booked' }[stage];

  return (
    <Sheet onClose={close} title={title}>
      <div className="stack" style={{ gap: 18 }}>
        {stage === 'done' && booking ? (
          <>
            <BrandImg name="success.png" className="success-art" />
            <div className="ticket" aria-label={`Booking code ${booking.ref_code}`}>
              <div className="stub"><small>Show this at the desk</small><div className="code">{booking.ref_code}</div></div>
              <div className="tear" />
              <div className="info">
                <div><small>Court</small><b>{booking.court_name}</b></div>
                <div><small>Date</small><b>{fmtDayLong(booking.start, club.timezone).split(',').slice(0, 2).join(',')}</b></div>
                <div><small>Time</small><b>{fmtTime(booking.start, club.timezone)} – {fmtTime(booking.end, club.timezone)}</b></div>
                <div><small>Pay at desk</small><b>{peso(booking.price_cents)}</b></div>
              </div>
            </div>
            <div className="row">
              <a className="btn grow" href="#/me" onClick={onClose}>My bookings</a>
              <button className="btn primary grow" onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            {SlotCard}
            {Hold}
          </>
        )}

        {stage === 'pick' && (
          <>
            <div className="options" role="radiogroup" aria-label="Length">
              {club.slot_minutes.map((m) => (
                <button key={m} role="radio" aria-checked={minutes === m} className="option" disabled={!fits.includes(m)} onClick={() => setMinutes(m)}>
                  <b>{LEN[m] ?? `${m} min`}</b>
                  <span>{fits.includes(m) ? peso((club.price_per_hour_cents * m) / 60) : 'Not free'}</span>
                </button>
              ))}
            </div>
            {prime && !signedIn && <div className="note info"><span>Peak time. Verify your email first.</span></div>}
            {err && <div className="note err">{err}</div>}
            <button className="btn primary lg block" onClick={start} disabled={busy || !fits.length}>
              {busy ? <Spinner /> : signedIn ? `Hold · ${peso(price)}` : 'Continue'}
            </button>
          </>
        )}

        {stage === 'verify' && (busy ? <div className="center"><Spinner /></div> : <SignIn onDone={afterVerify} />)}
        {stage === 'verify' && err && <div className="note err">{err}</div>}

        {stage === 'confirm' && (
          <>
            {err && <div className="note err">{err}</div>}
            <button className="btn accent lg block" onClick={confirm} disabled={busy}>
              {busy ? <Spinner /> : `Confirm · ${peso(booking?.price_cents ?? price)}`}
            </button>
            <p className="muted tiny" style={{ textAlign: 'center' }}>Pay at the desk · free cancellation up to {club.cancel_cutoff_min / 60} h before</p>
          </>
        )}
      </div>
    </Sheet>
  );
}
