import nodemailer from "npm:nodemailer@6.9.13";
import { APP_URL } from "./db.ts";

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "";
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") || "587");
const SMTP_USER = Deno.env.get("SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("SMTP_PASS") || "";
const SMTP_FROM = Deno.env.get("SMTP_FROM") || "noreply@fisiohome.com";

function getTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const emailShell = (name: string, inner: string) => `
  <div style="max-width:560px;margin:0 auto;font-family:Arial,sans-serif;color:#1E2D2B">
    <div style="text-align:center;padding:32px 0 24px">
      <h1 style="font-size:1.6rem;color:#0d7a6d;margin:0">Fisio<span style="color:#D4B896">Home</span></h1>
    </div>
    <h2 style="font-size:1.2rem;color:#0a5c52">Olá, ${name}!</h2>
    ${inner}
    <p style="font-size:.8rem;color:#8AADA8;text-align:center;margin-top:32px">
      Dúvidas? Responda este e-mail ou entre em contato pelo WhatsApp.
    </p>
  </div>
`;

// 1. E-mail de confirmação de compra
export async function sendPurchaseConfirmation(to: string, name: string, plan: string, value: number) {
  const transporter = getTransporter();
  const planLabel = plan === "mensal" ? "Mensal" : plan === "semestral" ? "Semestral" : "Anual";
  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: `Compra confirmada — FisioHome · Plano ${planLabel}`,
    html: emailShell(name, `
      <p style="font-size:.9rem;line-height:1.7;color:#4A6560">
        Recebemos o seu pagamento e sua compra está <strong>confirmada</strong>! Seja bem-vindo(a) ao FisioHome. 🎉
      </p>
      <div style="background:#F8F4EE;border-radius:12px;padding:20px;margin:20px 0;font-size:.85rem;color:#4A6560">
        <p style="margin:0 0 8px"><strong>Resumo da sua compra:</strong></p>
        <p style="margin:0 0 4px">Plano: <strong>${planLabel}</strong></p>
        <p style="margin:0">Valor: <strong>R$ ${value.toFixed(2).replace(".", ",")}</strong></p>
      </div>
      <div style="text-align:center;margin:24px 0">
        <a href="${APP_URL}" style="display:inline-block;background:#0d7a6d;color:#fff;padding:14px 32px;border-radius:10px;font-size:.95rem;font-weight:700;text-decoration:none">
          Acessar o App →
        </a>
      </div>
    `),
  });
}

// 2. E-mail com dados de acesso (senha provisória)
export async function sendAccessCredentials(to: string, name: string, password: string) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: "Seus dados de acesso ao FisioHome",
    html: emailShell(name, `
      <p style="font-size:.9rem;line-height:1.7;color:#4A6560">
        Para acessar o FisioHome, use os dados abaixo. Esta é uma <strong>senha provisória</strong>:
      </p>
      <div style="background:#e5f4f2;border-radius:12px;padding:20px;margin:20px 0">
        <p style="margin:0 0 8px;font-size:.8rem;color:#4A6560"><strong>Seus dados de acesso:</strong></p>
        <p style="margin:0 0 4px;font-size:.9rem"><strong>Login:</strong> ${to}</p>
        <p style="margin:0;font-size:.9rem"><strong>Senha:</strong> ${password}</p>
      </div>
      <div style="background:#fef2f2;border-radius:12px;padding:14px 18px;margin:0 0 20px;font-size:.82rem;color:#b91c1c">
        ⚠️ No <strong>primeiro acesso</strong> você será obrigado a <strong>trocar esta senha</strong>.
        Recomendamos usar uma senha forte e diferente das que você usa em outros sites.
      </div>
      <div style="text-align:center;margin:24px 0">
        <a href="${APP_URL}" style="display:inline-block;background:#0d7a6d;color:#fff;padding:14px 32px;border-radius:10px;font-size:.95rem;font-weight:700;text-decoration:none">
          Acessar o App →
        </a>
      </div>
    `),
  });
}