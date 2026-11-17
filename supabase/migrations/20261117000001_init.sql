-- Court booking — Phase 1 core (PLAN.md §4, §5, §6, §8)
-- All writes go through the security-definer functions at the bottom.
-- Tables have RLS on and no policies: clients never touch them directly.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ───────────────────────── tables ─────────────────────────

create table public.clubs (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  timezone  text not null default 'Asia/Manila',
  currency  text not null default 'PHP',
  config    jsonb not null default '{}'::jsonb
);

create table public.courts (
  id       uuid primary key default gen_random_uuid(),
  club_id  uuid not null references public.clubs(id),
  name     text not null,
  kind     text not null default 'pickleball',
  sort     int  not null default 0,
  active   boolean not null default true
);

create table public.opening_hours (
  id       uuid primary key default gen_random_uuid(),
  club_id  uuid not null references public.clubs(id),
  weekday  smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  opens    time not null,
  closes   time not null,
  check (closes > opens),
  unique (club_id, weekday)
);

create table public.contacts (
  id            uuid primary key default gen_random_uuid(),
  club_id       uuid not null references public.clubs(id),
  name          text not null default '',
  email         text,
  phone         text,
  verified_at   timestamptz,
  banned_until  timestamptz,
  member_type   text not null default 'none' check (member_type in ('none','member')),
  member_until  date,
  member_ref    text,
  consent_at    timestamptz,
  source        text not null default 'online' check (source in ('online','desk','import')),
  created_at    timestamptz not null default now()
);
create unique index contacts_club_email on public.contacts (club_id, lower(email)) where email is not null;

create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id),
  role        text not null default 'player' check (role in ('player','staff','owner'))
);

create table public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  ref_code           text not null,
  club_id            uuid not null references public.clubs(id),
  contact_id         uuid references public.contacts(id),
  device_hash        text,
  ip_hash            text,
  court_id           uuid not null references public.courts(id),
  slot               tstzrange not null,
  status             text not null default 'held' check (status in
                       ('held','confirmed','checked_in','completed','cancelled','expired','no_show','needs_review')),
  price_cents        int  not null,
  currency           text not null,
  price_locked_at    timestamptz not null default now(),
  paid_status        text not null default 'unpaid' check (paid_status in ('unpaid','paid_desk','paid_online','refunded','free')),
  client_request_id  uuid not null,
  source             text not null default 'online' check (source in ('online','desk','import')),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  check (contact_id is not null or device_hash is not null),
  unique (club_id, ref_code)
);
create unique index bookings_idem on public.bookings (coalesce(contact_id::text, device_hash), client_request_id);
create index bookings_contact on public.bookings (contact_id);
create index bookings_club_start on public.bookings (club_id, lower(slot));

-- The one guarantee (§4): every state that occupies a court competes.
create table public.court_blocks (
  id               uuid primary key default gen_random_uuid(),
  club_id          uuid not null references public.clubs(id),
  court_id         uuid not null references public.courts(id),
  slot             tstzrange not null check (not isempty(slot) and lower_inc(slot) and not upper_inc(slot)),
  kind             text not null check (kind in ('booking','blackout','session','waitlist_offer')),
  status           text not null check (status in ('held','active','released')),
  hold_expires_at  timestamptz,
  ref_id           uuid,
  created_at       timestamptz not null default now(),
  constraint hold_has_expiry check ((status = 'held') = (hold_expires_at is not null)),
  constraint no_overlap exclude using gist (court_id extensions.gist_uuid_ops with =, slot with &&)
    where (status in ('held','active'))
);
create index court_blocks_ref on public.court_blocks (ref_id);

create table public.blackouts (
  id          uuid primary key default gen_random_uuid(),
  club_id     uuid not null references public.clubs(id),
  reason      text not null,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- Outbox: an Edge Function sends these (email/SMS). Rows are written in the same transaction.
create table public.notifications (
  id          bigint generated always as identity primary key,
  club_id     uuid not null references public.clubs(id),
  contact_id  uuid references public.contacts(id),
  booking_id  uuid references public.bookings(id),
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create table public.audit_log (
  id      bigint generated always as identity primary key,
  club_id uuid,
  actor   uuid,
  action  text not null,
  ref     uuid,
  detail  jsonb not null default '{}'::jsonb,
  at      timestamptz not null default now()
);

alter table public.clubs          enable row level security;
alter table public.courts         enable row level security;
alter table public.opening_hours  enable row level security;
alter table public.contacts       enable row level security;
alter table public.profiles       enable row level security;
alter table public.bookings       enable row level security;
alter table public.court_blocks   enable row level security;
alter table public.blackouts      enable row level security;
alter table public.notifications  enable row level security;
alter table public.audit_log      enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ───────────────────────── helpers (no grants) ─────────────────────────

create or replace function public._cfg(p_club uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select '{
    "member_window_days": 7, "public_window_days": 3,
    "hold_minutes": 5, "pre_verify_hold_min": 3,
    "slot_minutes": [60, 90], "start_granularity_min": 30,
    "max_active_per_contact": 3, "max_minutes_per_day": 120,
    "holds_per_min_per_contact": 5, "unverified_holds_per_ip_10min": 3,
    "price_per_hour_cents": 50000, "rates": [],
    "prime_time": [], "prime_requires": "verified",
    "cancel_cutoff_min": 240, "no_show_grace_min": 15,
    "strikes_ban_threshold": 3, "strike_days": 90,
    "otp_channel": "email"
  }'::jsonb || coalesce((select config from public.clubs where id = p_club), '{}'::jsonb)
$$;

create or replace function public._tz(p_club uuid) returns text
language sql stable set search_path = public, pg_temp as $$
  select timezone from public.clubs where id = p_club
$$;

create or replace function public._my_contact() returns public.contacts
language sql stable security definer set search_path = public, pg_temp as $$
  select c.* from public.profiles p join public.contacts c on c.id = p.contact_id where p.id = auth.uid()
$$;

create or replace function public._is_staff() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('staff','owner'))
$$;

create or replace function public._require_staff() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public._is_staff() then raise exception 'staff_only' using errcode = '42501'; end if;
end $$;

create or replace function public._is_member(c public.contacts) returns boolean
language sql immutable as $$
  select c.member_type = 'member' and (c.member_until is null or c.member_until >= current_date)
$$;

create or replace function public._strikes(p_contact uuid, p_club uuid) returns int
language sql stable set search_path = public, pg_temp as $$
  select count(*)::int from public.bookings
  where contact_id = p_contact and status = 'no_show'
    and upper(slot) > now() - make_interval(days => (public._cfg(p_club)->>'strike_days')::int)
$$;

create or replace function public._hash(p text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create or replace function public._ip_hash() returns text
language plpgsql stable as $$
declare h text;
begin
  h := nullif(trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ''), ',', 1)), '');
  return case when h is null then null else public._hash(h) end;
