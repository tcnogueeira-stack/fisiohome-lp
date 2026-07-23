import { serve } from "https://deno.land/std@0.170.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function api(path: string, options: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Prefer": "return=minimal",
      ...options.headers,
    },
  });
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  try {
    const event = await req.json();
    const { event: eventType, payment, subscription } = event || {};

    if (!payment || !subscription?.id) return new Response("ok", { status: 200 });

    const subId = subscription.id;
    const statusMap: Record<string, string> = {
      RECEIVED: "received",
      CONFIRMED: "received",
      OVERDUE: "overdue",
      REFUNDED: "refunded",
      CANCELLED: "canceled",
    };
    const payStatus = statusMap[payment.status] || "pending";

    // Buscar subscription local pelo asaas_sub_id
    const subs = await api(`subscriptions?asaas_sub_id=eq.${subId}&select=id`).then(r => r.json());
    const localSubId = subs?.[0]?.id;
    if (!localSubId) return new Response("ok", { status: 200 });

    // Inserir payment
    const payBody: Record<string, unknown> = {
      subscription_id: localSubId,
      asaas_pay_id: payment.id,
      amount: Math.round(payment.value * 100),
      fee: Math.round((payment.fee || 0) * 100),
      status: payStatus,
      payment_method: (payment.billingType || "").toLowerCase(),
      due_date: payment.dueDate,
      invoice_url: payment.invoiceUrl || null,
      pix_qrcode: payment.pixQrCode?.encodedImage || null,
      pix_code: payment.pixQrCode?.payload || null,
    };
    if (payment.paidDate) payBody.paid_at = payment.paidDate;

    await api("payments", {
      method: "POST",
      body: JSON.stringify(payBody),
    });

    // Se recebido, ativar subscription
    if (payStatus === "received") {
      await api(`subscriptions?id=eq.${localSubId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "active",
          current_period_start: new Date().toISOString(),
        }),
      });
    }

    return new Response("ok", { status: 200 });
  } catch {
    return new Response("ok", { status: 200 });
  }
});
