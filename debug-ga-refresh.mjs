// TEMPORARY one-shot: refresh a claude RT from the GitHub Actions runner's egress, to test
// whether claude's OAuth endpoint rejects this environment's IP. Prints ok/status + egress IP/ASN
// ONLY — never the token. Reads the RT from the DEBUG_RT secret. DELETE after use.
import { refreshClaudeToken } from "./lib/token-refresh.js";

const j = async (u) => {
  try {
    return await (await fetch(u)).json();
  } catch {
    return {};
  }
};

const egress = await j("https://api.ipify.org?format=json");
const info = await j("https://ipinfo.io/json");
const rt = process.env.DEBUG_RT || "";
const r = await refreshClaudeToken(rt, null);

console.log(
  "RESULT " +
    JSON.stringify({
      ok: r.ok,
      status: r.status ?? null,
      auth_rejected: r.auth_rejected ?? null,
      error: r.ok ? null : String(r.error || "").slice(0, 100),
      egress_ip: egress.ip || null,
      asn_org: info.org || null,
      region: info.region || null,
      country: info.country || null,
      rt_len: rt.length, // length only — confirms the secret arrived, never the value
    }),
);
