import { Fragment } from 'react';
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

const WORD = { taken: 'Booked', held: 'On hold', block: 'Closed', mine: 'Your booking' } as const;

export function CourtGrid({ av, club, pick, onPick, onMine }: {
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
                  <button key={ci} disabled aria-label={`${label}: ${s.past ? 'past' : WORD[s.kind as keyof typeof WORD]}`}
                    className={`cell ${s.kind === 'free' ? '' : `taken ${s.kind}`} ${shape} ${s.first ? '' : 'cont'} ${s.past ? 'past' : ''}`}>
                    {s.past || !s.first ? '' : WORD[s.kind as keyof typeof WORD]}
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
