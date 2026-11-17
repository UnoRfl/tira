-- Club, 2 courts, 07:00–21:00 daily (14 h), ₱500/court-hour. Edit before launch.
insert into public.clubs (id, name, timezone, currency, config) values
  ('00000000-0000-4000-8000-000000000001', 'Tira', 'Asia/Manila', 'PHP',
   '{"price_per_hour_cents": 50000,
     "prime_time": [{"days":[1,2,3,4,5],"from":"17:00","to":"21:00"},{"days":[0,6],"from":"07:00","to":"11:00"}],
     "prime_requires": "verified"}');
insert into public.courts (id, club_id, name, sort) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'Court 1', 1),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', 'Court 2', 2);
insert into public.opening_hours (club_id, weekday, opens, closes)
select '00000000-0000-4000-8000-000000000001', d, '07:00', '21:00' from generate_series(0, 6) d;
