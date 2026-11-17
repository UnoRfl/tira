-- Fixes from the 2026-11-18 review.
-- 1. Booking window counts calendar days in the club's timezone ("3 days ahead" = today + 3 whole days),
--    matching the day picker. It used to be a rolling 72 h, so the last open day was mostly unbookable.
-- 2. Guests can release their own hold (closing the sheet), and a new hold from the same device
--    replaces the old one instead of failing with one_hold_at_a_time. Players too: a new hold
--    drops their own older unconfirmed one (after a refresh or Back the old sheet is gone).
-- 3. Staff can void a checked-in booking; players need a profile to cancel anything.
-- 4. A desk booking for later is 'confirmed', not checked in on the spot.
-- 5. check_in / review_booking say not_found for an unknown id instead of silently doing nothing.

create or replace function public._in_window(p_club uuid, p_slot tstzrange, p_member boolean) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select (lower(p_slot) at time zone public._tz(p_club))::date
      <= (now() at time zone public._tz(p_club))::date
         + (public._cfg(p_club)->>(case when p_member then 'member_window_days' else 'public_window_days' end))::int
$$;

create or replace function public._release_guest_hold(p_booking uuid) returns void
language sql volatile set search_path = public, pg_temp as $$
  update public.court_blocks set status = 'released', hold_expires_at = null
  where ref_id = p_booking and kind = 'booking' and status = 'held';
  update public.bookings set status = 'cancelled' where id = p_booking and status = 'held';
$$;

create or replace function public.release_hold(p_booking uuid, p_device_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if p_device_token is null or length(p_device_token) < 16 then raise exception 'not_yours'; end if;
  if not exists (select 1 from public.bookings where id = p_booking and contact_id is null
                 and device_hash = public._hash(p_device_token)) then
    raise exception 'not_yours';
  end if;
  perform public._release_guest_hold(p_booking);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public._check_rules(c public.contacts, p_club uuid, p_slot tstzrange, p_exclude uuid)
returns void language plpgsql stable set search_path = public, pg_temp as $$
declare cfg jsonb := public._cfg(p_club); tz text := public._tz(p_club); mem boolean := public._is_member(c);
        n int; mins int;
begin
  if c.banned_until is not null and c.banned_until > now() then raise exception 'banned'; end if;
  if public._strikes(c.id, p_club) >= (cfg->>'strikes_ban_threshold')::int then raise exception 'banned'; end if;
  if not public._in_window(p_club, p_slot, mem) then
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
    -- one booking in progress per player: a new pick drops their older unconfirmed hold (refresh, back, closed tab)
    perform public._release_guest_hold(b.id) from public.bookings b
      where b.contact_id = c.id and b.status = 'held';
    perform public._check_rules(c, v_club, v_slot, null);
    if (select count(*) from public.bookings where contact_id = c.id and created_at > now() - interval '1 minute')
       >= (cfg->>'holds_per_min_per_contact')::int then raise exception 'slow_down'; end if;
    v_ttl := (cfg->>'hold_minutes')::int;
  else
    if public._is_prime(v_club, v_slot) then raise exception 'verify_for_prime'; end if;
    if not public._in_window(v_club, v_slot, false) then
      raise exception 'outside_window';
    end if;
    -- a guest who closed the sheet and picks again replaces their own earlier hold
    perform public._release_guest_hold(b.id) from public.bookings b
      join public.court_blocks cb on cb.ref_id = b.id and cb.kind = 'booking'
      where b.contact_id is null and b.device_hash = v_dev and b.status = 'held' and cb.status = 'held';
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

create or replace function public.cancel_booking(p_booking uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c public.contacts := public._my_contact(); b public.bookings; staff boolean := public._is_staff();
begin
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null or (not staff and (c.id is null or b.contact_id is distinct from c.id)) then raise exception 'not_yours'; end if;
  -- staff may also void a checked-in booking (e.g. a walk-in typed by mistake)
  if b.status not in ('held','confirmed') and not (staff and b.status = 'checked_in') then raise exception 'cannot_cancel'; end if;
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
  values (public._new_ref(v_club), v_club, cid, p_court, v_slot,
          case when lower(v_slot) <= now() + make_interval(mins => (public._cfg(v_club)->>'no_show_grace_min')::int)
               then 'checked_in' else 'confirmed' end, public._price(v_club, v_slot),
          (select currency from public.clubs where id = v_club), p_client_request_id, 'desk', auth.uid())
  returning id into v_id;
  insert into public.court_blocks (club_id, court_id, slot, kind, status, ref_id)
  values (v_club, p_court, v_slot, 'booking', 'active', v_id);
  perform public._audit(v_club, 'walk_in', v_id);
  return public._booking_json(v_id, true);
end $$;

create or replace function public.check_in(p_booking uuid, p_paid boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  perform public._require_staff();
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'not_found'; end if;
  if b.status not in ('confirmed','needs_review','checked_in') then raise exception 'cannot_check_in'; end if;
  update public.bookings set status = 'checked_in',
         paid_status = case when p_paid and paid_status = 'unpaid' then 'paid_desk' else paid_status end
  where id = b.id;
  perform public._audit(b.club_id, 'check_in', b.id, jsonb_build_object('paid', p_paid));
  return public._booking_json(b.id, true);
end $$;

create or replace function public.review_booking(p_booking uuid, p_no_show boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.bookings;
begin
  perform public._require_staff();
  select * into b from public.bookings where id = p_booking for update;
  if b.id is null then raise exception 'not_found'; end if;
  if b.status <> 'needs_review' then raise exception 'not_in_review'; end if;
  update public.bookings set status = case when p_no_show then 'no_show' else 'completed' end where id = b.id;
  perform public._audit(b.club_id, case when p_no_show then 'no_show' else 'attended' end, b.id);
  return public._booking_json(b.id, true);
end $$;

revoke all on function public._in_window(uuid, tstzrange, boolean), public._release_guest_hold(uuid),
  public.release_hold(uuid, text) from public, anon, authenticated;
grant execute on function public.release_hold(uuid, text) to anon, authenticated;
