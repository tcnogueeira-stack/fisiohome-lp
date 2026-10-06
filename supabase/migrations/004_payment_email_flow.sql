-- ============================================
-- FisioHome — Fluxo de e-mails transacionais
--
-- 1. payments.emails_sent: controle de idempotência (1 e-mail por tipo/pagamento).
-- 2. claim_payment_email(): claim atômico — só quem atualizar a linha envia.
-- 3. Trigger ampliado: além de status -> 'received' (Pagamento aprovado +
--    Dados de acesso), dispara também no INSERT de pagamento PIX pendente
--    (e-mail "Pagamento pendente").
-- ============================================

-- 1. Controle de e-mails já enviados por pagamento
alter table public.payments
  add column if not exists emails_sent text[] not null default '{}';

-- 2. Claim atômico: retorna true apenas na primeira chamada para cada chave.
--    Mesmo que o webhook reenvio o evento (ou exista mais de uma linha para o
--    mesmo asaas_pay_id), só o primeiro request "ganha" o direito de enviar.
create or replace function public.claim_payment_email(p_payment_id uuid, p_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  update payments
     set emails_sent = array_append(emails_sent, p_email)
   where id = p_payment_id
     and not (emails_sent @> array[p_email])
     and not exists (
       select 1 from payments dup
       where dup.asaas_pay_id = payments.asaas_pay_id
         and dup.asaas_pay_id is not null
         and dup.emails_sent @> array[p_email]
     )
  returning true;
$$;

revoke all on function public.claim_payment_email(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_payment_email(uuid, text) to service_role;

-- 3. Função de trigger: dispara o activator nas transições que exigem e-mail
create or replace function public.fire_activator_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  secret_key text;
begin
  -- "Pagamento pendente" só no INSERT de um PIX pendente (enviado 1x;
  -- updates de status pendente não re-disparam).
  if (tg_op = 'INSERT' and new.status = 'pending'
      and coalesce(new.payment_method, '') <> 'pix') then
    return new;
  end if;

  -- Em UPDATE, pendente só interessa quando sai de pendente (para 'received').
  if (tg_op = 'UPDATE' and new.status = 'pending') then
    return new;
  end if;

  -- "Pagamento aprovado"/"Dados de acesso" já processados para este pagamento.
  if (tg_op = 'UPDATE' and old.status = 'received') then
    return new;
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
      'type',        tg_op,
      'table',       'payments',
      'schema',      'public',
      'record',      to_jsonb(new),
      'old_record',  case when tg_op = 'UPDATE' then to_jsonb(old) else null end
    ),
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

-- 4. Trigger: INSERT (pending/received) e UPDATE de status para 'received'
drop trigger if exists trg_payments_received_webhook on payments;
drop trigger if exists trg_payments_email_flow on payments;

create trigger trg_payments_email_flow
  after insert or update of status on payments
  for each row
  when (new.status in ('pending', 'received'))
  execute function public.fire_activator_webhook();