end $$;

-- Prime if any 15-minute segment of the slot falls inside a prime_time window.
create or replace function public._is_prime(p_club uuid, p_slot tstzrange) returns boolean
language plpgsql stable set search_path = public, pg_temp as $$
declare r jsonb; t timestamptz; tz text := public._tz(p_club); lt timestamp;
begin
  for r in select * from jsonb_array_elements(public._cfg(p_club)->'prime_time') loop
    t := lower(p_slot);
    while t < upper(p_slot) loop
      lt := t at time zone tz;
      if extract(dow from lt)::int in (select jsonb_array_elements_text(r->'days')::int)
         and lt::time >= (r->>'from')::time and lt::time < (r->>'to')::time then
        return true;
      end if;
      t := t + interval '15 minutes';
    end loop;
  end loop;
  return false;
end $$;

-- Price summed per 15-minute segment (§4) so peak/member rates are config, not code.
create or replace function public._price(p_club uuid, p_slot tstzrange) returns int
language plpgsql stable set search_path = public, pg_temp as $$
declare cfg jsonb := public._cfg(p_club); tz text := public._tz(p_club);
        t timestamptz := lower(p_slot); lt timestamp; total int := 0; rate int; r jsonb;
begin
  while t < upper(p_slot) loop
    lt := t at time zone tz;
    rate := (cfg->>'price_per_hour_cents')::int;
    for r in select * from jsonb_array_elements(cfg->'rates') loop
      if extract(dow from lt)::int in (select jsonb_array_elements_text(r->'days')::int)
         and lt::time >= (r->>'from')::time and lt::time < (r->>'to')::time then
        rate := (r->>'per_hour_cents')::int; exit;
      end if;
    end loop;
    total := total + rate / 4;
    t := t + interval '15 minutes';
  end loop;
  return total;
end $$;

create or replace function public._new_ref(p_club uuid) returns text
language plpgsql volatile set search_path = public, pg_temp as $$
declare a text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; r text; i int;
begin
  loop
    r := '';
    for i in 1..6 loop r := r || substr(a, 1 + floor(random() * length(a))::int, 1); end loop;
    exit when not exists (select 1 from public.bookings where club_id = p_club and ref_code = r);
  end loop;
  return r;
end $$;

-- Validates court, length, alignment, opening hours; returns the half-open range.
create or replace function public._check_slot(p_club uuid, p_court uuid, p_start timestamptz, p_minutes int, p_staff boolean)
returns tstzrange language plpgsql stable set search_path = public, pg_temp as $$
declare cfg jsonb := public._cfg(p_club); tz text := public._tz(p_club);
        lt timestamp := p_start at time zone tz; oh public.opening_hours; s tstzrange;
begin
  if not exists (select 1 from public.courts where id = p_court and club_id = p_club and active) then
    raise exception 'bad_court';
  end if;
  if not (cfg->'slot_minutes') @> to_jsonb(p_minutes) then raise exception 'bad_length'; end if;
  if extract(second from lt) <> 0
     or (extract(hour from lt) * 60 + extract(minute from lt))::int % (cfg->>'start_granularity_min')::int <> 0 then
    raise exception 'bad_start';
  end if;
  s := tstzrange(p_start, p_start + make_interval(mins => p_minutes), '[)');
  if p_staff then
    if upper(s) <= now() then raise exception 'in_the_past'; end if;
  elsif lower(s) < now() then
    raise exception 'in_the_past';
  end if;
  select * into oh from public.opening_hours where club_id = p_club and weekday = extract(dow from lt)::int;
  if oh.id is null
     or lower(s) < ((lt::date + oh.opens) at time zone tz)
     or upper(s) > ((lt::date + oh.closes) at time zone tz) then
    raise exception 'closed';
  end if;
  return s;
end $$;

