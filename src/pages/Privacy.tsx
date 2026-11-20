import { useApp } from '../ctx';

// Notice under RA 10173. Contact = front desk or a reply to any Tira email (no personal address on the page).
export function Privacy() {
  const { club } = useApp();
  return (
    <section className="wrap section" style={{ maxWidth: 720 }}>
      <div className="card stack" style={{ gap: 16 }}>
        <span className="eyebrow">Data Privacy Act</span>
        <h2>Privacy notice</h2>
        <p><b>{club.name}</b> is the personal information controller for this booking site under the Data Privacy Act of 2012 (RA 10173).</p>
        <h3>What we keep</h3>
        <p>Your name, email, phone (if given), bookings, check-ins and no-shows. We use them only to run court bookings and contact you about them.</p>
        <h3>Who processes it</h3>
        <p>Supabase (database, Singapore), GitHub Pages (hosting) and Google (sign-in codes and booking emails).</p>
        <h3>How long</h3>
        <p>Details are anonymised after 24 months without a booking.</p>
        <h3>Your rights</h3>
        <p>Ask to see, correct or delete your data at the front desk, or reply to any email from {club.name}. We answer within 15 days.</p>
      </div>
    </section>
  );
}
