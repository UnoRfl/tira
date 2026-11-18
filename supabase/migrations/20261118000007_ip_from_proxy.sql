-- Guest limits (1 open hold per IP, 3 holds per IP per 10 min) keyed on the FIRST
-- X-Forwarded-For entry, which the visitor writes. Checked live 2026-11-18: a request
-- sent with "X-Forwarded-For: 6.6.6.6, 7.7.7.7" reaches Postgres as
-- "6.6.6.6, 7.7.7.7,<real ip>", and Cloudflare sets cf-connecting-ip to the real ip
-- (a client-sent CF-Connecting-IP is refused with error 1000).
-- Trust cf-connecting-ip, else the LAST X-Forwarded-For entry (the one the proxy appended).
create or replace function public._ip_hash() returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare hdr json; h text; parts text[];
begin
  hdr := nullif(current_setting('request.headers', true), '')::json;
  h := nullif(trim(hdr->>'cf-connecting-ip'), '');
  if h is null then
    parts := string_to_array(coalesce(hdr->>'x-forwarded-for', ''), ',');
    h := nullif(trim(parts[array_upper(parts, 1)]), '');
  end if;
  return case when h is null then null else public._hash(h) end;
end $$;

revoke all on function public._ip_hash() from public, anon, authenticated;
