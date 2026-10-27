// Triggers your existing GitHub Actions workflow on demand, so it runs in seconds instead of
// waiting for GitHub's lagging */5 cron.
//   - POST /discourse : Discourse webhook (topic/post events)  -> dispatch immediately
//   - cron (wrangler.toml [triggers])                          -> dispatch as a backstop
// The sync logic itself stays in .github/scripts/sync-topics.js; this only starts it.

async function validSignature(secret, body, header) {
  if (!secret || !header) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.trim().toLowerCase();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function dispatch(env) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "frontline-trigger",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
    }
  );
  if (res.status !== 204) throw new Error(`GitHub dispatch ${res.status}: ${await res.text()}`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/discourse") return new Response("ok");

    const body = await request.text();
    if (!(await validSignature(env.DISCOURSE_WEBHOOK_SECRET, body, request.headers.get("X-Discourse-Event-Signature"))))
      return new Response("Bad signature", { status: 401 });

    const event = request.headers.get("X-Discourse-Event");
    if (!["topic_created", "topic_edited", "post_created"].includes(event)) return new Response("ignored");

    // Workflow has a concurrency group, so bursts of events collapse into one queued run.
    ctx.waitUntil(dispatch(env).catch((e) => console.error(e.message)));
    return new Response("dispatched", { status: 202 });
  },

  async scheduled(_event, env) {
    await dispatch(env);
  },
};

export { validSignature };
