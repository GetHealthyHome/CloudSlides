-- CloudSlides: shared template library for signed-in crew.
-- Applied to the Supabase project on 2026-09-24.
create table public.slide_decks (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled deck',
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.slide_decks is 'CloudSlides template decks (cloudslides.deck JSON), shared by all signed-in crew.';

-- The server stamps who saved and when, so clients cannot fake it.
create or replace function public.slide_decks_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end;
$$;

create trigger slide_decks_stamp
  before insert or update on public.slide_decks
  for each row execute function public.slide_decks_stamp();

alter table public.slide_decks enable row level security;

create policy "crew read decks" on public.slide_decks
  for select to authenticated using (true);
create policy "crew add decks" on public.slide_decks
  for insert to authenticated with check (true);
create policy "crew edit decks" on public.slide_decks
  for update to authenticated using (true) with check (true);
create policy "crew delete decks" on public.slide_decks
  for delete to authenticated using (true);

-- Images placed in templates (logos, uploaded JPG/PNG). Public read so
-- exported HTML and printed PDFs can load them; only crew can upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('template-assets', 'template-assets', true, 20971520, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

create policy "crew upload template assets" on storage.objects
  for insert to authenticated with check (bucket_id = 'template-assets');
