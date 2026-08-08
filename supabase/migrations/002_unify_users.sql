-- ============================================
-- FisioHome — Unifica customers + subscriptions em `users`
-- ============================================

-- 1. Nova tabela unificada de usuários (dados do Asaas + assinatura)
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  email                 text UNIQUE NOT NULL,
  phone                 text,
  cpf_cnpj              text,
  plan                  plan_type,                 -- mensal / semestral / anual
  status                sub_status NOT NULL DEFAULT 'trial',
  asaas_sub_id          text,                     -- ID da assinatura no Asaas
  asaas_cust_id         text,                     -- ID do cliente no Asaas
  current_period_start  timestamptz,
  current_period_end    timestamptz,
  trial_end             timestamptz,
  canceled_at           timestamptz,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- 2. Migrar dados existentes (cliente + assinatura mais recente)
INSERT INTO users (
  id, name, email, phone, cpf_cnpj,
  plan, status, asaas_sub_id, asaas_cust_id,
  current_period_start, current_period_end, trial_end, canceled_at,
  created_at, updated_at
)
SELECT DISTINCT ON (c.id)
  c.id, c.name, c.email, c.phone, c.cpf_cnpj,
  s.plan, s.status, s.asaas_sub_id, s.asaas_cust_id,
  s.current_period_start, s.current_period_end, s.trial_end, s.canceled_at,
  c.created_at, c.updated_at
FROM customers c
LEFT JOIN subscriptions s ON s.customer_id = c.id
ORDER BY c.id, s.created_at DESC;

-- 3. Migrar `payments` apontando para `users` (user_id)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE payments p
SET user_id = s.customer_id
FROM subscriptions s
WHERE s.id = p.subscription_id;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_subscription_id_fkey;
DROP INDEX IF EXISTS idx_payments_subscription;
DROP POLICY IF EXISTS "own_payments" ON payments;

-- Remover registros órfãos (sem assinatura original) antes de exigir NOT NULL
DELETE FROM payments WHERE user_id IS NULL;

ALTER TABLE payments DROP COLUMN IF EXISTS subscription_id;
ALTER TABLE payments ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Apagar tabelas antigas
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS customers;

-- 5. Índices
CREATE INDEX IF NOT EXISTS idx_users_status        ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_asaas_sub     ON users(asaas_sub_id);
CREATE INDEX IF NOT EXISTS idx_payments_user       ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status     ON payments(status);

-- ============================================
-- RLS (Row Level Security)
-- ============================================
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Apenas o próprio usuário vê seus dados
CREATE POLICY "own_users" ON users
  FOR ALL USING (auth.uid() = id);

CREATE POLICY "own_user_payments" ON payments
  FOR ALL USING (auth.uid() = user_id);

-- ============================================
-- Triggers (updated_at automático)
-- ============================================
DROP FUNCTION IF EXISTS update_updated_at() CASCADE;

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();