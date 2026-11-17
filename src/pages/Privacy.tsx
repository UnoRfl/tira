import { useApp } from '../ctx';

// Draft notice (RA 10173). The club must review it and fill in the privacy contact before launch.
export function Privacy() {
  const { club } = useApp();
  return (
    <section className="wrap section" style={{ maxWidth: 720 }}>
      <div className="card stack" style={{ gap: 16 }}>
        <span className="eyebrow">Data Privacy Act</span>
        <h2>Privacy notice</h2>
        <p className="muted small" style={{ margin: 0 }}>Draft · to be reviewed by the club</p>
        <p><b>{club.name}</b> is the personal information controller for this booking site under the Data Privacy Act of 2012 (RA 10173).</p>
        <h3>What we keep</h3>
        <p>Your name, email, phone (if given), bookings, check-ins and no-shows. We use them only to run court bookings and contact you about them.</p>
        <h3>Who processes it</h3>
        <p>Supabase (database, Singapore), GitHub Pages (hosting) and Google (sign-in code emails).</p>
        <h3>How long</h3>
        <p>Details are anonymised after 24 months without a booking.</p>
        <h3>Your rights</h3>
        <p>Ask to see, correct or delete your data at the desk or by email to the club’s privacy contact: <i>[to be named]</i>.</p>
      </div>
    </section>
  );
}
