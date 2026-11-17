alter function public._is_member(public.contacts) set search_path = public, pg_temp;
alter function public._hash(text) set search_path = public, pg_temp;
alter function public._ip_hash() set search_path = public, pg_temp;
