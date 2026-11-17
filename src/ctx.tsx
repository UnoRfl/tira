import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useSession, type Club, type Me } from './lib';

type Ctx = {
  club: Club;
  me: Me | null;
  refreshMe: () => Promise<Me | null>;
  toast: (msg: string, kind?: 'ok' | 'err' | 'info') => void;
};
const C = createContext<Ctx | null>(null);
export const useApp = () => useContext(C)!;

export function AppProvider({ club, children }: { club: Club; children: ReactNode }) {
  const session = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [t, setT] = useState<{ msg: string; kind: string; id: number } | null>(null);

  const refreshMe = useCallback(async () => {
    if (!api.session()) { setMe(null); return null; }
    try { const m = await api.rpc<Me>('me'); setMe(m); return m; } catch { setMe(null); return null; }
  }, []);
  useEffect(() => { refreshMe(); }, [session, refreshMe]);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' | 'info' = 'ok') => {
    const id = Date.now();
    setT({ msg, kind, id });
    setTimeout(() => setT((x) => (x?.id === id ? null : x)), 3200);
  }, []);

  return (
    <C.Provider value={{ club, me, refreshMe, toast }}>
      {children}
      {t && <div className={`toast ${t.kind}`} role="status">{t.msg}</div>}
    </C.Provider>
  );
}
