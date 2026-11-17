import { Fragment, useEffect, useState } from 'react';
import { fmtTime, type Availability, type Club } from '../lib';

export type Pick = { courtIdx: number; courtId: string; start: string };

type CellState = { kind: 'free' | 'taken' | 'held' | 'block' | 'mine'; past: boolean; prime: boolean; first: boolean; bookingId?: string | null };

const fetched = new WeakMap<object, number>();
export const markFetched = (av: Availability) => { fetched.set(av, Date.now()); return av; };

export function cellStates(av: Availability, club: Club) {
  const g = club.granularity * 60e3;
  const opens = new Date(av.opens!).getTime();
  const closes = new Date(av.closes!).getTime();
  const now = new Date(av.now).getTime() + (Date.now() - (fetched.get(av) ?? Date.now()));
  const prime = new Set((av.prime ?? []).map((p) => new Date(p).getTime()));
  const times: number[] = [];
  for (let t = opens; t < closes; t += g) times.push(t);
  const cols = av.courts.map((c) =>
    times.map<CellState>((t) => {
      const o = c.occupied.find((x) => new Date(x.start).getTime() < t + g && new Date(x.end).getTime() > t);
      const kind = !o ? 'free' : o.mine ? 'mine' : o.kind === 'blackout' ? 'block' : o.held ? 'held' : 'taken';
      const first = !o || new Date(o.start).getTime() >= t || t === opens;
      return { kind, first, past: t + g <= now || (kind === 'free' && t < now), prime: prime.has(t), bookingId: o?.booking_id };
    }));
  return { times, cols };
}

const WORD: Record<string, string> = { taken: 'Booked', held: 'On hold', block: 'Closed', mine: 'Your booking' };

