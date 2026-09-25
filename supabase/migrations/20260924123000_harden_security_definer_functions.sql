-- Clears the Supabase security advisor warnings (applied 2026-09-24).

-- 1) handle_new_user only runs as the auth.users trigger; nobody should call it via the API.
--    (Trigger firing does not check EXECUTE, so sign-ups keep working.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 2) is_admin: keep the SECURITY DEFINER logic in a schema the API does not expose,
--    and leave public.is_admin() as a SECURITY INVOKER wrapper so existing RLS
--    policies and any app calls to rpc('is_admin') behave exactly as before.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to anon, authenticated, service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select private.is_admin()
$$;

-- 3) pg_net was installed in public; nothing references it, so reinstall it in extensions.
drop extension if exists pg_net;
create extension if not exists pg_net with schema extensions;
