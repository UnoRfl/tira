-- Guests on PH mobile data share one public IP (carrier NAT), so one-hold-per-IP blocked
-- strangers on the same network. Now: still 1 live hold per device, but up to 2 live guest holds
-- per IP, and 8 (was 3) guest holds per IP per 10 minutes. Guests still can't touch prime time,
-- holds last 3 minutes, and signed-in players are unaffected.
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
               where b.contact_id is null and cb.status = 'held' and cb.hold_expires_at > now() and b.device_hash = v_dev)
       or (v_ip is not null and (select count(*) from public.bookings b join public.court_blocks cb on cb.ref_id = b.id and cb.kind = 'booking'
               where b.contact_id is null and cb.status = 'held' and cb.hold_expires_at > now() and b.ip_hash = v_ip)
           >= coalesce((cfg->>'guest_live_holds_per_ip')::int, 2)) then
      raise exception 'one_hold_at_a_time';
    end if;
    if v_ip is not null and (select count(*) from public.bookings
        where ip_hash = v_ip and contact_id is null and created_at > now() - interval '10 minutes')
        >= coalesce((cfg->>'guest_holds_per_ip_10min')::int, 8) then
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
