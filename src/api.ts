// One API, two backends:
//  - live: Supabase (when VITE_SUPABASE_URL is set) — RPC + email OTP codes
//  - demo: the same SQL migration running in the browser via PGlite; codes shown on screen
import type { PGlite } from '@electric-sql/pglite';

export type Session = { email: string; sub: string } | null;

export class ApiError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); }
}

export interface Backend {
  mode: 'demo' | 'live';
  rpc<T = any>(fn: string, args?: Record<string, unknown>): Promise<T>;
  session(): Session;
  sendCode(email: string): Promise<{ demoCode?: string }>;
  verifyCode(email: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  reset?(): Promise<void>;
}

const listeners = new Set<() => void>();
export const onAuthChange = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };
const emitAuth = () => listeners.forEach((f) => f());

function normalize(e: any): ApiError {
  const code = e?.code === '23P01' ? 'slot_taken' : e?.code === '42501' && /staff_only/.test(e?.message) ? 'staff_only' : (e?.message || 'error');
  return new ApiError(code.split('\n')[0]);
}

export function deviceToken(): string {
  try {
    let t = localStorage.getItem('device_token');
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('device_token', t);
    }
    return t;
  } catch {
    return 'ephemeral-' + crypto.randomUUID();
  }
}

// ───────────── demo backend (PGlite) ─────────────

function demoBackend(): Backend {
  let dbp: Promise<PGlite> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const codes = new Map<string, string>();
  let sess: Session = null;
  try { sess = JSON.parse(localStorage.getItem('demo_session') || 'null'); } catch { /* none */ }

  async function open(fresh = false): Promise<PGlite> {
    const [{ PGlite }, { btree_gist }, shim, init, fix, seed, demo] = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite/contrib/btree_gist'),
      import('./db/shim.sql?raw'),
      import('../supabase/migrations/20261117000001_init.sql?raw'),
      import('../supabase/migrations/20261117000003_helper_search_path.sql?raw'),
      import('../supabase/seed.sql?raw'),
      import('./db/demo-seed.sql?raw'),
    ]);
    const name = 'idb://court-booking-demo';
    if (fresh) await new Promise((r) => { const q = indexedDB.deleteDatabase('/pglite/court-booking-demo'); q.onsuccess = q.onerror = q.onblocked = r; });
    let db: PGlite;
    try { db = await PGlite.create(name, { extensions: { btree_gist } }); }
    catch { db = await PGlite.create({ extensions: { btree_gist } }); }
    const has = await db.query(`select to_regclass('public.bookings') is not null as ok`);
    if (!(has.rows[0] as any).ok) {
      await db.exec(shim.default);
      await db.exec(init.default);
      await db.exec(fix.default);
      await db.exec(seed.default);
      await db.exec(demo.default);
    }
    return db;
  }
  const db = () => (dbp ??= open());

  function run<T>(f: (db: PGlite) => Promise<T>): Promise<T> {
    const p = queue.then(async () => f(await db()));
    queue = p.catch(() => undefined);
    return p;
  }

  async function asUser<T>(d: PGlite, sql: string, params: unknown[]): Promise<T> {
    await d.exec('reset role');
    await d.query(`select set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`, [
      sess ? JSON.stringify({ sub: sess.sub, email: sess.email, role: 'authenticated' }) : '',
      JSON.stringify({ 'x-forwarded-for': '127.0.0.1' }),
    ]);
    await d.exec(`set role ${sess ? 'authenticated' : 'anon'}`);
    try { return (await d.query<{ r: T }>(sql, params)).rows[0].r; }
    finally { await d.exec('reset role'); }
  }

  return {
    mode: 'demo',
    session: () => sess,
    rpc(fn, args = {}) {
      const names = Object.keys(args);
      const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
      return run((d) => asUser<any>(d, sql, names.map((n) => args[n]))).catch((e) => { throw normalize(e); });
    },
    async sendCode(email) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      codes.set(email.toLowerCase(), code);
      await new Promise((r) => setTimeout(r, 400));
      return { demoCode: code };
    },
    async verifyCode(email, code) {
      const em = email.toLowerCase().trim();
      if (codes.get(em) !== code.trim()) throw new ApiError('bad_code');
      codes.delete(em);
      const sub = await run(async (d) => {
        await d.exec('reset role');
        const r = await d.query<{ id: string }>(
          `insert into auth.users (email) values ($1) on conflict (email) do update set email = excluded.email returning id`, [em]);
        return r.rows[0].id;
      });
      sess = { email: em, sub };
      localStorage.setItem('demo_session', JSON.stringify(sess));
      emitAuth();
    },
    async signOut() { sess = null; localStorage.removeItem('demo_session'); emitAuth(); },
    async reset() {
      sess = null; localStorage.removeItem('demo_session');
      const old = dbp; dbp = null;
      if (old) await (await old).close().catch(() => undefined);
      dbp = open(true);
      await dbp;
      emitAuth();
    },
  };
}

// ───────────── live backend (Supabase) ─────────────

function liveBackend(url: string, key: string): Backend {
  let sess: Session = null;
  const clientP = import('@supabase/supabase-js').then(({ createClient }) => {
    const c = createClient(url, key);
    c.auth.getSession().then(({ data }) => {
      sess = data.session ? { email: data.session.user.email ?? '', sub: data.session.user.id } : null;
      emitAuth();
    });
    c.auth.onAuthStateChange((_e, s) => { sess = s ? { email: s.user.email ?? '', sub: s.user.id } : null; emitAuth(); });
    return c;
  });
  return {
    mode: 'live',
    session: () => sess,
    async rpc(fn, args = {}) {
      const c = await clientP;
      const { data, error } = await c.rpc(fn, args);
      if (error) throw normalize(error);
      return data;
    },
    async sendCode(email) {
      const c = await clientP;
      const { error } = await c.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error) throw new ApiError(error.status === 429 ? 'slow_down' : 'send_failed');
      return {};
    },
    async verifyCode(email, code) {
      const c = await clientP;
      const { error } = await c.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
      if (error) throw new ApiError('bad_code');
    },
    async signOut() { const c = await clientP; await c.auth.signOut(); },
  };
}

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY_ = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
export const api: Backend = URL_ && KEY_ ? liveBackend(URL_, KEY_) : demoBackend();
