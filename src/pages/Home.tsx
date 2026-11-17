import { useCallback, useState } from 'react';
import { api } from '../api';
import { BookingSheet } from '../components/BookingSheet';
import { CourtGrid, markFetched, nextOpen, type Pick } from '../components/CourtGrid';
import { BrandImg, Empty, ErrorBox } from '../components/Sheet';
import { useApp } from '../ctx';
import { errText, fmtTime, localDate, peso, useLoad, usePoll, type Availability } from '../lib';

export function Home() {
  const { club, me, toast } = useApp();
  const today = localDate(0, club.timezone);
  const [date, setDate] = useState(today);
  const [pick, setPick] = useState<Pick | null>(null);
  const windowDays = me?.contact?.is_member ? club.member_window_days : club.public_window_days;

  const { data: av, error, loading, reload } = useLoad(
    () => api.rpc<Availability>('availability', { p_club: club.id, p_date: date }).then(markFetched),
    [club.id, date, me?.user_id],
  );
  const quiet = useCallback(() => reload(true), [reload]);
  usePoll(quiet, 20000);

  // the hero card always looks at today
  // (reuses the grid's data when the grid is on today, so the page doesn't fetch today twice)
  const onToday = date === today;
  const otherAv = useLoad(() => onToday ? Promise.resolve(null)
    : api.rpc<Availability>('availability', { p_club: club.id, p_date: today }).then(markFetched), [club.id, today, onToday]);
  const todayAv = { data: onToday ? av : otherAv.data, reload: (q?: boolean) => (onToday ? Promise.resolve() : otherAv.reload(q)) };
  const next = todayAv.data ? nextOpen(todayAv.data, club) : null;

  const days = Array.from({ length: club.member_window_days + 1 }, (_, i) => localDate(i, club.timezone));
  const fmt = (d: string, o: Intl.DateTimeFormatOptions) => new Date(d + 'T12:00:00+08:00').toLocaleDateString('en-PH', { ...o, timeZone: club.timezone });
  const dayIdx = days.indexOf(date);
  const locked = dayIdx > windowDays;
  const after = av && !av.closed && Date.now() >= new Date(av.closes!).getTime();

  return (
    <>
      <section className="hero wrap" aria-labelledby="hero-title">
        <div>
          <span className="eyebrow">Pickleball · {club.courts.length} courts</span>
          <h1 id="hero-title">Your court,<br /><em>ready</em> when you are.</h1>
          <p className="lead">See both courts live, hold a slot in one tap and show your code at the desk.</p>
          <div className="row" style={{ gap: 12 }}>
            <a className="btn primary lg" href="#book">Book a court</a>
            <a className="btn lg" href="#how">How it works</a>
          </div>
          <div className="facts">
            <div><b>{peso(club.price_per_hour_cents)}</b><span>per court-hour</span></div>
            <div><b>7am–9pm</b><span>open daily</span></div>
            <div><b>{club.public_window_days} days</b><span>book ahead</span></div>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-frame"><BrandImg name="hero.jpg" alt="Players on a pickleball court" /></div>
          <a className="float-card" href="#book" onClick={() => setDate(today)}>
            <span className="sw" style={{ background: next ? (next.courtIdx ? 'var(--peri)' : 'var(--sage)') : 'var(--bg-deep)' }}>
              {next ? next.court.replace(/\D/g, '') : '–'}
            </span>
            <span>
              <small>{next ? 'Next open' : 'Today'}</small>
              <b>{next ? `${next.court} · ${fmtTime(next.start, club.timezone)}`
                : !todayAv.data ? '…'
                : todayAv.data.closed || Date.now() >= new Date(todayAv.data.closes!).getTime() ? 'Closed · book tomorrow'
                : 'All booked up'}</b>
            </span>
          </a>
        </div>
      </section>

      <section id="book" className="section wrap" aria-labelledby="book-title" style={{ scrollMarginTop: 72 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">Live availability</span>
            <h2 id="book-title" style={{ marginTop: 10 }}>Pick a time</h2>
          </div>
          {me?.contact?.is_member && <span className="tag peri">Member · books {club.member_window_days} days ahead</span>}
        </div>

        <div className="days" role="group" aria-label="Day">
          {days.map((d, i) => {
            const locked = i > windowDays;
            return (
              <button key={d} className={`day ${locked ? 'locked' : ''}`} aria-pressed={d === date}
                onClick={() => { setDate(d); setPick(null); }} title={locked ? 'Members only' : undefined}>
                <small>{i === 0 ? 'Today' : fmt(d, { weekday: 'short' })}</small>
                <b>{fmt(d, { day: 'numeric' })}</b>
                <small>{locked ? 'Members' : fmt(d, { month: 'short' })}</small>
              </button>
            );
          })}
        </div>

        <div className="card board">
          {error ? <ErrorBox text={errText(error)} onRetry={() => reload()} />
            : loading && !av ? <GridSkeleton />
            : av?.closed ? <Empty title="Closed this day" />
            : after ? <Empty title="Closed for today">Pick another day above.</Empty>
            : av && <>
              {locked && <div className="note info" style={{ marginBottom: 14 }}><span>Members book up to {club.member_window_days} days ahead. Everyone else, up to {club.public_window_days}.</span></div>}
              <CourtGrid av={av} club={club} pick={pick} onPick={(p) => (locked ? toast('Members only this far ahead', 'info') : setPick(p))} onMine={() => { location.hash = '/me'; }} />
            </>}
          <div className="legend" aria-hidden>
            <span><i style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--hair)' }} />Open</span>
            <span><i style={{ background: 'var(--bg-deep)' }} />Booked</span>
            <span><i style={{ background: 'var(--lime)' }} />Yours</span>
            <span><i className="dot" style={{ background: '#ff9a5c' }} />Peak, verify first</span>
          </div>
        </div>
      </section>

      <section id="how" className="section wrap" aria-labelledby="how-title" style={{ scrollMarginTop: 72 }}>
        <div className="section-head"><div><span className="eyebrow">Three steps</span><h2 id="how-title" style={{ marginTop: 10 }}>How it works</h2></div></div>
        <div className="how">
          {[
            ['how-1.png', 'var(--sage)', 'Tap an open slot', 'It’s held for you while you finish.'],
            ['how-2.png', 'var(--peri)', 'Type your code', 'We email a 6-digit code. Only the first time.'],
            ['how-3.png', 'var(--peach)', 'Show it and play', 'Pay at the desk, then hit the court.'],
          ].map(([img, tint, t, s], i) => (
            <div className="step" key={img}>
              <div className="art" style={{ ['--tint' as any]: tint }}><BrandImg name={img} /></div>
              <div className="body"><small>0{i + 1}</small><h3>{t}</h3><p className="muted small">{s}</p></div>
            </div>
          ))}
        </div>
      </section>

      {pick && av && (
        <BookingSheet av={av} pick={pick} onClose={() => { setPick(null); reload(true); todayAv.reload(true); }} onChanged={quiet} />
      )}
    </>
  );
}

function GridSkeleton() {
  return (
    <div className="grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 27 }, (_, i) => <div key={i} className="skeleton" style={i % 3 === 0 ? { visibility: 'hidden' } : undefined} />)}
    </div>
  );
}