-- Player rules (§8). Raises on the first failure.
create or replace function public._check_rules(c public.contacts, p_club uuid, p_slot tstzrange, p_exclude uuid)
returns void language plpgsql stable set search_path = public, pg_temp as $$
declare cfg jsonb := public._cfg(p_club); tz text := public._tz(p_club); mem boolean := public._is_member(c);
        n int; mins int;
begin
  if c.banned_until is not null and c.banned_until > now() then raise exception 'banned'; end if;
  if public._strikes(c.id, p_club) >= (cfg->>'strikes_ban_threshold')::int then raise exception 'banned'; end if;
  if lower(p_slot) > now() + make_interval(days =>
       (case when mem then cfg->>'member_window_days' else cfg->>'public_window_days' end)::int) then
    raise exception 'outside_window';
  end if;
  if cfg->>'prime_requires' = 'member' and not mem and public._is_prime(p_club, p_slot) then
    raise exception 'members_only';
  end if;
  select count(*), coalesce(sum(extract(epoch from upper(cb.slot) - lower(cb.slot)) / 60) filter (
           where (lower(cb.slot) at time zone tz)::date = (lower(p_slot) at time zone tz)::date), 0)
    into n, mins
  from public.court_blocks cb join public.bookings b on b.id = cb.ref_id
  where cb.kind = 'booking' and cb.status in ('held','active')
    and (cb.hold_expires_at is null or cb.hold_expires_at > now())
    and upper(cb.slot) > now() and b.contact_id = c.id and b.id is distinct from p_exclude;
  if n >= (cfg->>'max_active_per_contact')::int then raise exception 'too_many_active'; end if;
  if mins + extract(epoch from upper(p_slot) - lower(p_slot)) / 60 > (cfg->>'max_minutes_per_day')::int then
    raise exception 'daily_limit';
  end if;
end $$;

create or replace function public._lazy_expire(p_court uuid, p_slot tstzrange) returns void
language sql volatile set search_path = public, pg_temp as $$
  with rel as (
    update public.court_blocks set status = 'released', hold_expires_at = null
    where court_id = p_court and status = 'held' and hold_expires_at < now() and slot && p_slot
    returning ref_id, kind
  )
  update public.bookings set status = 'expired'
  where id in (select ref_id from rel where kind = 'booking') and status = 'held'
$$;

create or replace function public._booking_json(p_id uuid, p_with_contact boolean default false) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', b.id, 'ref_code', b.ref_code, 'status', b.status,
    'court_id', b.court_id, 'court_name', ct.name,
    'start', lower(b.slot), 'end', upper(b.slot),
    'price_cents', b.price_cents, 'currency', b.currency, 'paid_status', b.paid_status,
    'source', b.source,
    'hold_expires_at', (select cb.hold_expires_at from public.court_blocks cb
                        where cb.ref_id = b.id and cb.kind = 'booking' and cb.status = 'held' limit 1)
  ) || case when p_with_contact then jsonb_build_object(
    'contact_id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone,
    'is_member', coalesce(public._is_member(c), false),
    'strikes', case when c.id is null then 0 else public._strikes(c.id, b.club_id) end)
  else '{}'::jsonb end
  from public.bookings b
  join public.courts ct on ct.id = b.court_id
  left join public.contacts c on c.id = b.contact_id
  where b.id = p_id
$$;

create or replace function public._audit(p_club uuid, p_action text, p_ref uuid, p_detail jsonb default '{}'::jsonb)
returns void language sql volatile set search_path = public, pg_temp as $$
  insert into public.audit_log (club_id, actor, action, ref, detail) values (p_club, auth.uid(), p_action, p_ref, p_detail)
$$;

create or replace function public._notify(p_booking uuid, p_kind text, p_payload jsonb default '{}'::jsonb)
returns void language sql volatile set search_path = public, pg_temp as $$
  insert into public.notifications (club_id, contact_id, booking_id, kind, payload)
  select club_id, contact_id, id, p_kind, p_payload || public._booking_json(id) from public.bookings where id = p_booking
$$;

-- ───────────────────────── public reads ─────────────────────────

create or replace function public.club_info(p_club uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', cl.id, 'name', cl.name, 'timezone', cl.timezone, 'currency', cl.currency,
    'price_per_hour_cents', cfg->'price_per_hour_cents', 'slot_minutes', cfg->'slot_minutes',
    'granularity', cfg->'start_granularity_min', 'public_window_days', cfg->'public_window_days',
    'member_window_days', cfg->'member_window_days', 'otp_channel', cfg->'otp_channel',
    'cancel_cutoff_min', cfg->'cancel_cutoff_min',
    'courts', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort, name), '[]')
               from public.courts where club_id = cl.id and active))
  from public.clubs cl, lateral (select public._cfg(cl.id) as cfg) x
  where p_club is null or cl.id = p_club
  order by cl.name limit 1
$$;

