-- Supabase only (pg_net + pg_cron). Every minute, wake the sender with the private key.
create extension if not exists pg_net;
select cron.schedule('send-notifications', '* * * * *', $$
  select net.http_post(
    url := 'https://bloavrswkwhfrotpsswq.supabase.co/functions/v1/send-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('key', (select value from private.settings where key = 'notify_key')),
    timeout_milliseconds := 30000)
  where exists (select 1 from public.notifications where sent_at is null)
$$);
