export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
export const APP_URL = Deno.env.get("APP_URL") || "https://app.fisiohome.com";

export function api(path: string, options: RequestInit = {}) {
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

export function mapAsaasStatus(status: string): string {
  const map: Record<string, string> = {
    RECEIVED: "received",
    CONFIRMED: "received",
    OVERDUE: "overdue",
    REFUNDED: "refunded",
    CANCELLED: "canceled",
  };
  return map[status] || (status || "pending").toLowerCase();
}