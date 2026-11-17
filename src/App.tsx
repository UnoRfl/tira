import { useEffect, useState } from 'react';
import { api } from './api';
import { BrandImg, Loading, ErrorBox, Sheet } from './components/Sheet';
import { SignIn } from './components/SignIn';
import { AppProvider, useApp } from './ctx';
import { errText, useHash, type Club } from './lib';
import { Desk } from './pages/Desk';
import { Home } from './pages/Home';
import { MyBookings } from './pages/MyBookings';
import { Privacy } from './pages/Privacy';

export default function App() {
  const [club, setClub] = useState<Club | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => { setErr(null); api.rpc<Club>('club_info').then(setClub, setErr); };
  useEffect(load, []);
  if (err) return <div className="wrap section"><ErrorBox text={errText(err)} onRetry={load} /></div>;
  if (!club) return <div className="wrap" style={{ paddingTop: '30vh' }}><Loading label="Opening the courts" /></div>;
  return <AppProvider club={club}><Shell /></AppProvider>;
}

function Shell() {
  const { club, me } = useApp();
  const [route] = useHash();
  const [signIn, setSignIn] = useState(false);
  const staff = me?.role === 'staff' || me?.role === 'owner';
  const page = route.startsWith('/me') ? 'me' : route.startsWith('/desk') ? 'desk' : route.startsWith('/privacy') ? 'privacy' : 'home';
  useEffect(() => { document.title = ({ home: `${club.name} · Book a court`, me: `My bookings · ${club.name}`, desk: `Desk · ${club.name}`, privacy: `Privacy · ${club.name}` } as Record<string, string>)[page] ; }, [page, club.name]);

  return (
    <>
      {api.mode === 'demo' && (
        <div className="demo-banner">
          Demo · runs in your browser ·{' '}
          <button className="link" style={{ fontSize: 'inherit' }}
            onClick={async () => { await api.reset?.(); location.hash = '/'; location.reload(); }}>Reset</button>
        </div>
      )}
      <header className="top">
        <div className="wrap nav">
          <a className="brand" href="#/" aria-label={`${club.name} home`}><BrandImg name="logo-mark.png" className="brand-mark" /><span className="brand-word">{club.name}</span></a>
          <nav className="navlinks" aria-label="Main">
            <a href="#/" aria-current={page === 'home' ? 'page' : undefined}>Book</a>
            <a href="#/me" aria-current={page === 'me' ? 'page' : undefined}>My bookings</a>
            {staff && <a href="#/desk" aria-current={page === 'desk' ? 'page' : undefined}>Desk</a>}
          </nav>
          {me?.profile
            ? <button className="btn sm ghost" onClick={() => api.signOut()} title={me.contact?.email}>Sign out</button>
            : <button className="btn sm primary" onClick={() => setSignIn(true)}>Sign in</button>}
        </div>
      </header>
      <main>
        {page === 'home' && <Home />}
        {page === 'me' && <MyBookings />}
        {page === 'desk' && <Desk />}
        {page === 'privacy' && <Privacy />}
      </main>
      <footer>
        <div className="wrap spread">
          <span>© {new Date().getFullYear()} {club.name}</span>
          <span className="row" style={{ gap: 18 }}><a href="#/privacy">Privacy</a>{api.mode === 'demo' && !staff && <span className="tiny">Desk demo: desk@club.test</span>}</span>
        </div>
      </footer>
      {signIn && <Sheet onClose={() => setSignIn(false)} title="Sign in"><SignIn onDone={() => setSignIn(false)} /></Sheet>}
    </>
  );
}
