alter table public.transcriptions
  add column if not exists sheet_name text,
  add column if not exists midi_url text,
  add column if not exists raw_midi_url text,
  add column if not exists pdf_url text,
  add column if not exists time_signature text,
  add column if not exists clean_level text,
  add column if not exists status text,
  add column if not exists error_message text;

create index if not exists transcriptions_user_id_created_at_idx
  on public.transcriptions (user_id, created_at desc);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'transcriptions'
      and column_name = 'user_id'
      and data_type <> 'uuid'
  ) then
    alter table public.transcriptions
      alter column user_id type uuid
      using (
        case
          when user_id is null then null
          when user_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            then user_id::uuid
          else null
        end
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'transcriptions_user_id_fkey'
      and conrelid = 'public.transcriptions'::regclass
  ) then
    alter table public.transcriptions
      add constraint transcriptions_user_id_fkey
      foreign key (user_id)
      references public.users (id)
      on delete cascade;
  end if;
end
$$;
