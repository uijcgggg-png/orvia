export const config = { runtime: 'edge' };

const SB = 'https://wdiukcpegqeifllhauqf.supabase.co';
const SBKEY = 'sb_publishable_-3O5QNXd4bTtFu2aOUIhkA_Ef3RVNiz';
const MODELS = ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-26b-a4b-it:free'];
const SYSTEM = `You control an Android phone for the user, one step at a time. Each turn you get the GOAL, the HISTORY of your previous steps, and the current SCREEN as a list of UI elements: [index] kind "text" (flags). Reply with ONLY one JSON object, no prose, no code fences:
{"thought":"short reason","action":"...", ...params}
Actions:
- {"action":"tap","index":N}  tap element N (prefer this)
- {"action":"tap_xy","x":N,"y":N}  only if no element fits
- {"action":"type","index":N,"text":"..."}  put text in input element N (replaces its text)
- {"action":"scroll","direction":"down|up|left|right"}
- {"action":"press","key":"back|home|enter|recents"}
- {"action":"open_app","name":"App name"}
- {"action":"wait","seconds":2}
- {"action":"done","summary":"what was done"}
- {"action":"fail","reason":"why it cannot be done"}
Rules: do the smallest next step. Never type or request passwords, PINs, card numbers or codes. Refuse banking, wallet and payment apps and purchases: use fail. For anything irreversible (sending a message, posting, deleting, buying, changing settings) add "risky":true to that action. Use exactly the text the user asked for when typing. If the screen is not what you expected, scroll or go back; do not repeat the same failing action more than twice. When the goal is achieved, use done. Answer in the user's language inside summary/reason.`;

export default async function handler(req) {
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (req.method !== 'POST') return J({ error: 'method' }, 405);
  let b;
  try { b = await req.json(); } catch { return J({ error: 'bad json' }, 400); }
  const { device_id, secret } = b || {};
  if (!device_id || !secret || typeof secret !== 'string' || String(JSON.stringify(b)).length > 60000) return J({ error: 'bad request' }, 400);
  const g = await fetch(SB + '/rest/v1/rpc/agent_gate', { method: 'POST', headers: { apikey: SBKEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_device: device_id, p_secret: secret }) });
  if (!g.ok) {
    let m = ''; try { m = (await g.json()).message || ''; } catch {}
    return J({ error: m || 'denied' }, m.includes('unauthorized') ? 401 : 429);
  }
  const user = 'GOAL: ' + String(b.goal || '').slice(0, 600) + '\nSTEP: ' + (b.step | 0) + ' of ' + (b.max | 0) +
    '\nCURRENT APP: ' + String(b.pkg || '').slice(0, 100) + '\nHISTORY:\n' + String(b.history || '').slice(0, 2500) + '\nSCREEN:\n' + String(b.screen || '').slice(0, 14000);
  const up = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://uijcgggg-png.github.io/orvia/', 'X-Title': 'Orvia' },
    body: JSON.stringify({ model: MODELS[0], models: MODELS, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], max_tokens: 400, temperature: 0.1 })
  });
  if (!up.ok) return J({ error: 'model ' + up.status }, 502);
  let txt = '';
  try { const j = await up.json(); txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ''; } catch {}
  const m = String(txt).match(/\{[\s\S]*\}/);
  if (!m) return J({ error: 'empty or invalid model reply' }, 502);
  try {
    const a = JSON.parse(m[0]);
    const ok = ['tap', 'tap_xy', 'type', 'scroll', 'press', 'open_app', 'wait', 'done', 'fail'];
    if (!ok.includes(a.action)) return J({ error: 'bad action' }, 502);
    return J({ action: a });
  } catch { return J({ error: 'invalid json from model' }, 502); }
}
