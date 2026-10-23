-- HITIT stores a single end-to-end encrypted snapshot per authenticated user.
-- The server never receives the ledger password or plaintext ledger state.
create table if not exists public.hitit_vault (
  user_id uuid primary key references auth.users (id) on delete cascade,
  revision bigint not null check (revision > 0),
  salt text not null,
  iv text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

alter table public.hitit_vault enable row level security;
revoke all on table public.hitit_vault from anon, public;
grant select, insert, update, delete on table public.hitit_vault to authenticated;

drop policy if exists hitit_vault_select_own on public.hitit_vault;
create policy hitit_vault_select_own on public.hitit_vault
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists hitit_vault_insert_own on public.hitit_vault;
create policy hitit_vault_insert_own on public.hitit_vault
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists hitit_vault_update_own on public.hitit_vault;
create policy hitit_vault_update_own on public.hitit_vault
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists hitit_vault_delete_own on public.hitit_vault;
create policy hitit_vault_delete_own on public.hitit_vault
  for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.hitit_vault_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists hitit_vault_updated_at on public.hitit_vault;
create trigger hitit_vault_updated_at
  before update on public.hitit_vault
  for each row execute function public.hitit_vault_touch_updated_at();

