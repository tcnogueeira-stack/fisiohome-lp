-- ============================================
-- FisioHome — Tabelas de pagamento (Asaas)
-- ============================================

-- 1. CLIENTES (fisioterapeutas)
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text UNIQUE NOT NULL,
  phone         text,
  cpf_cnpj      text,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- 2. ASSINATURAS
CREATE TYPE plan_type AS ENUM ('mensal', 'semestral', 'anual');
CREATE TYPE sub_status AS ENUM ('active', 'expired', 'canceled', 'trial');

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan            plan_type NOT NULL,
  status          sub_status NOT NULL DEFAULT 'trial',
  asaas_sub_id    text,                          -- ID da assinatura no Asaas
  asaas_cust_id   text,                          -- ID do cliente no Asaas
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_end       timestamptz,
  canceled_at     timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- 3. PAGAMENTOS / FATURAS
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  asaas_pay_id    text,                          -- ID da cobrança no Asaas
  amount          integer NOT NULL,               -- em centavos (R$ 47,90 = 4790)
  fee             integer DEFAULT 0,
  status          text,                          -- pending / received / overdue / refunded
  payment_method  text,                          -- pix / boleto / credit_card
  paid_at         timestamptz,
  due_date        date,
  invoice_url     text,                          -- link da fatura
  pix_qrcode      text,                          -- QR code PIX em base64
  pix_code        text,                          -- código PIX copia-cola
  created_at      timestamptz DEFAULT now()
);

-- Índices
CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX idx_subscriptions_status  ON subscriptions(status);
CREATE INDEX idx_payments_subscription  ON payments(subscription_id);
CREATE INDEX idx_payments_status        ON payments(status);

-- ============================================
-- RLS (Row Level Security)
-- ============================================
ALTER TABLE customers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments       ENABLE ROW LEVEL SECURITY;

-- Apenas o próprio cliente vê seus dados
CREATE POLICY "own_customer" ON customers
  FOR ALL USING (auth.uid() = id);

CREATE POLICY "own_subscriptions" ON subscriptions
  FOR ALL USING (auth.uid() = customer_id);

CREATE POLICY "own_payments" ON payments
  FOR ALL USING (
    auth.uid() = (SELECT customer_id FROM subscriptions WHERE id = subscription_id)
  );

-- Função para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
