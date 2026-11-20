-- Outbox sender (2026-11-18). The send-notifications Edge Function drains public.notifications.
-- (gen_random_uuid uses the strong RNG: 2 of them = 244 random bits.)
-- It holds no database key: every call carries a random key that lives only in private.settings,
-- and the two functions below refuse any other key. pg_cron supplies it (see ..._000006_notification_cron.sql).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (key text primary key, value text not null);
insert into private.settings (key, value)
values ('notify_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

alter table public.notifications
  add column if not exists attempts   int not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_error text;
create index if not exists notifications_pending on public.notifications (id) where sent_at is null;

create or replace function public._notify_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_key is not null and p_key = (select value from private.settings where key = 'notify_key')
$$;

-- Hands out up to p_limit unsent emails (each at most 5 tries, re-offered if a sender died mid-way).
-- Rows that can't or shouldn't go out (no email address, older than a day) are closed without sending.
create or replace function public.claim_notifications(p_key text, p_limit int default 20) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare out jsonb;
begin
  if not public._notify_key_ok(p_key) then raise exception 'bad_key' using errcode = '42501'; end if;
  update public.notifications n set sent_at = now(),
         last_error = case when c.email is null then 'no_email' else 'stale' end
  from public.notifications n2 left join public.contacts c on c.id = n2.contact_id
  where n.id = n2.id and n.sent_at is null and (c.email is null or n.created_at < now() - interval '1 day');

  with pick as (
    select id from public.notifications
    where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '5 minutes')
    order by id limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update skip locked
  ), upd as (
    update public.notifications n set claimed_at = now(), attempts = n.attempts + 1
    from pick where n.id = pick.id
    returning n.id, n.kind, n.payload, n.contact_id, n.club_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'kind', u.kind, 'payload', u.payload,
           'email', c.email, 'name', c.name, 'club', cl.name, 'timezone', cl.timezone) order by u.id), '[]')
    into out
  from upd u join public.contacts c on c.id = u.contact_id join public.clubs cl on cl.id = u.club_id;
  return out;
end $$;

-- p_error null = sent. Otherwise the row is released for another try next run.
create or replace function public.finish_notification(p_key text, p_id bigint, p_error text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if not public._notify_key_ok(p_key) then raise exception 'bad_key' using errcode = '42501'; end if;
  if p_error is null then
    update public.notifications set sent_at = now(), last_error = null where id = p_id and sent_at is null;
  else
    update public.notifications set claimed_at = null, last_error = left(p_error, 500) where id = p_id and sent_at is null;
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public._notify_key_ok(text), public.claim_notifications(text, int),
  public.finish_notification(text, bigint, text) from public, anon, authenticated;
-- callable over the API, but useless without the key
grant execute on function public.claim_notifications(text, int), public.finish_notification(text, bigint, text) to anon, authenticated;
