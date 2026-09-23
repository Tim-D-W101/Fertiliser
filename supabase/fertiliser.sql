-- Fertiliser stock — the shared database.
--
-- Lives in the same Supabase project as Tikita (tikita-attendance), but with
-- its own company codes in public.fert_workspaces: a Tikita code does not
-- open the fertiliser records, and a fertiliser code does not open Tikita.
-- Tikita's own tables and functions are not touched.
--
-- Same pattern as Tikita: row level security on with no policies, so the
-- tables are unreachable through the API; all access goes through three
-- SECURITY DEFINER functions that check the company code first.
--
-- The code itself is never stored here. To create one:
--   insert into public.fert_workspaces (name, join_code) values ('Name', 'XXXX-XXXX-XXXX-XXXX');

create table public.fert_workspaces (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  join_code  text        not null unique,
  created_at timestamptz not null default now()
);

create table public.fert_products (
  workspace_id uuid        not null references public.fert_workspaces(id) on delete cascade,
  id           text        not null,
  name         text        not null default '',
  kg_per_bag   numeric     not null default 25,
  cost_per_bag numeric     not null default 0,
  reorder      numeric     not null default 0,
  active       boolean     not null default true,
  deleted      boolean     not null default false,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);

-- Stock movements. Append-only: once written, only the void fields change.
create table public.fert_moves (
  workspace_id uuid        not null references public.fert_workspaces(id) on delete cascade,
  id           text        not null,
  product_id   text        not null,
  kind         text        not null check (kind in ('delivery', 'usage', 'adjustment')),
  bags         numeric     not null,
  kg_per_bag   numeric     not null,
  cost_per_bag numeric     not null,
  recorded_by  text        not null default '',
  note         text        not null default '',
  at           timestamptz not null,
  voided_at    timestamptz,
  voided_by    text,
  void_reason  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);

-- Every price a fertiliser has had, so old months are valued at their price.
create table public.fert_prices (
  workspace_id uuid        not null references public.fert_workspaces(id) on delete cascade,
  id           text        not null,
  product_id   text        not null,
  cost_per_bag numeric     not null,
  at           timestamptz not null,
  recorded_by  text        not null default '',
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, id)
);

create index fert_products_changed on public.fert_products (workspace_id, updated_at);
create index fert_moves_changed    on public.fert_moves    (workspace_id, updated_at);
create index fert_prices_changed   on public.fert_prices   (workspace_id, updated_at);

alter table public.fert_workspaces enable row level security;
alter table public.fert_products enable row level security;
alter table public.fert_moves    enable row level security;
alter table public.fert_prices   enable row level security;

create or replace function public.fert_workspace_for_code(p_code text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.fert_workspaces
   where join_code = upper(trim(coalesce(p_code, '')));
  if v_id is null then
    raise exception 'invalid_code' using errcode = '28000';
  end if;
  return v_id;
end;
$$;

create or replace function public.fert_join(p_code text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.fert_workspace_for_code(p_code);
  v_name text;
begin
  select name into v_name from public.fert_workspaces where id = v_id;
  return jsonb_build_object('workspace', v_id, 'name', v_name, 'now', now());
end;
$$;

create or replace function public.fert_pull(p_code text, p_since timestamptz default '-infinity')
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.fert_workspace_for_code(p_code);
  v_since timestamptz := coalesce(p_since, '-infinity');
begin
  return jsonb_build_object(
    'now', now(),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'kg', p.kg_per_bag, 'cost', p.cost_per_bag,
               'reorder', p.reorder, 'active', p.active, 'deleted', p.deleted))
        from public.fert_products p
       where p.workspace_id = v_id and p.updated_at > v_since), '[]'::jsonb),
    'moves', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'pid', m.product_id, 'kind', m.kind, 'bags', m.bags,
               'kg', m.kg_per_bag, 'cost', m.cost_per_bag, 'by', m.recorded_by,
               'note', m.note, 'at', m.at, 'voidAt', m.voided_at,
               'voidBy', m.voided_by, 'voidReason', m.void_reason))
        from public.fert_moves m
       where m.workspace_id = v_id and m.updated_at > v_since), '[]'::jsonb),
    'prices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'pid', x.product_id, 'cost', x.cost_per_bag,
               'at', x.at, 'by', x.recorded_by))
        from public.fert_prices x
       where x.workspace_id = v_id and x.updated_at > v_since), '[]'::jsonb)
  );
