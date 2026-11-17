-- Supabase only (pg_cron). Swept expiry, needs_review and completion every minute.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('court-sweep', '* * * * *', $$select public.sweep()$$);
