import { serve } from "https://deno.land/std@0.170.0/http/server.ts";
import nodemailer from "npm:nodemailer@6.9.13";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const APP_URL = Deno.env.get("APP_URL") || "https://app.fisiohome.com";

// SMTP (mesmo configurado no Supabase Auth)
const SMTP_HOST = Deno.env.get("SMTP_HOST") || "";
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") || "587");
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const SMTP_FROM = Deno.env.get("SMTP_FROM") || "noreply@fisiohome.com";

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

function getTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendWelcomeEmail(to: string, name: string, password: string) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: "Bem-vindo ao FisioHome! 🎉",
    html: `
      <div style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;color:#1E2D2B">
        <div style="text-align:center;padding:32px 0 24px">
          <h1 style="font-size:1.6rem;color:#0d7a6d;margin:0">Fisio<span style="color:#D4B896">Home</span></h1>
        </div>

        <h2 style="font-size:1.2rem;color:#0a5c52">Olá, ${name}!</h2>
        <p style="font-size:.9rem;line-height:1.7;color:#4A6560">
          Sua assinatura foi confirmada. Seu acesso ao FisioHome já está liberado!
        </p>

        <div style="background:#F8F4EE;border-radius:12px;padding:20px;margin:20px 0">
          <p style="margin:0 0 8px;font-size:.8rem;color:#4A6560"><strong>Seus dados de acesso:</strong></p>
          <p style="margin:0 0 4px;font-size:.9rem"><strong>Login:</strong> ${to}</p>
          <p style="margin:0;font-size:.9rem"><strong>Senha:</strong> ${password}</p>
        </div>

        <div style="text-align:center;margin:24px 0">
          <a href="${APP_URL}" style="display:inline-block;background:#0d7a6d;color:#fff;padding:14px 32px;border-radius:10px;font-size:.95rem;font-weight:700;text-decoration:none">
            Acessar o App →
          </a>
        </div>

        <p style="font-size:.8rem;color:#8AADA8;text-align:center;margin-top:32px">
          Recomendamos alterar sua senha no primeiro acesso.<br>
          Dúvidas? Responda este e-mail ou entre em contato pelo WhatsApp.
        </p>
      </div>
    `,
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

    // Buscar subscription local pelo asaas_sub_id (inclui customer info)
    const subs = await api(
      `subscriptions?asaas_sub_id=eq.${subId}&select=id,customer_id,plan,status,customer:customer_id(name,email,phone)`
    ).then(r => r.json());
    const sub = subs?.[0];
    if (!sub?.id) return new Response("ok", { status: 200 });
    const localSubId = sub.id;

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

    // Se recebido: ativar subscription, criar usuário e enviar e-mail
    if (payStatus === "received") {
      const customer = sub.customer;

      await api(`subscriptions?id=eq.${localSubId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "active",
          current_period_start: new Date().toISOString(),
        }),
      });

      // Criar usuário no Supabase Auth com senha aleatória
      const password = crypto.randomUUID().slice(0, 12) + "A1!";
      const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({
          email: customer.email,
          password,
          email_confirm: true,
          user_metadata: { name: customer.name, phone: customer.phone },
        }),
      });

      const authOk = authRes.ok || (await authRes.json())?.id;
      if (authOk) {
        try {
          await sendWelcomeEmail(customer.email, customer.name, password);
        } catch {
          // E-mail não crítico
        }
      }
    }

    return new Response("ok", { status: 200 });
  } catch {
    return new Response("ok", { status: 200 });
  }
});
