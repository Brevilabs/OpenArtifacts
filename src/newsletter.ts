import type { Env } from "./config.js";

/** Optional hosted integration. Saved consent allows an activity-driven retry. */
export async function syncNewsletter(env: Env, accountId: string, fetcher = fetch): Promise<void> {
  if (!env.LICENSE_API_URL || !env.LICENSE_API_KEY) return;
  try {
    const account = await env.DB.prepare(
      "SELECT email FROM accounts WHERE id = ? AND newsletter_opt_in = 1 AND newsletter_synced_at IS NULL",
    ).bind(accountId).first<{ email: string }>();
    if (!account) return;
    const response = await fetcher(
      `${env.LICENSE_API_URL.replace(/\/+$/, "")}/api/trpc/license.openArtifactsNewsletter`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.LICENSE_API_KEY}` },
        body: JSON.stringify({ json: { email: account.email } }),
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("Newsletter unavailable");
    const result = await response.json() as { result?: { data?: { json?: { ok?: boolean } } } };
    if (result.result?.data?.json?.ok !== true) throw new Error("Newsletter unavailable");
    await env.DB.prepare(
      "UPDATE accounts SET newsletter_synced_at = ? WHERE id = ? AND email = ? AND newsletter_opt_in = 1",
    ).bind(Date.now(), accountId, account.email).run();
  } catch {
    // Never expose identity or credentials in logs; never fail account creation.
    console.warn("Newsletter signup deferred until a later account refresh");
  }
}
