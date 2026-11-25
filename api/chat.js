export const config = { runtime: 'edge' };

const ALLOWED = ['https://uijcgggg-png.github.io'];
const MODELS = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3.5-super-vl:free'];
const MAX_TOKENS = 1500;
const PER_IP_PER_MIN = 8;
const hits = new Map();

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  let body;
  try { body = await req.json(); } catch { return new Response('Bad JSON', { status: 400, headers: h }); }
  if (!Array.isArray(body.messages) || JSON.stringify(body.messages).length > 400000) {
    return new Response('Bad request', { status: 400, headers: h });
  }
  const payload = {
    model: MODELS[0],
    models: MODELS,
    messages: body.messages,
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
  return new Response(up.body, {
    status: up.status,
    headers: { ...h, 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' }
  });
}
