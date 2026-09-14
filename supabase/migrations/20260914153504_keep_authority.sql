create schema if not exists keep_private;
revoke all on schema keep_private from public, anon, authenticated;
do $role$ begin if not exists (select from pg_roles where rolname='keep_app') then create role keep_app login nosuperuser nocreatedb nocreaterole noinherit; end if; end $role$;
grant usage on schema keep_private to keep_app;
create table keep_private.authority (
 id boolean primary key default true check (id),
 revision bigint not null default 0,
 body jsonb not null default '{"rooms":{},"sessions":{},"receipts":{}}'::jsonb,
 updated_at timestamptz not null default now()
);
create table keep_private.room_codes (
 code text primary key check (code ~ '^[0-9]{6}$'),
 room_id text not null unique
);
alter table keep_private.authority enable row level security;
alter table keep_private.room_codes enable row level security;
revoke all on all tables in schema keep_private from public, anon, authenticated;
grant select,insert,update,delete on all tables in schema keep_private to keep_app;
create policy server_authority on keep_private.authority for all to keep_app using (true) with check (true);
create policy server_codes on keep_private.room_codes for all to keep_app using (true) with check (true);
insert into keep_private.authority(id) values (true);
alter role keep_app set search_path = keep_private;
alter role keep_app set statement_timeout = '15s';