function PortraitGrid({ av, club, pick, onPick, onMine }: {
  av: Availability; club: Club; pick: Pick | null;
  onPick: (p: Pick) => void; onMine: (bookingId: string) => void;
}) {
  const { times, cols } = cellStates(av, club);
  const freeLeft = cols.map((col) => col.filter((s) => s.kind === 'free' && !s.past).length);
  return (
    <div className="grid" role="grid" aria-label="Court availability">
      <div className="grid-head" />
      {av.courts.map((c, i) => (
        <div key={c.id} className="grid-head">
          <div className={`court-head c${i % 2}`}><i />{c.name}<small>{freeLeft[i] ? `${freeLeft[i]} open` : 'Full'}</small></div>
        </div>
      ))}
      {times.map((t, r) => {
        const iso = new Date(t).toISOString();
        const half = new Date(t).getUTCMinutes() !== 0;
        return (
          <Fragment key={t}>
            <div className={`tlabel ${half ? 'half' : ''}`}>{fmtTime(iso, club.timezone).replace(':00', '')}</div>
            {cols.map((col, ci) => {
              const s = col[r];
              const label = `${av.courts[ci].name}, ${fmtTime(iso, club.timezone)}`;
              const next = col[r + 1];
              const prev = col[r - 1];
              const joinB = s.kind !== 'free' && next && next.kind === s.kind && !next.first;
              const joinT = s.kind !== 'free' && !s.first && prev && prev.kind === s.kind;
              const shape = `${joinT ? 'join-top' : ''} ${joinB ? 'join-bottom' : ''}`;
              if (s.kind === 'mine') {
                return (
                  <button key={ci} className={`cell mine ${shape} ${s.first ? '' : 'cont'} ${s.past ? 'past' : ''}`}
                    aria-label={`${label}: your booking`} onClick={() => s.bookingId && onMine(s.bookingId)}>
                    {WORD.mine}<span aria-hidden>→</span>
                  </button>
                );
              }
              if (s.kind !== 'free' || s.past) {
                return (
                  <button key={ci} disabled aria-label={`${label}: ${s.past ? 'past' : WORD[s.kind]}`}
                    className={`cell ${s.kind === 'free' ? '' : `taken ${s.kind}`} ${shape} ${s.first ? '' : 'cont'} ${s.past ? 'past' : ''}`}>
                    {s.past || !s.first ? '' : WORD[s.kind]}
                  </button>
                );
              }
              const sel = !!pick && pick.courtIdx === ci && pick.start === iso;
              return (
                <button key={ci} className={`cell c${ci % 2} ${sel ? 'sel' : ''}`} aria-pressed={sel} aria-label={`${label}: open${s.prime ? ', peak' : ''}`}
                  onClick={() => onPick({ courtIdx: ci, courtId: av.courts[ci].id, start: iso })}>
                  <span className="go">{sel ? 'Selected' : 'Book →'}</span>
                  {s.prime && <span className="peak" title="Peak time" />}
                </button>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

function useWide() {
  const q = '(min-width: 980px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setWide(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return wide;
}

type GridProps = { av: Availability; club: Club; pick: Pick | null; onPick: (p: Pick) => void; onMine: (bookingId: string) => void };

/** Portrait (phones): courts side by side, time runs down. Landscape (laptops): courts as rows, time runs across. */
export function CourtGrid(props: GridProps) {
  return useWide() ? <Timeline {...props} /> : <PortraitGrid {...props} />;
}

function Timeline({ av, club, pick, onPick, onMine }: GridProps) {
  const { times, cols } = cellStates(av, club);
  const g = club.granularity * 60e3;
  const start = times[0], end = times[times.length - 1] + g;
  const now = Date.now();
  const nowPct = now > start && now < end ? ((now - start) / (end - start)) * 100 : null;
  const hours = times.filter((t) => new Date(t).getUTCMinutes() === 0);
  return (
    <div className="tl" style={{ ['--n' as any]: times.length }} role="grid" aria-label="Court availability">
      <div className="tl-corner" />
      <div className="tl-hours">
        {hours.map((t) => (
          <span key={t} style={{ left: `${((t - start) / (end - start)) * 100}%` }}>
            {fmtTime(new Date(t).toISOString(), club.timezone).replace(':00', '')}
          </span>
        ))}
      </div>
      {av.courts.map((c, ci) => {
        const col = cols[ci];
        const open = col.filter((x) => x.kind === 'free' && !x.past).length;
        return (
          <Fragment key={c.id}>
            <div className={`tl-court c${ci % 2}`}><i />{c.name}<small>{open ? `${open} open` : 'Full'}</small></div>
            <div className="tl-track">
              {col.map((s, r) => {
                const t = times[r];
                const iso = new Date(t).toISOString();
                const label = `${c.name}, ${fmtTime(iso, club.timezone)}`;
                const prev = col[r - 1], next = col[r + 1];
                const joinL = s.kind !== 'free' && !s.first && prev && prev.kind === s.kind;
                const joinR = s.kind !== 'free' && next && next.kind === s.kind && !next.first;
                const shape = `${joinL ? 'jl' : ''} ${joinR ? 'jr' : ''}`;
                if (s.kind === 'mine') {
                  return (
                    <button key={r} className={`tc mine ${shape} ${s.past ? 'past' : ''}`} title="Your booking" aria-label={`${label}: your booking`}
                      onClick={() => s.bookingId && onMine(s.bookingId)}>{s.first && <span>You</span>}</button>
                  );
                }
                if (s.kind !== 'free' || s.past) {
                  const word = s.past ? 'Past' : WORD[s.kind];
                  return (
                    <button key={r} disabled title={word} aria-label={`${label}: ${word}`}
                      className={`tc ${s.kind === 'free' ? 'free' : `taken ${s.kind}`} ${shape} ${s.past ? 'past' : ''}`} />
                  );
                }
                const sel = !!pick && pick.courtIdx === ci && pick.start === iso;
                return (
                  <button key={r} className={`tc free c${ci % 2} ${sel ? 'sel' : ''}`} aria-pressed={sel}
                    title={`${fmtTime(iso, club.timezone)}${s.prime ? ' · peak' : ''}`} aria-label={`${label}: open${s.prime ? ', peak' : ''}`}
                    onClick={() => onPick({ courtIdx: ci, courtId: c.id, start: iso })}>
                    {s.prime && <i className="peak" />}<b>+</b>
                  </button>
                );
              })}
              {nowPct !== null && <div className="tl-now" style={{ left: `${nowPct}%` }} aria-hidden><span>Now</span></div>}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Which lengths fit from this start: every covered cell must be free and before closing. */
export function lengthsThatFit(av: Availability, club: Club, p: Pick): number[] {
  const { times, cols } = cellStates(av, club);
  const i0 = times.indexOf(new Date(p.start).getTime());
  return club.slot_minutes.filter((m) => {
    for (let k = 0; k < m / club.granularity; k++) {
      const s = cols[p.courtIdx][i0 + k];
      if (!s || s.kind !== 'free' || s.past) return false;
    }
    return true;
  });
}

export const isPrimePick = (av: Availability, club: Club, p: Pick, minutes: number) => {
  const prime = new Set((av.prime ?? []).map((x) => new Date(x).getTime()));
  const s = new Date(p.start).getTime();
  for (let t = s; t < s + minutes * 60e3; t += club.granularity * 60e3) if (prime.has(t)) return true;
  return false;
};

/** First open slot from now, for the hero card. */
export function nextOpen(av: Availability, club: Club) {
  if (av.closed) return null;
  const { times, cols } = cellStates(av, club);
  for (let r = 0; r < times.length; r++)
    for (let c = 0; c < cols.length; c++)
      if (cols[c][r].kind === 'free' && !cols[c][r].past) return { court: av.courts[c].name, courtIdx: c, start: new Date(times[r]).toISOString() };
  return null;
}
