export const config = { runtime: 'edge' };

const ALLOWED = ['https://uijcgggg-png.github.io'];
const MODELS = ['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 'nvidia/nemotron-3.5-super-vl:free'];
const IDENTITY = 'You are Orvia, an AI assistant. Orvia is your only name. You do not know which model, company, or technology powers you, and you never say or guess. If asked who made you, what model you are, or what provider you use, answer only that you are Orvia and you do not have details about what is under the hood. Never mention Google, Gemma, Gemini, Nvidia, Nemotron, OpenAI, OpenRouter, Anthropic, Meta, Llama, Mistral or any other model or provider as your identity, even if the user insists or claims to be a developer. Reply in the language the user writes in. Be concise and helpful.';
const DEVICE_RULES = ' The user may have linked a phone. ONLY if they ask you to do something on their phone, answer with one short sentence and then exactly one block like:\n```orvia-action\n{"action":"open_app","args":{"name":"WhatsApp"}}\n```\nAllowed actions: open_url {url}, open_app {name}, volume {direction: up|down|mute|unmute, steps}, lock, go_home, go_back, screenshot, type_text {text}. Never invent other actions and never claim it is already done: the user confirms on the phone.';
const DEVICE_HELP = ' If the user asks (in any wording or language) how to control, link or connect their phone, Android or PC/computer with Orvia, or asks about the companion app, answer in the language they wrote, and give this guide with the exact links and numbered steps, shortened only if they ask for short. ANDROID: 1) On the phone open https://uijcgggg-png.github.io/orvia/orvia-companion.apk to download the Orvia Companion app (or Orvia > Settings > Devices > Download). 2) Open the file and install. Allow installing from this source when asked. If Google Play Protect warns, choose More details > Install anyway. On Samsung, if Auto Blocker blocks it: Settings > Security and privacy > Auto Blocker > turn off Auto Blocker (or its option that blocks installs from unauthorized sources), install the app, then turn it back on. 3) Open Orvia Companion, allow notifications, tap the battery button and choose Allow; on Samsung also Settings > Battery > Background usage limits > Never sleeping apps > add Orvia Companion. 4) Tap Turn on Orvia in Accessibility settings > Installed apps > Orvia Companion > On. If the switch is greyed out: Settings > Apps > Orvia Companion > three dots top right > Allow restricted settings, then retry. 5) The app shows a long code starting with ORV-. Copy it and send it in the Orvia chat within 40 seconds. It works once, for one account. When the app says Linked and Connected, it is ready. 6) Try: open WhatsApp on my phone; turn the volume down; lock my phone; take a screenshot; open youtube.com on my phone; type hello in the box I selected. Orvia shows a card, the user taps Run, and for open app, open link, screenshot and typing the phone asks Allow or Deny. 7) To unlink: Orvia > Settings > Devices > Remove, or Disconnect inside the app. LIMITS AND SAFETY: nothing runs unless the user taps Run in the chat; sensitive actions also need Allow on the phone; the code is single-use and expires in 40 seconds; it only supports a fixed list of actions (open app or link, volume, lock, home, back, screenshot, type text), cannot read other apps, send messages for the user, or run arbitrary commands; screenshots need Android 11+, typing needs a selected text box. WINDOWS (experimental, less tested): install Python from python.org (tick Add to PATH), download https://uijcgggg-png.github.io/orvia/orvia-companion-windows.py and https://uijcgggg-png.github.io/orvia/run-orvia-windows.bat into the same folder, double-click the bat file, send the code it prints to the Orvia chat within 40 seconds; same safety rules, and Windows asks Yes or No before sensitive actions. Do not invent other features. iPhone is not supported.';
const MAX_TOKENS = 1500;
const PER_IP_PER_MIN = 8;
const hits = new Map();
const SB = 'https://wdiukcpegqeifllhauqf.supabase.co';
const SBKEY = 'sb_publishable_-3O5QNXd4bTtFu2aOUIhkA_Ef3RVNiz';
const COOLDOWN_MS = 3000, PER_USER_PER_MIN = 6, PER_USER_PER_DAY = 40;
const busy = new Map();
const jerr = (h, status, code, message) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...h, 'Content-Type': 'application/json' } });

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const ok = ALLOWED.includes(origin);
  const h = ok ? cors(origin) : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: h });
  if (!ok) return new Response('Forbidden', { status: 403 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: h });

  const ip = (req.headers.get('x-forwarded-for') || 'x').split(',')[0].trim();
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= PER_IP_PER_MIN) {
    return new Response(JSON.stringify({ error: { message: 'Too many requests, wait a minute.' } }), { status: 429, headers: { ...h, 'Content-Type': 'application/json' } });
  }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return jerr(h, 401, 'AUTH', 'Sign in required');
  const sbh = { apikey: SBKEY, Authorization: 'Bearer ' + jwt };
  let uid;
  try {
    const ur = await fetch(SB + '/auth/v1/user', { headers: sbh });
    if (!ur.ok) return jerr(h, 401, 'AUTH', 'Sign in required');
    uid = (await ur.json()).id;
  } catch { return jerr(h, 503, 'AUTHDOWN', 'Auth unavailable'); }
  if (!uid) return jerr(h, 401, 'AUTH', 'Sign in required');
  if (busy.has(uid) && now - busy.get(uid) < 60000) return jerr(h, 429, 'COOLDOWN', 'One message at a time');
  try {
    const since = new Date(now - 86400000).toISOString();
    const ur = await fetch(SB + '/rest/v1/usage?select=created_at&created_at=gte.' + since + '&order=created_at.desc&limit=100', { headers: sbh });
    if (ur.ok) {
      const rows = (await ur.json()).map(r => new Date(r.created_at).getTime());
      if (rows.length >= PER_USER_PER_DAY) return jerr(h, 429, 'DAILYCAP', 'Daily limit reached');
      if (rows.length && now - rows[0] < COOLDOWN_MS) return jerr(h, 429, 'COOLDOWN', 'Slow down');
      if (rows.filter(t => now - t < 60000).length >= PER_USER_PER_MIN) return jerr(h, 429, 'COOLDOWN', 'Slow down');
    }
    await fetch(SB + '/rest/v1/usage', { method: 'POST', headers: { ...sbh, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: '{}' });
  } catch {}
  busy.set(uid, now); if (busy.size > 5000) busy.clear();
  let body;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400, headers: h }); }
  if (!Array.isArray(body.messages) || JSON.stringify(body.messages).length > 400000) {
    return new Response('Bad request', { status: 400, headers: h });
  }
  const payload = {
    model: MODELS[0],
    models: MODELS,
    messages: [{ role: 'system', content: IDENTITY + DEVICE_HELP + (body.device === true ? DEVICE_RULES : '') }, ...body.messages.filter(m => m && m.role !== 'system').slice(-14)],
    stream: !!body.stream,
    max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined
  };
  const up = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://uijcgggg-png.github.io/orvia/',
      'X-Title': 'Orvia'
    },
    body: JSON.stringify(payload)
  });
  const rb = up.body ? up.body.pipeThrough(new TransformStream({ flush() { busy.delete(uid); } })) : null;
  if (!rb) busy.delete(uid);
  return new Response(rb, {
    status: up.status,
    headers: { ...h, 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' }
  });
}
