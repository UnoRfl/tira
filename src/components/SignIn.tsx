import { useRef, useState } from 'react';
import { api } from '../api';
import { ensureProfile, useApp } from '../ctx';
import { errText, type Me } from '../lib';
import { Spinner } from './Sheet';

/** Email → 6-digit code → profile (with privacy consent). Typed codes, no magic links (PLAN §6). */
export function SignIn({ onDone }: { onDone: (me: Me) => void }) {
  const { club, refreshMe } = useApp();
  const [step, setStep] = useState<'details' | 'code'>('details');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [demoCode, setDemoCode] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const codeRef = useRef<HTMLInputElement>(null);

  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());

  async function send() {
    setBusy(true); setErr('');
    try {
      try { localStorage.setItem('pending_profile', JSON.stringify({ email: email.trim().toLowerCase(), name, consent })); } catch { /* private mode */ }
      const r = await api.sendCode(email.trim());
      setDemoCode(r.demoCode);
      setStep('code');
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }

  async function verify(c = code) {
    setBusy(true); setErr('');
    try {
      await api.verifyCode(email.trim(), c);
      let me = await api.rpc<Me>('me');
      if (!me.profile || me.contact?.needs_consent) me = await ensureProfile(club.id, name, consent);
      await refreshMe();
      onDone(me);
    } catch (e) { setErr(errText(e)); setCode(''); setBusy(false); }
  }

  if (step === 'code') {
    return (
      <form className="stack" style={{ gap: 18 }} onSubmit={(e) => { e.preventDefault(); verify(); }}>
        <p className="muted">We emailed a code to <b style={{ color: 'var(--ink)' }}>{email}</b>. Type the 6-digit code from it.</p>
        {demoCode && (
          <div className="note info">
            <span>Demo code <b className="num" style={{ letterSpacing: '.2em', fontSize: '1.1rem' }}>{demoCode}</b></span>
            <button type="button" className="btn sm" onClick={() => { setCode(demoCode); verify(demoCode); }}>Use it</button>
          </div>
        )}
        <label style={{ position: 'relative', display: 'block' }}>
          <span className="sr" style={{ position: 'absolute', opacity: 0 }}>6-digit code</span>
          <div className="otp" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <input key={i} className="input" tabIndex={-1} readOnly value={code[i] ?? ''}
                style={i === Math.min(code.length, 5) && !busy ? { boxShadow: 'var(--press), 0 0 0 2.5px var(--ink)' } : undefined} />
            ))}
          </div>
          <input ref={codeRef} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code}
            aria-label="6-digit code"
            style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', fontSize: 16 }}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              if (v.length === 6) verify(v);
            }} />
        </label>
        {err && <div className="note err">{err}</div>}
        <button className="btn primary lg block" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : 'Verify'}</button>
        <div className="row" style={{ justifyContent: 'center', gap: 22 }}>
          <button type="button" className="link small" onClick={() => { setStep('details'); setCode(''); }}>Change email</button>
          <button type="button" className="link small" disabled={busy} onClick={send}>Resend code</button>
        </div>
      </form>
    );
  }

  return (
    <form className="stack" style={{ gap: 16 }} onSubmit={(e) => { e.preventDefault(); if (emailOk && consent) send(); }}>
      <label className="field"><span>Name</span>
        <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Juan dela Cruz" />
      </label>
      <label className="field"><span>Email</span>
        <input className="input" type="email" autoComplete="email" inputMode="email" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />
      </label>
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I agree to the <a href="#/privacy" target="_blank" rel="noreferrer">privacy notice</a></span>
      </label>
      {err && <div className="note err">{err}</div>}
      <button className="btn primary lg block" disabled={busy || !emailOk || !consent}>
        {busy ? <Spinner /> : 'Email me a code'}
      </button>
    </form>
  );
}
