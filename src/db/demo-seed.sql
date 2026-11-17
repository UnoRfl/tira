-- Demo only: a desk account and some bookings around today so the grid looks real.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000d001', 'desk@club.test');
insert into public.contacts (id, club_id, name, email, verified_at, consent_at)
values ('00000000-0000-4000-8000-00000000d0c1', '00000000-0000-4000-8000-000000000001', 'Desk', 'desk@club.test', now(), now());
insert into public.profiles (id, contact_id, role) values ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000d0c1', 'owner');
insert into public.contacts (club_id, name, email, phone, verified_at, consent_at, member_type, member_until) values
  ('00000000-0000-4000-8000-000000000001', 'Rica Santos',  'rica@example.com',  '0917 555 0101', now(), now(), 'member', current_date + 200),
  ('00000000-0000-4000-8000-000000000001', 'Paolo Cruz',   'paolo@example.com', '0918 555 0102', now(), now(), 'none', null),
  ('00000000-0000-4000-8000-000000000001', 'Jen Villanueva','jen@example.com',  '0919 555 0103', now(), now(), 'member', current_date + 30),
  ('00000000-0000-4000-8000-000000000001', 'Marco Reyes',  'marco@example.com', '0920 555 0104', now(), now(), 'none', null);
do $$
declare club uuid := '00000000-0000-4000-8000-000000000001'; d date := (now() at time zone 'Asia/Manila')::date;
        r record; s timestamptz; bid uuid; st text; i int := 0;
begin
  for r in select * from (values
      (0,'Court 1','08:00',60,'Rica Santos'),(0,'Court 2','09:00',90,'Paolo Cruz'),(0,'Court 1','11:00',60,'Jen Villanueva'),
      (0,'Court 1','17:00',90,'Marco Reyes'),(0,'Court 2','18:00',60,'Rica Santos'),(0,'Court 2','19:30',90,'Jen Villanueva'),
      (1,'Court 1','18:00',60,'Paolo Cruz'),(1,'Court 2','17:30',90,'Marco Reyes'),(1,'Court 1','07:00',60,'Jen Villanueva'),
      (2,'Court 2','19:00',60,'Rica Santos')) v(dd, court, t, mins, who) loop
    s := ((d + r.dd) + r.t::time) at time zone 'Asia/Manila';
    st := case when s + make_interval(mins => r.mins) < now() then 'completed'
               when s < now() then 'checked_in' else 'confirmed' end;
    i := i + 1;
    insert into public.bookings (ref_code, club_id, contact_id, court_id, slot, status, price_cents, currency, client_request_id, paid_status)
    select 'DEMO' || lpad(i::text, 2, '0'), club, c.id, ct.id, tstzrange(s, s + make_interval(mins => r.mins)), st,
           r.mins * 50000 / 60, 'PHP', gen_random_uuid(), case when st = 'confirmed' then 'unpaid' else 'paid_desk' end
    from public.contacts c, public.courts ct where c.name = r.who and ct.name = r.court
    returning id into bid;
    insert into public.court_blocks (club_id, court_id, slot, kind, status, ref_id)
    select club, court_id, slot, 'booking', case when st = 'completed' then 'released' else 'active' end, id
    from public.bookings where id = bid;
  end loop;
end $$;
