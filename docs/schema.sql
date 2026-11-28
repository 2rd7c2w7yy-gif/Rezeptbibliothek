-- RezeptBibliothek Web-App – Supabase Schema (im SQL Editor ausführen)
-- Konzept: ÖFFENTLICH LESBAR (kein Login nötig). Nur der Besitzer (Login) darf schreiben.
-- Owner-E-Mail hier UND in docs/config.js (OWNER_EMAIL) eintragen!

create table if not exists app_config (
  key text primary key,
  value text not null
);
insert into app_config (key, value) values ('owner_email', 'owner@beispiel.de')
  on conflict (key) do update set value = excluded.value;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  is_owner boolean not null default false,
  created_at timestamptz default now()
);

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'Allgemein',
  device text not null default 'thermomix',
  markdown text not null,
  group_id uuid references groups(id) on delete set null,
  cookidoo_path text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  primary key (group_id, user_id)
);

-- Profil automatisch beim Anlegen des Auth-Users (Trigger), Owner anhand app_config
create or replace function public.bootstrap_profile()
returns trigger language plpgsql security definer set search_path = public as $$
declare owner_email text;
begin
  select value into owner_email from app_config where key = 'owner_email';
  insert into public.profiles (id, email, is_owner)
  values (new.id, new.email, lower(new.email) = lower(owner_email))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.bootstrap_profile();

create or replace function public.is_owner(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_owner from public.profiles p where p.id = uid), false);
$$;

-- RLS
alter table app_config enable row level security;
alter table profiles enable row level security;
alter table groups enable row level security;
alter table recipes enable row level security;
alter table group_members enable row level security;

create policy "app_config public read" on app_config for select using (true);

-- Profile: nur eigenes Profil bzw. Owner sieht alle; Einfügen nur über Trigger
create policy "profiles self read" on profiles for select using (auth.uid() = id);
create policy "profiles owner read all" on profiles for select using (public.is_owner(auth.uid()));
create policy "profiles no direct write" on profiles for insert with check (false);
create policy "profiles no update" on profiles for update using (false);

-- LESEN ist öffentlich (auch ohne Login / anon), SCHREIBEN nur für Owner
create policy "recipes public read" on recipes for select using (true);
create policy "recipes owner insert" on recipes for insert with check (public.is_owner(auth.uid()));
create policy "recipes owner update" on recipes for update using (public.is_owner(auth.uid()));
create policy "recipes owner delete" on recipes for delete using (public.is_owner(auth.uid()));

create policy "groups public read" on groups for select using (true);
create policy "groups owner write" on groups for all using (public.is_owner(auth.uid())) with check (public.is_owner(auth.uid()));

create policy "group_members public read" on group_members for select using (true);
create policy "group_members owner write" on group_members for all using (public.is_owner(auth.uid())) with check (public.is_owner(auth.uid()));

-- Öffentlicher Storage-Bucket für Cookidoo-Export-URLs (lesen öffentlich, schreiben nur eingeloggt)
insert into storage.buckets (id, name, public) values ('cookidoo', 'cookidoo', true)
  on conflict (id) do nothing;
create policy "cookidoo public read" on storage.objects for select using (bucket_id = 'cookidoo');
create policy "cookidoo auth write" on storage.objects for insert with check (bucket_id = 'cookidoo' and auth.role() = 'authenticated');
create policy "cookidoo auth update" on storage.objects for update using (bucket_id = 'cookidoo' and auth.role() = 'authenticated');