end;
$$;

create or replace function public.fert_push(p_code text, p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := public.fert_workspace_for_code(p_code);
begin
  insert into public.fert_products
         (workspace_id, id, name, kg_per_bag, cost_per_bag, reorder, active, deleted, updated_at)
  select v_id, r->>'id',
         coalesce(r->>'name', ''),
         coalesce((r->>'kg')::numeric, 25),
         coalesce((r->>'cost')::numeric, 0),
         coalesce((r->>'reorder')::numeric, 0),
         coalesce((r->>'active')::boolean, true),
         coalesce((r->>'deleted')::boolean, false),
         now()
    from jsonb_array_elements(coalesce(p_payload->'products', '[]'::jsonb)) r
   where coalesce(r->>'id', '') <> ''
  on conflict (workspace_id, id) do update
    set name         = excluded.name,
        kg_per_bag   = excluded.kg_per_bag,
        cost_per_bag = excluded.cost_per_bag,
        reorder      = excluded.reorder,
        active       = excluded.active,
        deleted      = excluded.deleted,
        updated_at   = excluded.updated_at;

  -- A movement's figures never change after it is first written; only a
  -- cancellation is added, and a cancellation is never taken back.
  insert into public.fert_moves
         (workspace_id, id, product_id, kind, bags, kg_per_bag, cost_per_bag,
          recorded_by, note, at, voided_at, voided_by, void_reason, updated_at)
  select v_id, r->>'id', r->>'pid', r->>'kind',
         (r->>'bags')::numeric,
         coalesce((r->>'kg')::numeric, 0),
         coalesce((r->>'cost')::numeric, 0),
         coalesce(r->>'by', ''),
         coalesce(r->>'note', ''),
         coalesce((r->>'at')::timestamptz, now()),
         (r->>'voidAt')::timestamptz,
         r->>'voidBy',
         r->>'voidReason',
         now()
    from jsonb_array_elements(coalesce(p_payload->'moves', '[]'::jsonb)) r
   where coalesce(r->>'id', '') <> '' and coalesce(r->>'pid', '') <> ''
  on conflict (workspace_id, id) do update
    set voided_at   = coalesce(public.fert_moves.voided_at, excluded.voided_at),
        voided_by   = coalesce(public.fert_moves.voided_by, excluded.voided_by),
        void_reason = coalesce(public.fert_moves.void_reason, excluded.void_reason),
        updated_at  = excluded.updated_at;

  insert into public.fert_prices (workspace_id, id, product_id, cost_per_bag, at, recorded_by, updated_at)
  select v_id, r->>'id', r->>'pid',
         coalesce((r->>'cost')::numeric, 0),
         coalesce((r->>'at')::timestamptz, now()),
         coalesce(r->>'by', ''),
         now()
    from jsonb_array_elements(coalesce(p_payload->'prices', '[]'::jsonb)) r
   where coalesce(r->>'id', '') <> '' and coalesce(r->>'pid', '') <> ''
  on conflict (workspace_id, id) do nothing;

  return jsonb_build_object('now', now());
end;
$$;

revoke all on public.fert_workspaces, public.fert_products, public.fert_moves, public.fert_prices from anon, authenticated;
revoke execute on function public.fert_workspace_for_code(text) from public, anon, authenticated;
grant execute on function public.fert_join(text) to anon, authenticated;
grant execute on function public.fert_pull(text, timestamptz) to anon, authenticated;
grant execute on function public.fert_push(text, jsonb) to anon, authenticated;
