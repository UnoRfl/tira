import { useEffect, useState, type ReactNode } from 'react';

/** AI-generated artwork lives in /public/brand (prompts in BRAND-PROMPTS.md).
 *  Missing file → dashed placeholder naming the file in dev, nothing in production. */
export function BrandImg({ name, alt = '', className }: { name: string; alt?: string; className?: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return <div className={`ph ${import.meta.env.DEV ? '' : 'quiet'} ${className ?? ''}`} aria-hidden>{name}</div>;
  return <img src={`${import.meta.env.BASE_URL}brand/${name}`} alt={alt} className={className} decoding="async" onError={() => setOk(false)} />;
}

/** The TIRA wordmark: condensed heavy caps, a lime ball in flight, tracked tag underneath. */
export function Wordmark({ name, small }: { name: string; small?: boolean }) {
  return (
    <span className={`wordmark ${small ? 'sm' : ''}`} aria-label={name}>
      <span className="wm-word" aria-hidden>{name.toUpperCase()}<i className="wm-ball" /></span>
      <span className="wm-tag" aria-hidden>{'PICKLEBALL'.split('').map((c, i) => <span key={i}>{c}</span>)}</span>
    </span>
  );
}

export function Sheet({ onClose, title, children }: { onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', f);
    const o = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', f); document.body.style.overflow = o; };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="grab" />
        <div className="sheet-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <button className="btn icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden />;

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="center muted"><Spinner /><span className="small">{label}…</span></div>;
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="note err">
      <span>{text}</span>
      {onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="center">
      <BrandImg name="empty.png" className="empty-art" />
      <h3>{title}</h3>
      {children && <div className="muted small">{children}</div>}
    </div>
  );
}