-- Occupied ranges per court (no names) + opening hours + prime cells. The client paints 30-min cells.
create or replace function public.availability(p_club uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text := public._tz(p_club); cfg jsonb := public._cfg(p_club); oh public.opening_hours;
        o timestamptz; cl timestamptz; me uuid := (public._my_contact()).id; prime jsonb := '[]'; t timestamptz;
        g interval := make_interval(mins => (cfg->>'start_granularity_min')::int);
begin
  select * into oh from public.opening_hours where club_id = p_club and weekday = extract(dow from p_date)::int;
  if oh.id is null then return jsonb_build_object('closed', true, 'date', p_date, 'courts', '[]'::jsonb, 'now', now()); end if;
  o := (p_date + oh.opens) at time zone tz;
  cl := (p_date + oh.closes) at time zone tz;
  t := o;
  while t < cl loop
    if public._is_prime(p_club, tstzrange(t, t + g)) then prime := prime || to_jsonb(t); end if;
    t := t + g;
  end loop;
  return jsonb_build_object(
    'closed', false, 'date', p_date, 'opens', o, 'closes', cl, 'now', now(), 'prime', prime,
    'courts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', ct.id, 'name', ct.name,
        'occupied', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'start', lower(cb.slot), 'end', upper(cb.slot),
            'kind', cb.kind, 'held', cb.status = 'held',
            'mine', me is not null and b.contact_id = me,
            'booking_id', case when me is not null and b.contact_id = me then b.id end
          ) order by lower(cb.slot)), '[]')
          from public.court_blocks cb left join public.bookings b on b.id = cb.ref_id and cb.kind = 'booking'
          where cb.court_id = ct.id and cb.status in ('held','active')
            and (cb.hold_expires_at is null or cb.hold_expires_at > now())
            and cb.slot && tstzrange(o, cl))
      ) order by ct.sort, ct.name), '[]')
      from public.courts ct where ct.club_id = p_club and ct.active));
end $$;

-- ───────────────────────── player writes ─────────────────────────

