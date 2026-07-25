import { serve } from "https://deno.land/std@0.170.0/http/server.ts";

const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "production"
  ? "https://api.asaas.com/v3"
  : "https://sandbox.asaas.com/api/v3";

const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const ASAAS_HEADERS = {
  "Content-Type": "application/json",
  "access_token": ASAAS_KEY,
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Método não permitido" }, 405);
  }

  try {
    const body = await req.json();
    const { action } = body;

    // ── checkStatus: polling de pagamento ──
    if (action === "checkStatus") {
      const { subscriptionId } = body;
      if (!subscriptionId) return json({ error: "subscriptionId obrigatório" }, 400);
      const paymentsRes = await fetch(`${ASAAS_URL}/subscriptions/${subscriptionId}/payments`, {
        headers: ASAAS_HEADERS,
      }).then(r => r.json());
      const firstPayment = paymentsRes?.data?.[0];
      return json({ status: firstPayment?.status || "pending", invoiceUrl: firstPayment?.invoiceUrl || null });
    }

    const { name, email, phone, cpfCnpj, plan, billingType, creditCard, creditCardHolderInfo, installmentCount } = body;
    const bt = billingType || "PIX";
    if (!name || !email || !plan) {
      return json({ error: "name, email e plan são obrigatórios" }, 400);
    }

    // 1. Cliente no Asaas
    const cust = await fetch(`${ASAAS_URL}/customers`, {
      method: "POST",
      headers: ASAAS_HEADERS,
      body: JSON.stringify({ name, email, mobilePhone: phone, cpfCnpj, notificationDisabled: false }),
    }).then(r => r.json());

    if (!cust.id) throw new Error(`Erro Asaas: ${JSON.stringify(cust)}`);

    // 2. Salvar customer no Supabase
    const dbCust = await api("customers", {
      method: "POST",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({ name, email, phone, cpf_cnpj: cpfCnpj }),
    }).then(r => r.json());

    const customerId = Array.isArray(dbCust) ? dbCust[0]?.id : dbCust?.id;

    // 3. Montar payload da assinatura
    const p = PLANS[plan as keyof typeof PLANS];
    const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];

    const subPayload: Record<string, unknown> = {
      customer: cust.id,
      billingType: bt,
      value: p.value / 100,
      nextDueDate: dueDate,
      cycle: p.cycle,
      description: `FisioHome - ${p.desc}`,
      maxPayments: p.max,
    };

    if (bt === "CREDIT_CARD" && creditCard) {
      subPayload.creditCard = creditCard;
      if (creditCardHolderInfo) {
        subPayload.creditCardHolderInfo = creditCardHolderInfo;
      }
      if (installmentCount && installmentCount > 1) {
        subPayload.installmentCount = installmentCount;
      }
    }

    const sub = await fetch(`${ASAAS_URL}/subscriptions`, {
      method: "POST",
      headers: ASAAS_HEADERS,
      body: JSON.stringify(subPayload),
    }).then(r => r.json());

    if (!sub.id) throw new Error(`Erro assinatura Asaas: ${JSON.stringify(sub)}`);

    // 4. Salvar subscription no Supabase
    const subStatus = bt === "CREDIT_CARD" ? "active" : "trial";
    await api("subscriptions", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        plan,
        status: subStatus,
        asaas_sub_id: sub.id,
        asaas_cust_id: cust.id,
        current_period_start: bt === "CREDIT_CARD" ? new Date().toISOString() : null,
        trial_end: bt === "CREDIT_CARD" ? null : new Date(Date.now() + 7 * 86400000).toISOString(),
      }),
    });

    // 5. Buscar primeira cobrança
    let pixQrCode = null;
    let invoiceUrl = null;
    let paymentStatus = "pending";
    try {
      const paymentsRes = await fetch(`${ASAAS_URL}/subscriptions/${sub.id}/payments`, {
        headers: ASAAS_HEADERS,
      }).then(r => r.json());

      const firstPayment = paymentsRes?.data?.[0];
      if (firstPayment?.id) {
        paymentStatus = firstPayment.status || "pending";
        invoiceUrl = firstPayment.invoiceUrl || null;
        if (bt === "PIX") {
          const qrRes = await fetch(`${ASAAS_URL}/payments/${firstPayment.id}/pixQrCode`, {
            headers: ASAAS_HEADERS,
          }).then(r => r.json());
          if (qrRes.success && qrRes.encodedImage) {
            pixQrCode = { encodedImage: qrRes.encodedImage, payload: qrRes.payload };
          }
        } else {
          if (firstPayment.invoiceUrl) invoiceUrl = firstPayment.invoiceUrl;
        }
      }
    } catch {
      // Non-critical
    }

    return json({
      ok: true,
      subscriptionId: sub.id,
      customerId: cust.id,
      plan,
      value: p.value / 100,
      billingType: bt,
      status: subStatus,
      paymentStatus,
      pixQrCode,
      invoiceUrl,
    });

  } catch (err) {
    return json({ error: err.message }, 400);
  }
});
