import { serve } from "https://deno.land/std@0.170.0/http/server.ts";
import { api, mapAsaasStatus } from "../_shared/db.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  try {
    const event = await req.json();
    const { payment, subscription } = event || {};

    // A assinatura vem dentro do objeto `payment` (payment.subscription),
    // ou eventualmente no top-level como objeto (subscription.id).
    const asaasSubId = payment?.subscription || subscription?.id;

    console.log("webhook recebido:", {
      paymentId: payment?.id,
      statusAsaas: payment?.status,
      billingType: payment?.billingType,
      hasSubscription: !!asaasSubId,
    });

    if (!payment || !asaasSubId) return new Response("ok", { status: 200 });

    const payStatus = mapAsaasStatus(payment.status);

    // Buscar usuário local pelo asaas_sub_id
    const users = await api(
      `users?asaas_sub_id=eq.${asaasSubId}&select=id,name,email,phone,plan,status`
    ).then(r => r.json());
    let user = users?.[0];

    // Fallback: se a assinatura ainda não foi vinculada (race com o checkout),
    // recupera o user_id pela cobrança que o clever-api já salvou.
    if (!user?.id) {
      const pays = await api(
        `payments?asaas_pay_id=eq.${encodeURIComponent(payment.id as string)}&select=user_id,user:users(id,name,email,phone,plan,status)`
      ).then(r => r.json()).catch(() => []);
      const payRow = Array.isArray(pays) ? pays[0] : null;
      if (payRow?.user_id && payRow.user) {
        user = Array.isArray(payRow.user) ? payRow.user[0] : payRow.user;
      }
    }

    if (!user?.id) return new Response("ok", { status: 200 });

    // Upsert do payment (por asaas_pay_id)
    const payBody: Record<string, unknown> = {
      user_id: user.id,
      asaas_pay_id: payment.id,
      amount: Math.round(Number(payment.value) * 100),
      fee: Math.round(Number(payment.fee || 0) * 100),
      status: payStatus,
      payment_method: (payment.billingType || "").toLowerCase(),
      due_date: payment.dueDate,
      invoice_url: payment.invoiceUrl || null,
      pix_qrcode: payment.pixQrCode?.encodedImage || null,
      pix_code: payment.pixQrCode?.payload || null,
    };
    if (payment.paymentDate) payBody.paid_at = payment.paymentDate;
    if (payment.clientPaymentDate) payBody.paid_at = payment.clientPaymentDate;

    const existingPays = await api(
      `payments?asaas_pay_id=eq.${encodeURIComponent(payment.id as string)}&select=id`
    ).then(r => r.json());
    if (Array.isArray(existingPays) && existingPays.length > 0) {
      await api(`payments?id=eq.${existingPays[0].id}`, {
        method: "PATCH",
        body: JSON.stringify(payBody),
      });
    } else {
      await api("payments", {
        method: "POST",
        body: JSON.stringify(payBody),
      });
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`erro: ${err.message || err}`, { status: 400 });
  }
});
