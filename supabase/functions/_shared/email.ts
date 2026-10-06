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

const summaryBox = (rows: string) => `
  <div style="background:#F8F4EE;border-radius:12px;padding:20px;margin:20px 0;font-size:.85rem;color:#4A6560">
    <p style="margin:0 0 8px"><strong>Resumo da sua compra:</strong></p>
    ${rows}
  </div>
`;

const appButton = (label: string, href: string) => `
  <div style="text-align:center;margin:24px 0">
    <a href="${href}" style="display:inline-block;background:#0d7a6d;color:#fff;padding:14px 32px;border-radius:10px;font-size:.95rem;font-weight:700;text-decoration:none">
      ${label} →
    </a>
  </div>
`;

function planLabel(plan?: string) {
  return plan === "mensal" ? "Mensal" : plan === "semestral" ? "Semestral" : "Anual";
}

function methodLabel(method?: string | null) {
  if (method === "pix") return "PIX";
  if (method === "credit_card") return "Cartão de crédito";
  if (method === "boleto") return "Boleto";
  if (method === "coupon") return "Cupom promocional";
  return method || "—";
}

function money(value: number) {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function fmtDate(value?: string | null) {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString("pt-BR");
}

export interface PendingPaymentDetails {
  paymentId?: string | null;
  dueDate?: string | null;
  invoiceUrl?: string | null;
  pixCode?: string | null;
  pixQrCode?: string | null;
}

// 1. E-mail "Pagamento pendente" (PIX) — dados para o cliente pagar
export async function sendPaymentPending(
  to: string,
  name: string,
  plan: string,
  value: number,
  details: PendingPaymentDetails,
) {
  const transporter = getTransporter();
  const due = fmtDate(details.dueDate);

  const rows = [
    `<p style="margin:0 0 4px">Plano: <strong>${planLabel(plan)}</strong></p>`,
    `<p style="margin:0 0 4px">Valor: <strong>${money(value)}</strong></p>`,
    details.paymentId
      ? `<p style="margin:0 0 4px">Identificação do pagamento: <strong>${details.paymentId}</strong></p>`
      : "",
    due ? `<p style="margin:0">Vencimento: <strong>${due}</strong></p>` : "",
  ].join("");

  const pixBox = details.pixCode || details.pixQrCode
    ? `
      <div style="background:#e5f4f2;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
        <p style="margin:0 0 12px;font-size:.85rem;color:#4A6560"><strong>Pague com PIX</strong></p>
        ${details.pixQrCode
          ? `<img src="data:image/png;base64,${details.pixQrCode}" alt="QR Code PIX" style="width:200px;height:200px" />`
          : ""}
        ${details.pixCode
          ? `
            <p style="margin:16px 0 6px;font-size:.8rem;color:#4A6560"><strong>PIX copia e cola:</strong></p>
            <p style="margin:0;font-size:.8rem;word-break:break-all;background:#fff;border:1px solid #D6E5E2;border-radius:8px;padding:12px;user-select:all">${details.pixCode}</p>
          `
          : ""}
      </div>
    `
    : "";

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: `Pagamento pendente — FisioHome · Plano ${planLabel(plan)}`,
    html: emailShell(name, `
      <p style="font-size:.9rem;line-height:1.7;color:#4A6560">
        Recebemos a sua compra, mas o pagamento <strong>ainda não foi confirmado</strong>.
        Para concretizar, realize o pagamento via <strong>PIX</strong> usando os dados abaixo.
      </p>
      ${summaryBox(rows)}
      ${pixBox}
      ${details.invoiceUrl ? appButton("Concluir pagamento", details.invoiceUrl) : ""}
      <p style="font-size:.82rem;line-height:1.6;color:#4A6560">
        Assim que o pagamento for confirmado, você receberá o e-mail
        <strong>"Pagamento aprovado"</strong> com a confirmação da compra e, em seguida,
        seus dados de acesso ao FisioHome.
      </p>
    `),
  });
}

// 2. E-mail "Pagamento aprovado" — confirmação com os dados da compra
export async function sendPaymentApproved(
  to: string,
  name: string,
  plan: string,
  value: number,
  details: {
    paymentId?: string | null;
    method?: string | null;
    paidAt?: string | null;
    couponCode?: string | null;
  } = {},
) {
  const transporter = getTransporter();
  const paid = fmtDate(details.paidAt);

  const rows = [
    `<p style="margin:0 0 4px">Plano: <strong>${planLabel(plan)}</strong></p>`,
    `<p style="margin:0 0 4px">Valor: <strong>${money(value)}</strong></p>`,
    `<p style="margin:0 0 4px">Método de pagamento: <strong>${methodLabel(details.method)}</strong></p>`,
    details.paymentId
      ? `<p style="margin:0 0 4px">Identificação do pagamento: <strong>${details.paymentId}</strong></p>`
      : "",
    details.couponCode
      ? `<p style="margin:0 0 4px">Cupom aplicado: <strong>${details.couponCode}</strong></p>`
      : "",
    paid ? `<p style="margin:0">Data: <strong>${paid}</strong></p>` : "",
  ].join("");

  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: `Pagamento aprovado — FisioHome · Plano ${planLabel(plan)}`,
    html: emailShell(name, `
      <p style="font-size:.9rem;line-height:1.7;color:#4A6560">
        Seu pagamento foi <strong>aprovado</strong> e sua compra está <strong>confirmada</strong>!
        Seja bem-vindo(a) ao FisioHome. 🎉
      </p>
      ${summaryBox(rows)}
      ${appButton("Acessar o App", APP_URL)}
    `),
  });
}

// 3. E-mail com dados de acesso (senha provisória) — INALTERADO
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

// 3b. Conta já existe no Auth (compra/renovação): mesmo visual, com link de
// redefinição de senha no lugar da senha provisória.
export async function sendAccessRecovery(to: string, name: string, resetLink: string) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: SMTP_FROM,
    to,
    subject: "Seus dados de acesso ao FisioHome",
    html: emailShell(name, `
      <p style="font-size:.9rem;line-height:1.7;color:#4A6560">
        Sua compra foi confirmada e sua conta FisioHome já está ativa.
        Para entrar, defina sua senha pelo botão abaixo:
      </p>
      <div style="background:#e5f4f2;border-radius:12px;padding:20px;margin:20px 0">
        <p style="margin:0 0 8px;font-size:.8rem;color:#4A6560"><strong>Seus dados de acesso:</strong></p>
        <p style="margin:0;font-size:.9rem"><strong>Login:</strong> ${to}</p>
      </div>
      <div style="text-align:center;margin:24px 0">
        <a href="${resetLink}" style="display:inline-block;background:#0d7a6d;color:#fff;padding:14px 32px;border-radius:10px;font-size:.95rem;font-weight:700;text-decoration:none">
          Definir minha senha →
        </a>
      </div>
      <p style="font-size:.82rem;color:#8AADA8;text-align:center">
        Se o botão não funcionar, copie e cole o endereço no navegador:
        <br />${resetLink}
      </p>
    `),
  });
}
