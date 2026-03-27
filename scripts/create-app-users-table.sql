create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  image text,
  password_hash text,
  auth_provider text not null default 'google',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (email);

create or replace function public.set_users_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;

create trigger users_set_updated_at
before update on public.users
for each row
execute function public.set_users_updated_at();

alter table public.users enable row level security;
alter table public.users force row level security;

revoke all on public.users from anon, authenticated;

drop policy if exists users_select_own on public.users;
drop policy if exists users_update_own on public.users;

-- NextAuth is used for application auth; Supabase Auth JWTs are not used
-- in this project. Keep this table server-only and access it through API
-- routes that use the Supabase service key.
