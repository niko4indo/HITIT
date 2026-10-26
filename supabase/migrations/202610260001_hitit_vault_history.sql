-- Keep the previous encrypted vault revisions so users can recover from an overwrite.
-- Ledger plaintext and the encryption password are never stored in this table.
create table if not exists public.hitit_vault_history (
  user_id uuid not null references auth.users (id) on delete cascade,
  revision bigint not null check (revision > 0),
  salt text not null,
  iv text not null,
  ciphertext text not null,
  archived_at timestamptz not null default now(),
  primary key (user_id, revision)
);

alter table public.hitit_vault_history enable row level security;
revoke all on table public.hitit_vault_history from anon, public;
grant select, insert, delete on table public.hitit_vault_history to authenticated;

drop policy if exists hitit_vault_history_select_own on public.hitit_vault_history;
create policy hitit_vault_history_select_own on public.hitit_vault_history
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists hitit_vault_history_insert_own on public.hitit_vault_history;
create policy hitit_vault_history_insert_own on public.hitit_vault_history
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists hitit_vault_history_delete_own on public.hitit_vault_history;
create policy hitit_vault_history_delete_own on public.hitit_vault_history
  for delete to authenticated using ((select auth.uid()) = user_id);

