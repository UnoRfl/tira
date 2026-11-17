import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { errText, useSession, type Club, type Me } from './lib';

type Ctx = {
  club: Club;
  me: Me | null;
  refreshMe: () => Promise<Me | null>;
  toast: (msg: string, kind?: 'ok' | 'err' | 'info') => void;
};
const C = createContext<Ctx | null>(null);
export const useApp = () => useContext(C)!;

type Pending = { email: string; name: string; consent: boolean };
const readPending = (): Pending | null => { try { return JSON.parse(localStorage.getItem('pending_profile') || 'null'); } catch { return null; } };
const clearPending = () => { try { localStorage.removeItem('pending_profile'); } catch { /* ignore */ } };

// One in-flight ensure_profile at a time (the code form and the link landing can both trigger it).
let inflight: Promise<Me> | null = null;
export function ensureProfile(club: string, name: string, consent: boolean): Promise<Me> {
  inflight ??= api.rpc<Me>('ensure_profile', { p_club: club, p_name: name, p_phone: null, p_consent: consent })
    .finally(() => { inflight = null; });
  return inflight.then((m) => { clearPending(); return m; });
}

export function AppProvider({ club, children }: { club: Club; children: ReactNode }) {
  const session = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [t, setT] = useState<{ msg: string; kind: string; id: number } | null>(null);

  const refreshMe = useCallback(async () => {
    const s = api.session();
    if (!s) { setMe(null); return null; }
    try {
      let m = await api.rpc<Me>('me');
      // Signed in by the emailed link: finish the profile with what they typed before.
      if (!m.profile || m.contact?.needs_consent) {
        const p = readPending();
        if (p && p.consent && p.email === s.email.toLowerCase()) m = await ensureProfile(club.id, p.name, true);
      }
      setMe(m);
      return m;
    } catch { setMe(null); return null; }
  }, [club.id]);
  useEffect(() => { refreshMe(); }, [session, refreshMe]);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' | 'info' = 'ok') => {
    const id = Date.now();
    setT({ msg, kind, id });
    setTimeout(() => setT((x) => (x?.id === id ? null : x)), 3200);
  }, []);

  const needsFinish = !!session && !!me && (!me.profile || !!me.contact?.needs_consent);

  return (
    <C.Provider value={{ club, me, refreshMe, toast }}>
      {children}
      {needsFinish && <FinishProfile club={club.id} onDone={async () => { await refreshMe(); toast('You’re signed in'); }} />}
      {t && <div className={`toast ${t.kind}`} role="status">{t.msg}</div>}
    </C.Provider>
  );
}

/** Shown only when someone arrives signed in (via link) without a profile or consent. */
function FinishProfile({ club, onDone }: { club: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="scrim">
      <form className="sheet stack" style={{ gap: 16 }} onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await ensureProfile(club, name, consent); onDone(); } catch (x) { setErr(errText(x)); setBusy(false); }
      }}>
        <div className="sheet-head"><h2>One last step</h2><button type="button" className="btn sm ghost" onClick={() => api.signOut()}>Sign out</button></div>
        <label className="field"><span>Name</span><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Juan dela Cruz" /></label>
        <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I agree to the <a href="#/privacy" target="_blank" rel="noreferrer">privacy notice</a></span></label>
        {err && <div className="note err">{err}</div>}
        <button className="btn primary lg block" disabled={busy || !consent}>Continue</button>
      </form>
    </div>
  );
}