create or replace function public.hold_slot(p_court uuid, p_start timestamptz, p_minutes int,
                                            p_client_request_id uuid, p_device_token text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_club uuid; cfg jsonb; v_slot tstzrange; c public.contacts; v_dev text; v_ip text; v_key text;
        v_existing uuid; v_ttl int; v_id uuid;
begin
  select club_id into v_club from public.courts where id = p_court and active;
  if v_club is null then raise exception 'bad_court'; end if;
  cfg := public._cfg(v_club);
  c := public._my_contact();

  if c.id is null then
    if p_device_token is null or length(p_device_token) < 16 then raise exception 'sign_in_required'; end if;
    v_dev := public._hash(p_device_token);
    v_key := v_dev;
  else
    v_key := c.id::text;
  end if;

  -- 1. idempotency
  select id into v_existing from public.bookings
  where coalesce(contact_id::text, device_hash) = v_key and client_request_id = p_client_request_id;
  if v_existing is not null then return public._booking_json(v_existing); end if;

  v_slot := public._check_slot(v_club, p_court, p_start, p_minutes, false);
  v_ip := public._ip_hash();

  -- 2. who's asking
  if c.id is not null then
    if c.verified_at is null then raise exception 'not_verified'; end if;
    perform public._check_rules(c, v_club, v_slot, null);
    if (select count(*) from public.bookings where contact_id = c.id and created_at > now() - interval '1 minute')
       >= (cfg->>'holds_per_min_per_contact')::int then raise exception 'slow_down'; end if;
    v_ttl := (cfg->>'hold_minutes')::int;
  else
    if public._is_prime(v_club, v_slot) then raise exception 'verify_for_prime'; end if;
    if lower(v_slot) > now() + make_interval(days => (cfg->>'public_window_days')::int) then
      raise exception 'outside_window';
    end if;
    if exists (select 1 from public.bookings b join public.court_blocks cb on cb.ref_id = b.id and cb.kind = 'booking'
               where b.contact_id is null and cb.status = 'held' and cb.hold_expires_at > now()
                 and (b.device_hash = v_dev or (v_ip is not null and b.ip_hash = v_ip))) then
      raise exception 'one_hold_at_a_time';
    end if;
    if v_ip is not null and (select count(*) from public.bookings
        where ip_hash = v_ip and contact_id is null and created_at > now() - interval '10 minutes')
        >= (cfg->>'unverified_holds_per_ip_10min')::int then
      raise exception 'slow_down';
    end if;
    v_ttl := (cfg->>'pre_verify_hold_min')::int;
  end if;

  -- 3. lazy expiry, 4. insert (23P01 on overlap rolls the whole call back)
  perform public._lazy_expire(p_court, v_slot);
  insert into public.bookings (ref_code, club_id, contact_id, device_hash, ip_hash, court_id, slot, status,
                               price_cents, currency, client_request_id, source, created_by)
  values (public._new_ref(v_club), v_club, c.id, v_dev, v_ip, p_court, v_slot, 'held',
          public._price(v_club, v_slot), (select currency from public.clubs where id = v_club),
          p_client_request_id, 'online', auth.uid())
  returning id into v_id;
  insert into public.court_blocks (club_id, court_id, slot, kind, status, hold_expires_at, ref_id)
  values (v_club, p_court, v_slot, 'booking', 'held', now() + make_interval(mins => v_ttl), v_id);
  return public._booking_json(v_id);
end $$;

-- After a guest verifies: run the full rule check, then extend the hold. On failure the hold is released.
create or replace function public.attach_contact(p_booking uuid, p_device_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c public.contacts := public._my_contact(); b public.bookings; err text;
begin
  if c.id is null then raise exception 'sign_in_required'; end if;
  if c.verified_at is null then raise exception 'not_verified'; end if;
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or b.contact_id is not null or b.device_hash is distinct from public._hash(p_device_token) then
    raise exception 'not_yours';
  end if;
  if b.status <> 'held' or not exists (select 1 from public.court_blocks where ref_id = b.id and kind = 'booking'
                                       and status = 'held' and hold_expires_at > now()) then
    raise exception 'hold_expired';
  end if;
  begin
    perform public._check_rules(c, b.club_id, b.slot, b.id);
  exception when raise_exception then
    err := sqlerrm;
  end;
  if err is not null then
    update public.court_blocks set status = 'released', hold_expires_at = null where ref_id = b.id and status = 'held';
    update public.bookings set status = 'cancelled' where id = b.id;
    return jsonb_build_object('error', err);
  end if;
  update public.bookings set contact_id = c.id where id = b.id;
  update public.court_blocks set hold_expires_at = now() + make_interval(mins => (public._cfg(b.club_id)->>'hold_minutes')::int)
  where ref_id = b.id and kind = 'booking' and status = 'held';
  return public._booking_json(b.id);
end $$;

-- Pay-at-desk or free only. Paid online bookings are confirmed by the payment webhook (Phase 2).
create or replace function public.confirm_booking(p_booking uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c public.contacts := public._my_contact(); b public.bookings;
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or (b.contact_id is distinct from c.id and not public._is_staff()) then raise exception 'not_yours'; end if;
  if b.status = 'confirmed' then return public._booking_json(b.id); end if;
  if b.status <> 'held' then raise exception 'hold_expired'; end if;
  if b.contact_id is null then raise exception 'sign_in_required'; end if;
  update public.court_blocks set status = 'active', hold_expires_at = null
  where ref_id = b.id and kind = 'booking' and status = 'held' and hold_expires_at > now();
  if not found then raise exception 'hold_expired'; end if;
  update public.bookings set status = 'confirmed',
         paid_status = case when price_cents = 0 then 'free' else 'unpaid' end
  where id = b.id;
  perform public._notify(b.id, 'booking_confirmed');
  perform public._audit(b.club_id, 'confirm', b.id);
  return public._booking_json(b.id);
end $$;

create or replace function public.cancel_booking(p_booking uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c public.contacts := public._my_contact(); b public.bookings; staff boolean := public._is_staff();
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or (b.contact_id is distinct from c.id and not staff) then raise exception 'not_yours'; end if;
  if b.status not in ('held','confirmed') then raise exception 'cannot_cancel'; end if;
  if b.status = 'confirmed' and not staff
     and lower(b.slot) - now() < make_interval(mins => (public._cfg(b.club_id)->>'cancel_cutoff_min')::int) then
    raise exception 'past_cutoff';
  end if;
  update public.court_blocks set status = 'released', hold_expires_at = null
  where ref_id = b.id and kind = 'booking' and status in ('held','active');
  update public.bookings set status = 'cancelled' where id = b.id;
  if b.status = 'confirmed' then
    perform public._notify(b.id, case when staff and b.contact_id is distinct from c.id then 'cancelled_by_club' else 'cancelled' end);
  end if;
  perform public._audit(b.club_id, 'cancel', b.id);
  return public._booking_json(b.id);
end $$;

-- ───────────────────────── account ─────────────────────────

create or replace function public.ensure_profile(p_club uuid, p_name text, p_phone text default null, p_consent boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); em text := lower(auth.jwt()->>'email'); cid uuid; consent timestamptz;
begin
  if uid is null or em is null then raise exception 'sign_in_required'; end if;
  select contact_id into cid from public.profiles where id = uid;
  if cid is null then
    select id, consent_at into cid, consent from public.contacts where club_id = p_club and lower(email) = em;
    if consent is null and not p_consent then raise exception 'consent_required'; end if;
    if cid is null then
      insert into public.contacts (club_id, name, email, phone, verified_at, consent_at)
      values (p_club, coalesce(nullif(trim(p_name), ''), split_part(em, '@', 1)), em, nullif(trim(p_phone), ''), now(), now())
      returning id into cid;
    else
      update public.contacts set verified_at = coalesce(verified_at, now()), consent_at = coalesce(consent_at, now()),
             name = case when name = '' then coalesce(nullif(trim(p_name), ''), name) else name end,
             phone = coalesce(phone, nullif(trim(p_phone), ''))
      where id = cid;
    end if;
    insert into public.profiles (id, contact_id) values (uid, cid);
  else
    select consent_at into consent from public.contacts where id = cid;
    if consent is null and not p_consent then raise exception 'consent_required'; end if;
    update public.contacts set consent_at = coalesce(consent_at, now()), verified_at = coalesce(verified_at, now()),
           name = coalesce(nullif(trim(p_name), ''), name)
    where id = cid;
  end if;
  return public.me();
end $$;

create or replace function public.me() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.id is null then jsonb_build_object('user_id', auth.uid(), 'profile', false)
  else jsonb_build_object(
    'user_id', p.id, 'profile', true, 'role', p.role,
    'contact', jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone,
      'is_member', public._is_member(c), 'member_until', c.member_until,
      'strikes', public._strikes(c.id, c.club_id), 'needs_consent', c.consent_at is null))
  end
  from (select auth.uid() as uid) u
  left join public.profiles p on p.id = u.uid
  left join public.contacts c on c.id = p.contact_id
$$;

create or replace function public.my_bookings() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public._booking_json(b.id) order by lower(b.slot) desc), '[]')
  from (select id, slot from public.bookings
        where contact_id = (public._my_contact()).id and status <> 'expired'
        order by lower(slot) desc limit 50) b
$$;

-- ───────────────────────── desk (staff) ─────────────────────────

create or replace function public.sweep() returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n_exp int; n_rev int; n_done int;
begin
  with rel as (
    update public.court_blocks set status = 'released', hold_expires_at = null
    where status = 'held' and hold_expires_at < now() returning ref_id, kind
  ), b as (
    update public.bookings set status = 'expired'
    where id in (select ref_id from rel where kind = 'booking') and status = 'held' returning 1
  ) select count(*) into n_exp from b;
  update public.bookings b set status = 'needs_review'
  where status = 'confirmed'
    and lower(slot) + make_interval(mins => (public._cfg(b.club_id)->>'no_show_grace_min')::int) < now();
  get diagnostics n_rev = row_count;
  update public.bookings set status = 'completed' where status = 'checked_in' and upper(slot) < now();
  get diagnostics n_done = row_count;
  return jsonb_build_object('expired', n_exp, 'needs_review', n_rev, 'completed', n_done);
end $$;

create or replace function public.desk_day(p_club uuid, p_date date) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare tz text := public._tz(p_club); d0 timestamptz; d1 timestamptz;
begin
  perform public._require_staff();
  perform public.sweep();
  d0 := p_date::timestamp at time zone tz;
  d1 := (p_date + 1)::timestamp at time zone tz;
  return jsonb_build_object(
    'bookings', (select coalesce(jsonb_agg(public._booking_json(id, true) order by lower(slot), court_id), '[]')
                 from public.bookings where club_id = p_club and slot && tstzrange(d0, d1)
                   and status not in ('expired','cancelled')),
    'blackouts', (select coalesce(jsonb_agg(jsonb_build_object('court_id', cb.court_id, 'start', lower(cb.slot),
                    'end', upper(cb.slot), 'reason', bo.reason, 'id', bo.id) order by lower(cb.slot)), '[]')
                  from public.court_blocks cb join public.blackouts bo on bo.id = cb.ref_id
                  where cb.club_id = p_club and cb.kind = 'blackout' and cb.status = 'active' and cb.slot && tstzrange(d0, d1)),
    'needs_review', (select coalesce(jsonb_agg(public._booking_json(id, true) order by lower(slot)), '[]')
                     from public.bookings where club_id = p_club and status = 'needs_review'));
end $$;

create or replace function public.desk_lookup(p_club uuid, p_ref text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  perform public._require_staff();
  select id into v from public.bookings where club_id = p_club and ref_code = upper(trim(p_ref));
  if v is null then raise exception 'not_found'; end if;
  return public._booking_json(v, true);
end $$;

create or replace function public.check_in(p_booking uuid, p_paid boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  perform public._require_staff();
  select * into b from public.bookings where id = p_booking for update;
  if b.status not in ('confirmed','needs_review','checked_in') then raise exception 'cannot_check_in'; end if;
  update public.bookings set status = 'checked_in',
         paid_status = case when p_paid and paid_status = 'unpaid' then 'paid_desk' else paid_status end
  where id = b.id;
  perform public._audit(b.club_id, 'check_in', b.id, jsonb_build_object('paid', p_paid));
  return public._booking_json(b.id, true);
end $$;

-- Staff confirm no-shows (§5): no_show adds a strike (strikes = no_show bookings in the last 90 days).
create or replace function public.review_booking(p_booking uuid, p_no_show boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  perform public._require_staff();
  select * into b from public.bookings where id = p_booking for update;
  if b.status <> 'needs_review' then raise exception 'not_in_review'; end if;
  update public.bookings set status = case when p_no_show then 'no_show' else 'completed' end where id = b.id;
  perform public._audit(b.club_id, case when p_no_show then 'no_show' else 'attended' end, b.id);
  return public._booking_json(b.id, true);
end $$;

create or replace function public.walk_in(p_court uuid, p_start timestamptz, p_minutes int, p_name text,
                                          p_phone text, p_email text, p_client_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_club uuid; v_slot tstzrange; cid uuid; v_id uuid; em text := nullif(lower(trim(p_email)), '');
begin
  perform public._require_staff();
  select club_id into v_club from public.courts where id = p_court;
  if v_club is null then raise exception 'bad_court'; end if;
  if nullif(trim(p_name), '') is null then raise exception 'name_required'; end if;
  if em is not null then select id into cid from public.contacts where club_id = v_club and lower(email) = em; end if;
  if cid is null and nullif(trim(p_phone), '') is not null then
    select id into cid from public.contacts where club_id = v_club and phone = trim(p_phone) limit 1;
  end if;
  if cid is null then
    insert into public.contacts (club_id, name, email, phone, source)
    values (v_club, trim(p_name), em, nullif(trim(p_phone), ''), 'desk') returning id into cid;
  end if;
  select id into v_id from public.bookings where contact_id = cid and client_request_id = p_client_request_id;
  if v_id is not null then return public._booking_json(v_id, true); end if;
  v_slot := public._check_slot(v_club, p_court, p_start, p_minutes, true);
  perform public._lazy_expire(p_court, v_slot);
  insert into public.bookings (ref_code, club_id, contact_id, court_id, slot, status, price_cents, currency,
                               client_request_id, source, created_by)
  values (public._new_ref(v_club), v_club, cid, p_court, v_slot, 'checked_in', public._price(v_club, v_slot),
          (select currency from public.clubs where id = v_club), p_client_request_id, 'desk', auth.uid())
  returning id into v_id;
  insert into public.court_blocks (club_id, court_id, slot, kind, status, ref_id)
  values (v_club, p_court, v_slot, 'booking', 'active', v_id);
  perform public._audit(v_club, 'walk_in', v_id);
  return public._booking_json(v_id, true);
end $$;

-- Release the old block first, then insert the new one, in one transaction (§5, fix 1.2).
create or replace function public.move_booking(p_booking uuid, p_court uuid, p_start timestamptz)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.bookings; v_slot tstzrange; mins int;
begin
  perform public._require_staff();
  select * into b from public.bookings where id = p_booking for update;
  if b.status not in ('confirmed','checked_in') then raise exception 'cannot_move'; end if;
  mins := (extract(epoch from upper(b.slot) - lower(b.slot)) / 60)::int;
  v_slot := public._check_slot(b.club_id, p_court, p_start, mins, true);
  update public.court_blocks set status = 'released', hold_expires_at = null
  where ref_id = b.id and kind = 'booking' and status in ('held','active');
  perform public._lazy_expire(p_court, v_slot);
  insert into public.court_blocks (club_id, court_id, slot, kind, status, ref_id)
  values (b.club_id, p_court, v_slot, 'booking', 'active', b.id);
  update public.bookings set court_id = p_court, slot = v_slot where id = b.id;
  perform public._notify(b.id, 'moved_by_club', jsonb_build_object('from', jsonb_build_object(
    'court_id', b.court_id, 'start', lower(b.slot))));
  perform public._audit(b.club_id, 'move', b.id, jsonb_build_object('from_court', b.court_id, 'from', lower(b.slot)));
  return public._booking_json(b.id, true);
end $$;

-- Blackouts: dry run → conflict list → staff resolve → apply (§5).
create or replace function public.plan_blackout(p_club uuid, p_courts uuid[], p_start timestamptz, p_end timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r tstzrange := tstzrange(p_start, p_end, '[)');
begin
  perform public._require_staff();
  if p_end <= p_start then raise exception 'bad_range'; end if;
  return jsonb_build_object(
    'blocks', (select jsonb_agg(jsonb_build_object('court_id', c, 'start', p_start, 'end', p_end)) from unnest(p_courts) c),
    'conflicts', (select coalesce(jsonb_agg(
        case when cb.kind = 'booking' then public._booking_json(cb.ref_id, true) || jsonb_build_object('kind', 'booking')
             else jsonb_build_object('kind', cb.kind, 'court_id', cb.court_id, 'start', lower(cb.slot), 'end', upper(cb.slot)) end
        order by lower(cb.slot)), '[]')
      from public.court_blocks cb
      where cb.club_id = p_club and cb.court_id = any(p_courts) and cb.status in ('held','active')
        and (cb.hold_expires_at is null or cb.hold_expires_at > now()) and cb.slot && r));
end $$;

-- p_resolutions: [{"booking_id": uuid, "action": "cancel"} | {"booking_id": uuid, "action": "move", "court_id": uuid, "start": ts}]
-- Fails as a whole (23P01) if anything still overlaps, e.g. a booking made after the dry run.
create or replace function public.apply_blackout(p_club uuid, p_courts uuid[], p_start timestamptz, p_end timestamptz,
                                                 p_reason text, p_resolutions jsonb default '[]')
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r jsonb; v_id uuid; c uuid;
begin
  perform public._require_staff();
  if p_end <= p_start then raise exception 'bad_range'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_resolutions, '[]')) loop
    if r->>'action' = 'cancel' then
      perform public.cancel_booking((r->>'booking_id')::uuid);
    elsif r->>'action' = 'move' then
      perform public.move_booking((r->>'booking_id')::uuid, (r->>'court_id')::uuid, (r->>'start')::timestamptz);
    else
      raise exception 'bad_resolution';
    end if;
  end loop;
  insert into public.blackouts (club_id, reason, created_by) values (p_club, coalesce(nullif(trim(p_reason), ''), 'Blocked'), auth.uid())
  returning id into v_id;
  foreach c in array p_courts loop
    perform public._lazy_expire(c, tstzrange(p_start, p_end, '[)'));
    insert into public.court_blocks (club_id, court_id, slot, kind, status, ref_id)
    values (p_club, c, tstzrange(p_start, p_end, '[)'), 'blackout', 'active', v_id);
  end loop;
  perform public._audit(p_club, 'blackout', v_id, jsonb_build_object('courts', p_courts, 'start', p_start, 'end', p_end));
  return jsonb_build_object('blackout_id', v_id);
end $$;

create or replace function public.remove_blackout(p_blackout uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform public._require_staff();
  update public.court_blocks set status = 'released' where ref_id = p_blackout and kind = 'blackout' and status = 'active';
  return jsonb_build_object('ok', true);
end $$;

-- Members: set by staff only (§8).
create or replace function public.search_contacts(p_club uuid, p_q text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone,
            'is_member', public._is_member(c), 'member_until', c.member_until, 'member_ref', c.member_ref,
            'strikes', public._strikes(c.id, c.club_id), 'verified', c.verified_at is not null) order by c.name), '[]')
          from (select * from public.contacts
                where club_id = p_club and (coalesce(trim(p_q), '') = '' or name ilike '%' || trim(p_q) || '%'
                  or email ilike '%' || trim(p_q) || '%' or phone ilike '%' || trim(p_q) || '%')
                order by (member_type = 'member') desc, name limit 50) c);
end $$;

create or replace function public.set_member(p_contact uuid, p_until date, p_ref text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare cl uuid;
begin
  perform public._require_staff();
  update public.contacts set member_type = case when p_until is null then 'none' else 'member' end,
         member_until = p_until, member_ref = coalesce(nullif(trim(p_ref), ''), member_ref)
  where id = p_contact returning club_id into cl;
  if cl is null then raise exception 'not_found'; end if;
  perform public._audit(cl, 'set_member', p_contact, jsonb_build_object('until', p_until));
  return jsonb_build_object('ok', true);
end $$;

-- CSV import at launch (§12). Rows: [{name,email,phone,member_until,member_ref}]
create or replace function public.import_contacts(p_club uuid, p_rows jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r jsonb; em text; n_new int := 0; n_upd int := 0; cid uuid; mu date;
begin
  perform public._require_staff();
  for r in select * from jsonb_array_elements(p_rows) loop
    em := nullif(lower(trim(r->>'email')), '');
    mu := nullif(trim(r->>'member_until'), '')::date;
    cid := null;
    if em is not null then select id into cid from public.contacts where club_id = p_club and lower(email) = em; end if;
    if cid is null then
      insert into public.contacts (club_id, name, email, phone, member_type, member_until, member_ref, source)
      values (p_club, coalesce(trim(r->>'name'), ''), em, nullif(trim(r->>'phone'), ''),
              case when mu is null then 'none' else 'member' end, mu, nullif(trim(r->>'member_ref'), ''), 'import');
      n_new := n_new + 1;
    else
      update public.contacts set name = coalesce(nullif(trim(r->>'name'), ''), name),
             phone = coalesce(nullif(trim(r->>'phone'), ''), phone),
             member_type = case when mu is null then member_type else 'member' end,
             member_until = coalesce(mu, member_until)
      where id = cid;
      n_upd := n_upd + 1;
    end if;
  end loop;
  return jsonb_build_object('created', n_new, 'updated', n_upd);
end $$;

-- Usage + no-show report (§12): one row per day per court.
create or replace function public.usage_report(p_club uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text := public._tz(p_club);
begin
  perform public._require_staff();
  return (
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.day, x.court), '[]') from (
      select d::date as day, ct.name as court,
        coalesce(extract(epoch from (oh.closes - oh.opens)) / 60, 0)::int as open_minutes,
        coalesce((select sum(extract(epoch from upper(b.slot) - lower(b.slot)) / 60) from public.bookings b
          where b.court_id = ct.id and (lower(b.slot) at time zone tz)::date = d::date
            and b.status in ('confirmed','checked_in','completed','no_show','needs_review')), 0)::int as booked_minutes,
        (select count(*) from public.bookings b where b.court_id = ct.id and (lower(b.slot) at time zone tz)::date = d::date
            and b.status in ('confirmed','checked_in','completed','no_show','needs_review'))::int as bookings,
        (select count(*) from public.bookings b where b.court_id = ct.id and (lower(b.slot) at time zone tz)::date = d::date
            and b.status in ('confirmed','checked_in','completed','no_show','needs_review') and b.source = 'online')::int as online,
        (select count(*) from public.bookings b where b.court_id = ct.id and (lower(b.slot) at time zone tz)::date = d::date
            and b.status = 'no_show')::int as no_shows,
        coalesce((select sum(b.price_cents) from public.bookings b where b.court_id = ct.id
            and (lower(b.slot) at time zone tz)::date = d::date
            and b.status in ('confirmed','checked_in','completed','no_show','needs_review')), 0)::int as booked_cents
      from generate_series(p_from, p_to, interval '1 day') d
      cross join public.courts ct
      left join public.opening_hours oh on oh.club_id = p_club and oh.weekday = extract(dow from d)::int
      where ct.club_id = p_club and ct.active) x);
end $$;

-- ───────────────────────── grants (§10: anon EXECUTE revoked explicitly) ─────────────────────────

revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function public.club_info(uuid), public.availability(uuid, date),
  public.hold_slot(uuid, timestamptz, int, uuid, text) to anon, authenticated;

grant execute on function
  public.attach_contact(uuid, text), public.confirm_booking(uuid), public.cancel_booking(uuid),
  public.ensure_profile(uuid, text, text, boolean), public.me(), public.my_bookings(),
  public.desk_day(uuid, date), public.desk_lookup(uuid, text), public.check_in(uuid, boolean),
  public.review_booking(uuid, boolean), public.walk_in(uuid, timestamptz, int, text, text, text, uuid),
  public.move_booking(uuid, uuid, timestamptz), public.plan_blackout(uuid, uuid[], timestamptz, timestamptz),
  public.apply_blackout(uuid, uuid[], timestamptz, timestamptz, text, jsonb), public.remove_blackout(uuid),
  public.search_contacts(uuid, text), public.set_member(uuid, date, text),
  public.import_contacts(uuid, jsonb), public.usage_report(uuid, date, date)
to authenticated;
