-- ============================================
-- FisioHome — Cupons de desconto
--
-- 1. coupons: códigos de desconto (100% = teste/gratuito; percentuais sazonais).
-- 2. coupon_uses: registro por e-mail — UNIQUE(coupon_id, email) É o bloqueio
--    de reuso pelo mesmo e-mail (atômico, sem corrida).
-- 3. payments.coupon_code: rastro do cupom usado na compra.
-- 4. RPCs: validate_coupon (sem efeito), claim_coupon (registra uso),
--    release_coupon (devolve uso se o checkout falhar).
-- ============================================

create table if not exists public.coupons (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,
  discount_percent    numeric(5,2) not null check (discount_percent > 0 and discount_percent <= 100),
  single_use_per_email boolean not null default false,
  max_uses            integer check (max_uses is null or max_uses > 0),
  uses                integer not null default 0 check (uses >= 0),
  plans               text[],
  valid_from          timestamptz,
  valid_until         timestamptz,
  active              boolean not null default true,
  description         text,
  created_at          timestamptz not null default now()
);

create table if not exists public.coupon_uses (
  id          uuid primary key default gen_random_uuid(),
  coupon_id   uuid not null references public.coupons(id) on delete cascade,
  email       text not null,
  created_at  timestamptz not null default now(),
  unique (coupon_id, email)
);

alter table public.payments add column if not exists coupon_code text;

-- RLS sem policies = leitura/escrita negada para anon/authenticated;
-- o service_role (edge functions) faz bypass.
alter table public.coupons enable row level security;
alter table public.coupon_uses enable row level security;

-- ── Validação sem efeito colateral (usada pelo botão "Aplicar cupom") ──
create or replace function public.validate_coupon(p_code text, p_email text, p_plan text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c      public.coupons%rowtype;
  v_code text  := upper(trim(coalesce(p_code, '')));
  v_mail text  := lower(trim(coalesce(p_email, '')));
begin
  if v_code = '' then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;

  select * into c from public.coupons where code = v_code;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;
  if not c.active then
    return jsonb_build_object('valid', false, 'reason', 'inactive');
  end if;
  if c.valid_from is not null and now() < c.valid_from then
    return jsonb_build_object('valid', false, 'reason', 'not_started');
  end if;
  if c.valid_until is not null and now() > c.valid_until then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  if c.max_uses is not null and c.uses >= c.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'uses_exhausted');
  end if;
  if c.plans is not null and (p_plan is null or p_plan = '' or not (p_plan = any (c.plans))) then
    return jsonb_build_object('valid', false, 'reason', 'wrong_plan');
  end if;
  if c.single_use_per_email then
    if v_mail = '' then
      return jsonb_build_object('valid', false, 'reason', 'email_required');
    end if;
    if exists (select 1 from public.coupon_uses cu where cu.coupon_id = c.id and cu.email = v_mail) then
      return jsonb_build_object('valid', false, 'reason', 'already_used');
    end if;
  end if;

  return jsonb_build_object('valid', true, 'discount_percent', c.discount_percent, 'coupon_code', c.code);
end;
$$;

-- ── Registra o uso (transação única: e-mail bloqueado + contador) ──
create or replace function public.claim_coupon(p_code text, p_email text, p_plan text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_id     uuid;
  v_single boolean;
  v_mail   text := lower(trim(coalesce(p_email, '')));
begin
  v_result := public.validate_coupon(p_code, p_email, p_plan);
  if not (v_result->>'valid')::boolean then
    return v_result;
  end if;

  select id, single_use_per_email into v_id, v_single
  from public.coupons
  where code = upper(trim(coalesce(p_code, '')));

  if v_single then
    begin
      insert into public.coupon_uses (coupon_id, email) values (v_id, v_mail);
    exception when unique_violation then
      return jsonb_build_object('valid', false, 'reason', 'already_used');
    end;
  end if;

  update public.coupons
     set uses = uses + 1
   where id = v_id
     and (max_uses is null or uses < max_uses);

  if not found then
    if v_single then
      delete from public.coupon_uses where coupon_id = v_id and email = v_mail;
    end if;
    return jsonb_build_object('valid', false, 'reason', 'uses_exhausted');
  end if;

  return v_result;
end;
$$;

-- ── Devolve o uso quando o checkout falha depois do claim ──
create or replace function public.release_coupon(p_code text, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid;
  v_mail text := lower(trim(coalesce(p_email, '')));
begin
  select id into v_id from public.coupons where code = upper(trim(coalesce(p_code, '')));
  if v_id is null then
    return false;
  end if;

  delete from public.coupon_uses where coupon_id = v_id and email = v_mail;
  update public.coupons set uses = greatest(uses - 1, 0) where id = v_id;
  return true;
end;
$$;

revoke all on function public.validate_coupon(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_coupon(text, text, text) from public, anon, authenticated;
revoke all on function public.release_coupon(text, text) from public, anon, authenticated;
grant execute on function public.validate_coupon(text, text, text) to service_role;
grant execute on function public.claim_coupon(text, text, text) to service_role;
grant execute on function public.release_coupon(text, text) to service_role;

-- ── Cupom de teste: 100%, um uso por e-mail ──
insert into public.coupons (code, discount_percent, single_use_per_email, active, description)
values ('KEYUSER', 100, true, true, 'Acesso de teste gratuito — 1 uso por e-mail')
on conflict (code) do nothing;
