import { serve } from "https://deno.land/std@0.170.0/http/server.ts";
import { api, mapAsaasStatus } from "../_shared/db.ts";

const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "production"
  ? "https://api.asaas.com/v3"
  : "https://sandbox.asaas.com/api/v3";

const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";

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

// Upsert de `payments`: atualiza por asaas_pay_id se já existir, caso
// contrário cria uma nova linha. NÃO usa upsert nativo do PostgREST para
// não depender de constraint única no asaas_pay_id.
async function savePayment(
  user_id: string,
  payment: Record<string, unknown>,
  pixQrCode: { encodedImage?: string; payload?: string } | null,
  couponCode?: string | null,
) {
  const body: Record<string, unknown> = {
    user_id,
    asaas_pay_id: payment.id,
    amount: Math.round(Number(payment.value) * 100),
    fee: Math.round(Number(payment.fee || 0) * 100),
    status: mapAsaasStatus(payment.status as string),
    payment_method: (payment.billingType as string || "").toLowerCase(),
    due_date: payment.dueDate || null,
    invoice_url: payment.invoiceUrl || null,
    pix_qrcode: pixQrCode?.encodedImage || null,
    pix_code: pixQrCode?.payload || null,
  };
  if (couponCode) body.coupon_code = couponCode;
  if (payment.paymentDate) body.paid_at = payment.paymentDate;
  if (payment.clientPaymentDate) body.paid_at = payment.clientPaymentDate;

  const existing = await api(`payments?asaas_pay_id=eq.${encodeURIComponent(payment.id as string)}&select=id`)
    .then(r => r.json())
    .catch(() => []);

  if (Array.isArray(existing) && existing.length > 0) {
    await api(`payments?id=eq.${existing[0].id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } else {
    await api("payments", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

const PLANS = {
  mensal:    { value: 4790, desc: "Mensal",        cycle: "MONTHLY",        max: undefined },
  semestral: { value: 23940, desc: "Semestral",     cycle: "SEMIANNUALLY",   max: 6 },
  anual:     { value: 35880, desc: "Anual",         cycle: "YEARLY",         max: 12 },
} as const;

// ── Cupons de desconto ──
function couponMessage(reason: string) {
  switch (reason) {
    case "inactive":
    case "expired":
    case "not_started":
      return "Cupom expirado ou indisponível.";
    case "uses_exhausted":
      return "Cupom esgotado.";
    case "already_used":
      return "Este e-mail já utilizou este cupom.";
    case "wrong_plan":
      return "Cupom não válido para este plano.";
    case "email_required":
      return "Informe seu e-mail para usar este cupom.";
    default:
      return "Cupom inválido.";
  }
}

// Upsert de `users` por e-mail (único). Reutilizado pelo fluxo normal
// (assinatura Asaas) e pelo fluxo gratuito (cupom 100%).
async function ensureUser(email: string, name: string, phone?: string, cpfCnpj?: string): Promise<string> {
  const existing = await api(`users?email=eq.${encodeURIComponent(email)}&select=id`)
    .then(r => r.json())
    .catch(() => []);

  if (Array.isArray(existing) && existing.length > 0) {
    const customerId = existing[0].id as string;
    await api(`users?id=eq.${customerId}`, {
      method: "PATCH",
      body: JSON.stringify({ name, phone, cpf_cnpj: cpfCnpj }),
    });
    return customerId;
  }

  const dbCust = await api("users", {
    method: "POST",
    headers: { "Prefer": "return=representation" },
    body: JSON.stringify({ name, email, phone, cpf_cnpj: cpfCnpj }),
  }).then(r => r.json());

  const customerId = (Array.isArray(dbCust) ? dbCust[0]?.id : dbCust?.id) as string | undefined;
  if (!customerId) throw new Error(`Erro banco: ${JSON.stringify(dbCust)}`);
  return customerId;
}

// ── Facebook Conversions API (CAPI) ──
const FB_PIXEL_ID = "929175296483682";

async function sha256(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value.trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sendFacebookCAPI(
  eventName: string,
  userData: { email?: string; phone?: string; ip?: string | null; userAgent?: string | null },
  eventData: { value: number; currency: string; content_name: string },
  eventSourceUrl: string,
) {
  const token = Deno.env.get("FACEBOOK_CAPI_TOKEN");
  if (!token) return;

  const payload: Record<string, unknown> = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        user_data: {
          em: userData.email ? await sha256(userData.email) : undefined,
          ph: userData.phone ? await sha256(userData.phone) : undefined,
          client_ip_address: userData.ip || undefined,
          client_user_agent: userData.userAgent || undefined,
        },
        event_data: {
          value: eventData.value,
          currency: eventData.currency,
          content_name: eventData.content_name,
        },
        action_source: "website",
        event_source_url: eventSourceUrl,
      },
    ],
    access_token: token,
  };

  try {
    await fetch(`https://graph.facebook.com/v19.0/${FB_PIXEL_ID}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-critical — don't block the response
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Método não permitido" }, 405);
  }

  // Cupom já registrado neste request — devolvido se o checkout falhar
  // antes de criar a assinatura/cobrança no Asaas.
  let claimed: { code: string; email: string } | null = null;
  let couponSettled = false;

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

      // Defesa extra: quando o Asaas confirmar o pagamento, persiste a linha
      // `payment` no Supabase na hora (o webhook brilho também faz, mas este
      // garante o status atualizado mesmo se o webhook atrasar).
      if (firstPayment?.id) {
        const users = await api(`users?asaas_sub_id=eq.${encodeURIComponent(subscriptionId)}&select=id,name,email,phone,plan,status`)
          .then(r => r.json())
          .catch(() => []);
        const user = Array.isArray(users) ? users[0] : null;
        if (user?.id && (firstPayment.status === "RECEIVED" || firstPayment.status === "CONFIRMED" || firstPayment.status === "active")) {
          await savePayment(user.id, firstPayment, null);

          // Dispara Purchase via CAPI quando PIX é confirmado pelo polling
          await sendFacebookCAPI(
            "Purchase",
            { email: user.email, phone: user.phone, ip: req.headers.get("cf-connecting-ip"), userAgent: req.headers.get("user-agent") },
            { value: PLANS[user.plan as keyof typeof PLANS]?.value / 100 || 0, currency: "BRL", content_name: `Assinatura FisioHome - ${user.plan}` },
            "https://fisiohome.com/checkout.html",
          );
        }
      }

      return json({ status: firstPayment?.status || "pending", invoiceUrl: firstPayment?.invoiceUrl || null });
    }

    // ── validateCoupon: valida o cupom SEM registrar o uso ──
    if (action === "validateCoupon") {
      const { couponCode, email, plan } = body;
      const base = plan ? PLANS[plan as keyof typeof PLANS]?.value : undefined;
      if (!base) return json({ valid: false, reason: "wrong_plan", message: "Plano inválido." });

      const res = await api("rpc/validate_coupon", {
        method: "POST",
        body: JSON.stringify({ p_code: couponCode ?? null, p_email: email ?? null, p_plan: plan }),
      }).then(r => r.json()).catch(() => null);

      if (!res?.valid) {
        const reason = res?.reason || "not_found";
        return json({ valid: false, reason, message: couponMessage(reason) });
      }

      const pct = Number(res.discount_percent);
      const finalValue = Math.round(base * (100 - pct) / 100);
      return json({
        valid: true,
        discountPercent: pct,
        originalValue: base / 100,
        finalValue: finalValue / 100,
        couponCode: res.coupon_code,
      });
    }

    const { name, email, phone, cpfCnpj, plan, billingType, creditCard, creditCardHolderInfo, installmentCount, couponCode } = body;
    const bt = billingType || "PIX";
    if (!name || !email || !plan) {
      return json({ error: "name, email e plan são obrigatórios" }, 400);
    }

    const p = PLANS[plan as keyof typeof PLANS];
    if (!p) return json({ error: "Plano inválido" }, 400);

    // ── Cupom de desconto: registra o uso (bloqueio por e-mail/limite) ──
    let coupon: string | null = null;
    let finalValue: number = p.value; // centavos
    if (couponCode) {
      const claim = await api("rpc/claim_coupon", {
        method: "POST",
        body: JSON.stringify({ p_code: couponCode, p_email: email, p_plan: plan }),
      }).then(r => r.json()).catch(() => null);

      if (!claim?.valid) {
        return json({ error: couponMessage(claim?.reason || "not_found") }, 400);
      }
      const code = String(claim.coupon_code);
      coupon = code;
      claimed = { code, email };
      finalValue = Math.round(p.value * (100 - Number(claim.discount_percent)) / 100);
    }

    // ── Cupom de 100%: acesso gratuito, sem cobrança no Asaas ──
    // Grava users + payments (status 'received') → o trigger do Postgres
    // dispara "Pagamento aprovado" + "Dados de acesso" como em qualquer compra.
    if (finalValue <= 0) {
      const customerId = await ensureUser(email, name, phone, cpfCnpj);
      await api(`users?id=eq.${customerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          plan,
          status: "active",
          current_period_start: new Date().toISOString(),
          trial_end: null,
        }),
      });

      const nowIso = new Date().toISOString();
      await api("payments", {
        method: "POST",
        body: JSON.stringify({
          user_id: customerId,
          amount: 0,
          fee: 0,
          status: "received",
          payment_method: "coupon",
          coupon_code: coupon,
          paid_at: nowIso,
          due_date: nowIso.split("T")[0],
        }),
      });
      couponSettled = true;

      return json({
        ok: true,
        free: true,
        plan,
        value: 0,
        billingType: "COUPON",
        status: "active",
        paymentStatus: "RECEIVED",
        couponCode: coupon,
        pixQrCode: null,
        invoiceUrl: null,
      });
    }

    // 1. Cliente no Asaas
    const cust = await fetch(`${ASAAS_URL}/customers`, {
      method: "POST",
      headers: ASAAS_HEADERS,
      // notificationDisabled: true → o Asaas NÃO envia e-mails ao cliente;
      // todos os e-mails transacionais saem do Supabase (activator).
      body: JSON.stringify({ name, email, mobilePhone: phone, cpfCnpj, notificationDisabled: true }),
    }).then(r => r.json());

    if (!cust.id) throw new Error(`Erro Asaas: ${JSON.stringify(cust)}`);

    // 2. Usuário local (upsert por e-mail — users.email tem UNIQUE)
    const customerId = await ensureUser(email, name, phone, cpfCnpj);

    // 3. Montar payload da assinatura — valor JÁ com desconto aplicado,
    //    para que webhook, payments.amount, QR PIX e e-mails nascam corretos.
    const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];

    const subPayload: Record<string, unknown> = {
      customer: cust.id,
      billingType: bt,
      value: finalValue / 100,
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
    couponSettled = true;

    // 4. Atualizar `users` com os dados da assinatura no Asaas
    await api(`users?id=eq.${customerId}`, {
      method: "PATCH",
      body: JSON.stringify({
        plan,
        status: "active",
        asaas_sub_id: sub.id,
        asaas_cust_id: cust.id,
        current_period_start: new Date().toISOString(),
        trial_end: null,
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

        // Upsert de `payments`: cria a linha já no checkout para garantir que
        // a cobrança exista no Supabase antes do webhook do Asaas chegar.
        // O webhook (bright-responder) atualiza a mesma linha por asaas_pay_id.
        if (customerId) await savePayment(customerId, firstPayment, pixQrCode, coupon);

        // Se pagamento já confirmado no checkout, dispara Purchase via CAPI
        if (firstPayment.status === "RECEIVED" || firstPayment.status === "CONFIRMED") {
          await sendFacebookCAPI(
            "Purchase",
            { email, phone, ip: req.headers.get("cf-connecting-ip"), userAgent: req.headers.get("user-agent") },
            { value: finalValue / 100, currency: "BRL", content_name: `Assinatura FisioHome - ${p.desc}` },
            "https://fisiohome.com/checkout.html",
          );
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
      value: finalValue / 100,
      originalValue: p.value / 100,
      couponCode: coupon,
      billingType: bt,
      status: "active",
      paymentStatus,
      pixQrCode,
      invoiceUrl,
    });

  } catch (err) {
    // Checkout falhou antes de criar a assinatura/cobrança → devolve o uso
    // do cupom para não consumir a cota sem venda.
    if (claimed && !couponSettled) {
      await api("rpc/release_coupon", {
        method: "POST",
        body: JSON.stringify({ p_code: claimed.code, p_email: claimed.email }),
      }).catch(() => {});
    }
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
