import { serve } from "https://deno.land/std@0.170.0/http/server.ts";

const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "production"
  ? "https://api.asaas.com/v3"
  : "https://sandbox.asaas.com/api/v3";

const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const ASAAS_HEADERS = {
  "Content-Type": "application/json",
  "access_token": ASAAS_KEY,
};

function api(path: string, options: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      ...options.headers,
    },
  });
}

const PLANS = {
  mensal:    { value: 4790, desc: "Mensal",        cycle: "MONTHLY",        max: undefined },
  semestral: { value: 23940, desc: "Semestral",     cycle: "SEMIANNUALLY",   max: 6 },
  anual:     { value: 35880, desc: "Anual",         cycle: "YEARLY",         max: 12 },
} as const;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405 });
  }

  try {
    const { name, email, phone, cpfCnpj, plan } = await req.json();
    if (!name || !email || !plan) {
      return new Response(JSON.stringify({ error: "name, email e plan são obrigatórios" }), { status: 400 });
    }

    // 1. Cliente no Asaas
    const cust = await fetch(`${ASAAS_URL}/customers`, {
      method: "POST",
      headers: ASAAS_HEADERS,
      body: JSON.stringify({ name, email, phone, cpfCnpj, notificationDisabled: false }),
    }).then(r => r.json());

    if (!cust.id) throw new Error(`Erro Asaas: ${JSON.stringify(cust)}`);

    // 2. Salvar customer no Supabase
    const dbCust = await api("customers", {
      method: "POST",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({ name, email, phone, cpf_cnpj: cpfCnpj }),
    }).then(r => r.json());

    const customerId = Array.isArray(dbCust) ? dbCust[0]?.id : dbCust?.id;

    // 3. Assinatura no Asaas
    const p = PLANS[plan as keyof typeof PLANS];
    const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
    const sub = await fetch(`${ASAAS_URL}/subscriptions`, {
      method: "POST",
      headers: ASAAS_HEADERS,
      body: JSON.stringify({
        customer: cust.id,
        billingType: "PIX",
        value: p.value / 100,
        nextDueDate: dueDate,
        cycle: p.cycle,
        description: `FisioHome - ${p.desc}`,
        maxPayments: p.max,
      }),
    }).then(r => r.json());

    if (!sub.id) throw new Error(`Erro assinatura Asaas: ${JSON.stringify(sub)}`);

    // 4. Salvar subscription no Supabase
    await api("subscriptions", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        plan,
        status: "trial",
        asaas_sub_id: sub.id,
        asaas_cust_id: cust.id,
        trial_end: new Date(Date.now() + 7 * 86400000).toISOString(),
      }),
    });

    return new Response(JSON.stringify({
      ok: true,
      subscriptionId: sub.id,
      customerId: cust.id,
      plan,
      value: p.value / 100,
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
});
