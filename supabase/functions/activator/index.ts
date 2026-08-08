import { serve } from "https://deno.land/std@0.170.0/http/server.ts";
import { api, SUPABASE_URL, SERVICE_KEY } from "../_shared/db.ts";
import { sendPurchaseConfirmation, sendAccessCredentials } from "../_shared/email.ts";

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  try {
    const webhook = await req.json();
    const record = webhook?.record || webhook?.payment || webhook;

    // Chamado pelo Database Webhook do Supabase quando payments muda.
    // Payload: { type, table, schema, record: { ... }, old_record: {...} }
    const payStatus = record?.status;

    if (!record?.user_id || payStatus !== "received") {
      return new Response("ok", { status: 200 });
    }

    const users = await api(
      `users?id=eq.${record.user_id}&select=id,name,email,phone,plan,status`
    ).then(r => r.json());
    const user = Array.isArray(users) ? users[0] : users;

    if (!user?.id) return new Response("ok", { status: 200 });

    // Cria o usuário no Supabase Auth com senha provisória
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

    // 422 = e-mail já existe; usuário já ativo, não duplicar
    if (authRes.status === 422) {
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

    await sendPurchaseConfirmation(user.email, user.name, user.plan, Number(record.amount) / 100);
    await sendAccessCredentials(user.email, user.name, password);

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`erro: ${err.message || err}`, { status: 400 });
  }
});