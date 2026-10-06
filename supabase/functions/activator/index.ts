import { serve } from "https://deno.land/std@0.170.0/http/server.ts";
import { api, SUPABASE_URL, SERVICE_KEY, APP_URL } from "../_shared/db.ts";
import {
  sendPaymentPending,
  sendPaymentApproved,
  sendAccessCredentials,
  sendAccessRecovery,
} from "../_shared/email.ts";

const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "production"
  ? "https://api.asaas.com/v3"
  : "https://sandbox.asaas.com/api/v3";
const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function getUser(userId: string) {
  const users = await api(
    `users?id=eq.${userId}&select=id,name,email,phone,plan,status`
  ).then(r => r.json());
  const user = Array.isArray(users) ? users[0] : users;
  return user?.id ? user : null;
}

// Claim atômico por pagamento: somente o request que conseguir atualizar
// `emails_sent` (via RPC) envia o e-mail — webhook reenviado não duplica.
async function claimEmail(paymentId: string, key: string): Promise<boolean> {
  try {
    const res = await api("rpc/claim_payment_email", {
      method: "POST",
      body: JSON.stringify({ p_payment_id: paymentId, p_email: key }),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}

// QR Code PIX: usa o salvo em `payments`; se ausente, busca no Asaas.
async function ensurePixQr(record: Record<string, unknown>) {
  if (record.pix_qrcode || !ASAAS_KEY || !record.asaas_pay_id) return null;
  try {
    const qr = await fetch(`${ASAAS_URL}/payments/${record.asaas_pay_id}/pixQrCode`, {
      headers: { "Content-Type": "application/json", access_token: ASAAS_KEY },
    }).then(r => r.json());
    if (qr?.encodedImage) {
      return { encodedImage: qr.encodedImage, payload: qr.payload };
    }
  } catch {
    // Non-critical — e-mail sai sem o QR
  }
  return null;
}

async function recoveryLink(email: string): Promise<string> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generateLink`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ type: "recovery", email }),
    }).then(r => r.json());
    if (res?.action_link) return res.action_link;
  } catch {
    // Non-critical — usa o APP_URL como fallback
  }
  return APP_URL;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  try {
    const webhook = await req.json();
    const record = webhook?.record || webhook?.payment || webhook;

    // Chamado pelo trigger do Postgres (pg_net) quando payments muda.
    // Payload: { type, table, schema, record: {...}, old_record: {...} }
    if (!record?.id || !record?.user_id) return new Response("ok", { status: 200 });

    const payStatus = record.status;
    const isPix = String(record.payment_method || "").toLowerCase() === "pix";

    // ── PAGAMENTO PENDENTE (PIX) ──
    if (payStatus === "pending") {
      if (!isPix) return new Response("ok", { status: 200 });

      const user = await getUser(record.user_id);
      if (!user) return new Response("ok", { status: 200 });

      if (!(await claimEmail(record.id, "pending"))) {
        return new Response("ok", { status: 200 }); // já enviado
      }

      try {
        const pix = await ensurePixQr(record);
        await sendPaymentPending(user.email, user.name, user.plan, Number(record.amount) / 100, {
          paymentId: record.asaas_pay_id,
          dueDate: record.due_date,
          invoiceUrl: record.invoice_url,
          pixCode: record.pix_code,
          pixQrCode: record.pix_qrcode || pix?.encodedImage || null,
        });
      } catch (err) {
        console.error("falha ao enviar e-mail de pagamento pendente:", errMsg(err));
      }

      return new Response("ok", { status: 200 });
    }

    // ── PAGAMENTO APROVADO/CONFIRMADO ──
    if (payStatus !== "received") return new Response("ok", { status: 200 });

    const user = await getUser(record.user_id);
    if (!user) return new Response("ok", { status: 200 });

    // 1) E-mail "Pagamento aprovado" (ordem obrigatória: antes do acesso)
    if (await claimEmail(record.id, "approved")) {
      try {
        await sendPaymentApproved(user.email, user.name, user.plan, Number(record.amount) / 100, {
          paymentId: record.asaas_pay_id,
          method: record.payment_method,
          paidAt: record.paid_at,
          couponCode: record.coupon_code,
        });
      } catch (err) {
        console.error("falha ao enviar e-mail de pagamento aprovado:", errMsg(err));
        return new Response("ok", { status: 200 });
      }
    }

    // 2) Usuário no Supabase Auth com senha provisória
    const password = crypto.randomUUID().slice(0, 12) + "A1!";
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({
        email: user.email,
        password,
        email_confirm: true,
        user_metadata: { name: user.name, phone: user.phone },
      }),
    });

    const authData = await authRes.json().catch(() => ({}));

    // 422 = e-mail já existe; conta já ativa → envia link de redefinição
    if (authRes.status === 422) {
      if (await claimEmail(record.id, "access")) {
        try {
          await sendAccessRecovery(user.email, user.name, await recoveryLink(user.email));
        } catch (err) {
          console.error("falha ao enviar e-mail de acesso (conta existente):", errMsg(err));
        }
      }
      return new Response("ok", { status: 200 });
    }

    const authUserId = authRes.ok ? authData.id : null;
    if (!authUserId) {
      return new Response(`falha ao criar auth user: ${authRes.status} ${JSON.stringify(authData)}`, { status: 400 });
    }

    // Atualiza o users local: id = auth.uid e status ativo,
    // a FK payments.user_id (ON UPDATE CASCADE) acompanha o id.
    await api(`users?id=eq.${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        id: authUserId,
        status: "active",
        current_period_start: new Date().toISOString(),
      }),
    });

    // 3) E-mail "Dados de acesso" — somente após pagamento aprovado
    if (await claimEmail(record.id, "access")) {
      try {
        await sendAccessCredentials(user.email, user.name, password);
      } catch (err) {
        console.error("falha ao enviar e-mail de dados de acesso:", errMsg(err));
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`erro: ${errMsg(err)}`, { status: 400 });
  }
});
