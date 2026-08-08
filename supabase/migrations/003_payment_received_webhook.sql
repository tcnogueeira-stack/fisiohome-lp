-- ============================================
-- FisioHome — Webhook payments -> activator
--
-- Quando payments.status passa a 'received', chama a
-- edge function `activator` (cria usuário no Auth + e-mails).
--
-- A service_role key fica no Vault (nome: fisiohome_activator_jwt)
-- e NUNCA é commitada neste arquivo.
-- ============================================

-- 1. pg_net (chamadas HTTP assíncronas a partir do Postgres)
create extension if not exists pg_net;

-- 2. Garante o segredo no Vault (sem valor: é criado via:
--    supabase db query --linked "select vault.create_secret('<service_role>', 'fisiohome_activator_jwt');"
--    O DO block abaixo apenas avisa se estiver faltando.)
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'fisiohome_activator_jwt') then
    raise notice 'fisiohome_activator_jwt ausente. Rode: select vault.create_secret(SEU_KEY, fisiohome_activator_jwt);';
  end if;
end
$$;

-- 3. Função de trigger: dispara o activator quando status -> received
create or replace function public.fire_activator_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret_key text;
  resp       record;
begin
  if (tg_op = 'UPDATE' and old.status = 'received') then
    return new; -- já processado
  end if;

  select decrypted_secret into secret_key
  from vault.decrypted_secrets
  where name = 'fisiohome_activator_jwt';

  if secret_key is null then
    raise notice 'fisiohome_activator_jwt não configurada; webhook ignorado (payments: %)', new.id;
    return new;
  end if;

  perform net.http_post(
    url := 'https://alwwhsckljdmwcodnnti.supabase.co/functions/v1/activator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || secret_key
    ),
    body := jsonb_build_object(
      'type',     tg_op,
      'table',    'payments',
      'schema',   'public',
      'record',   to_jsonb(new)
    ),
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

-- 4. Trigger: fires em INSERT e em UPDATE de status p/ 'received'
drop trigger if exists trg_payments_received_webhook ON payments;
create trigger trg_payments_received_webhook
  after insert or update of status on payments
  for each row
  when (new.status = 'received')
  execute function public.fire_activator_webhook();
