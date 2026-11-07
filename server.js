// WhatsApp Broadcast Sender - no dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const env = {};
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; }); } catch {}
const API = env.WA_API_VERSION || 'v21.0', PORT = +(process.env.PORT || env.PORT || 3000);

const RULES = { '965': /^965[569]\d{7}$/, '20': /^201[0125]\d{8}$/, '966': /^9665\d{8}$/, '971': /^9715\d{8}$/ };
function normalize(raw, cc = '965') {
  const s = String(raw).trim(); const plus = s.startsWith('+');
  let d = s.replace(/\D/g, ''); if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  else if (!plus) {
    d = d.replace(/^0+/, '');
    if (!d.startsWith(cc) || (RULES[cc] && !RULES[cc].test(d))) d = cc + d;
  }
  for (const k in RULES) if (d.startsWith(k) && !RULES[k].test(d)) return null;
  return d.length >= 8 && d.length <= 15 ? d : null;
}
function parse(text, cc) {
  const seen = new Set(), ok = [], bad = []; let dup = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/[,;\t]/); let name = '', num = null;
    for (const p of parts) { const n = normalize(p, cc); if (n && !num) num = n; else if (p.trim() && !/\d{6,}/.test(p)) name = name || p.trim(); }
    if (!num) { bad.push(line.trim()); continue; }
    if (seen.has(num)) { dup++; continue; } seen.add(num); ok.push({ number: num, name });
  }
  return { ok, bad, dup };
}

// --- connection (saved locally in config.json, entered from the UI) ---
const DATA = process.env.DATA_DIR || __dirname; try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
const CFG = path.join(DATA, 'config.json');
let conf = { token: env.WA_TOKEN || process.env.WA_TOKEN || '', phoneId: env.WA_PHONE_ID || process.env.WA_PHONE_ID || '', display: '', name: '' };
try { Object.assign(conf, JSON.parse(fs.readFileSync(CFG, 'utf8'))); } catch {}
const isLive = () => !!(conf.token && conf.phoneId);

const linked = require('./linked');
let job = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function uploadMedia(a) {
  const fd = new FormData(); fd.append('messaging_product', 'whatsapp'); fd.append('type', a.mime);
  fd.append('file', new Blob([a.buf], { type: a.mime }), a.name);
  const r = await fetch(`https://graph.facebook.com/${API}/${conf.phoneId}/media`, { method: 'POST', headers: { Authorization: 'Bearer ' + conf.token }, body: fd });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.id) throw new Error('رفع الملف فشل: ' + ((j.error && j.error.message) || r.status)); return j.id;
}
async function post(body) {
  const res = await fetch(`https://graph.facebook.com/${API}/${conf.phoneId}/messages`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + conf.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, id: j.messages && j.messages[0] && j.messages[0].id } : { ok: false, err: (j.error && j.error.message) || res.status };
}
async function sendOne(r, o) {
  if (!isLive()) { await sleep(60); return { ok: true, id: 'dry-run' }; }
  const base = { messaging_product: 'whatsapp', to: r.number };
  if (o.mode === 'template') return post({ ...base, type: 'template', template: { name: o.template, language: { code: o.lang || 'ar' },
    components: o.useName ? [{ type: 'body', parameters: [{ type: 'text', text: r.name || 'عميلنا' }] }] : [] } });
  const text = o.text.replace(/\{name\}/g, r.name || '');
  if (!o.atts.length) return post({ ...base, type: 'text', text: { body: text } });
  let first = null;
  for (let k = 0; k < o.atts.length; k++) {
    const a = o.atts[k]; if (!a.mediaId) a.mediaId = await uploadMedia(a);
    const img = a.mime.startsWith('image/'), cap = k === 0 ? text : undefined;
    const vid = a.mime.startsWith('video/');
    const x = await post(img ? { ...base, type: 'image', image: { id: a.mediaId, caption: cap } }
      : vid ? { ...base, type: 'video', video: { id: a.mediaId, caption: cap } }
      : { ...base, type: 'document', document: { id: a.mediaId, filename: a.name, caption: cap } });
    if (!x.ok) return x; first = first || x;
  }
  return first;
}
const MEDIA_OK = /^(image\/(jpeg|png|webp)|application\/pdf|video\/(mp4|quicktime|3gpp|webm))$/;
// --- free AI "improve message" (Google Gemini free tier; key saved in DATA_DIR/ai.json or GEMINI_API_KEY) ---
const AIF = path.join(DATA, 'ai.json'), AI_MODEL = process.env.GEMINI_MODEL || env.GEMINI_MODEL || 'gemini-flash-latest';
const aiKey = () => { try { return JSON.parse(fs.readFileSync(AIF, 'utf8')).key || ''; } catch { return process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || ''; } };
const AI_SYS = 'You rewrite WhatsApp broadcast messages for a small business. Keep the same language and dialect as the input (if it is Arabic, keep the same Arabic dialect, e.g. Egyptian). Make it clear, friendly and well organised: short lines, a catchy first line, a few fitting emojis (not too many), WhatsApp formatting such as *bold* for key points, and a clear call to action. Keep every placeholder like {name} exactly as written. Never invent facts, prices, dates, links or phone numbers that are not in the input. Reply with the rewritten message only, no explanations.';
async function aiImprove(text) {
  const key = aiKey(); if (!key) { const e = new Error('محتاج مفتاح Gemini المجاني الأول (دوس على زرار المفتاح)'); e.needKey = true; throw e; }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: AI_SYS }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.7 } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('خطأ من Gemini ' + r.status));
  const out = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join('').trim();
  if (!out) throw new Error('الذكاء الاصطناعي مرجّعش رد، جرّب تاني'); return out;
}
const rnd = (a, b) => (a + Math.random() * (b - a)) * 1000;
async function run(j, o) {
  let sinceBatch = 0;
  for (let i = 0; i < j.rows.length && !j.stop; i++) {
    const r = j.rows[i];
    if (o.channel === 'linked') {
      if (linked.used() >= o.dailyCap) { j.note = 'وصلت للحد اليومي (' + o.dailyCap + ')، اتوقف الإرسال لبكرة'; break; }
      if (sinceBatch >= o.batch) { j.note = 'استراحة بين الدفعات...'; await sleep(rnd(o.pauseMin * 60, o.pauseMax * 60)); j.note = ''; sinceBatch = 0; if (j.stop) break; }
      r.status = 'sending';
      try {
        if (!(await linked.check(r.number))) { r.status = 'failed'; r.info = 'الرقم مش على واتساب'; continue; }
        const txt = o.text.replace(/\{name\}/g, r.name || '') + (o.optout ? '\n\n' + o.optout : '');
        r.info = (o.blocks.length ? await linked.sendBlocks(r.number, o.blocks.map(b => ({ ...b, text: (b.text || '').replace(/\{name\}/g, r.name || '') })), o.optout) : await linked.sendText(r.number, txt, o.atts)) || ''; r.status = 'sent'; linked.bump(); sinceBatch++;
      } catch (e) { r.status = 'failed'; r.info = e.message; }
      if (i < j.rows.length - 1 && !j.stop) await sleep(rnd(o.minDelay, o.maxDelay));
      continue;
    }
    if (i && i % o.batch === 0) { j.note = `استراحة بين الدفعات ${o.pause} ثانية`; await sleep(o.pause * 1000); j.note = ''; }
    r.status = 'sending';
    try { const x = await sendOne(r, o); r.status = x.ok ? 'sent' : 'failed'; r.info = x.ok ? x.id : x.err; } catch (e) { r.status = 'failed'; r.info = e.message; }
    if (o.delay) await sleep(o.delay);
  }
  j.rows.forEach(r => { if (r.status === 'queued') r.status = 'stopped'; }); j.done = true;
}

const readBody = req => new Promise(r => { let b = ''; req.setEncoding('utf8'); req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const json = (res, o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

// --- password protection (set APP_PASSWORD to enable; required when hosted online) ---
const crypto = require('crypto');
const PASS = process.env.APP_PASSWORD || env.APP_PASSWORD || '';
const HOSTED = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
if (HOSTED && PASS.length < 8) { console.error('APP_PASSWORD (8+ chars) is required when running online. Refusing to start.'); process.exit(1); }
const sessions = new Set(), tries = new Map();
const cookieTok = req => ((req.headers.cookie || '').match(/(?:^|;\s*)wa_s=([a-f0-9]{64})/) || [])[1];
const bearerTok = req => ((req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/) || [])[1];
const authed = req => !PASS || sessions.has(cookieTok(req)) || sessions.has(bearerTok(req));
// Allow the GitHub Pages frontend (or any origin listed in ALLOWED_ORIGINS) to call this server (bridge mode)
const ORIGINS = (process.env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || 'https://killerbood.github.io').split(',').map(x => x.trim()).filter(Boolean);
const eq = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };
const LOGIN = fs.readFileSync(path.join(__dirname, 'login.html'));

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url === '/healthz') return json(res, { ok: true });
  if (PASS) {
    if (url === '/login' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN); }
    if (url === '/api/login' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(), now = Date.now();
      const t = (tries.get(ip) || []).filter(x => now - x < 15 * 60e3);
      if (t.length >= 8) return json(res, { error: 'محاولات كتير، استنى ربع ساعة' }, 429);
      const b = await readBody(req);
      if (!eq(String(b.password || ''), PASS)) { t.push(now); tries.set(ip, t); return json(res, { error: 'الباسورد غلط' }, 401); }
      tries.delete(ip); const tok = crypto.randomBytes(32).toString('hex'); sessions.add(tok);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `wa_s=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}` });
      return res.end(JSON.stringify({ ok: true, token: tok }));
    }
    if (url === '/api/logout' && req.method === 'POST') { sessions.delete(cookieTok(req)); sessions.delete(bearerTok(req)); res.writeHead(200, { 'Set-Cookie': 'wa_s=; Path=/; Max-Age=0' }); return res.end(); }
    if (!authed(req)) {
      if (url.startsWith('/api/')) return json(res, { error: 'سجّل دخول الأول' }, 401);
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
  }
  if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
  if (req.url === '/api/config') return json(res, { live: isLive(), display: conf.display, name: conf.name, auth: !!PASS });
  if (req.url === '/api/connect' && req.method === 'POST') {
    const b = await readBody(req); const token = String(b.token || '').trim(), phoneId = String(b.phoneId || '').trim();
    if (!token || !phoneId) return json(res, { error: 'اكتب الـ Token والـ Phone Number ID' }, 400);
    try {
      const r = await fetch(`https://graph.facebook.com/${API}/${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name`, { headers: { Authorization: 'Bearer ' + token } });
      const j = await r.json();
      if (!r.ok) return json(res, { error: (j.error && j.error.message) || 'فشل الاتصال، راجع البيانات' }, 400);
      conf = { token, phoneId, display: j.display_phone_number || '', name: j.verified_name || '' };
      fs.writeFileSync(CFG, JSON.stringify(conf)); return json(res, { ok: true, display: conf.display, name: conf.name });
    } catch (e) { return json(res, { error: 'مفيش اتصال بالإنترنت: ' + e.message }, 500); }
  }
  if (req.url === '/api/disconnect' && req.method === 'POST') { conf = { token: '', phoneId: '', display: '', name: '' }; try { fs.unlinkSync(CFG); } catch {} return json(res, { ok: true }); }
  if (req.url === '/api/parse' && req.method === 'POST') { const b = await readBody(req); return json(res, parse(b.text, b.cc || '965')); }
  if (req.url === '/api/send' && req.method === 'POST') {
    if (job && !job.done) return json(res, { error: 'في إرسال شغال دلوقتي' }, 409);
    const b = await readBody(req);
    if (!Array.isArray(b.rows) || !b.rows.length) return json(res, { error: 'مفيش أرقام' }, 400);
    if (b.channel === 'linked' && linked.status().state !== 'connected') return json(res, { error: 'اربط واتساب الأول (الربط بالكود)' }, 400);
    const atts = (Array.isArray(b.atts) ? b.atts : []).slice(0, 5).map(a => ({ name: String(a.name || 'file').slice(0, 100), mime: String(a.mime || ''), buf: Buffer.from(String(a.data || ''), 'base64') })).filter(a => MEDIA_OK.test(a.mime) && a.buf.length);
    if (atts.some(a => a.buf.length > (a.mime.startsWith('video/') ? 50e6 : 16e6))) return json(res, { error: 'الملف كبير (الحد 16 ميجا للصور وPDF، و50 ميجا للفيديو)' }, 400);
    const blocks = (Array.isArray(b.blocks) ? b.blocks : []).slice(0, 10).map(x => x && x.kind === 'text' ? { kind: 'text', text: String(x.text || '').slice(0, 4000) }
      : { kind: 'media', text: String(x.text || '').slice(0, 1000), name: String((x && x.name) || 'file').slice(0, 100), mime: String((x && x.mime) || ''), buf: Buffer.from(String((x && x.data) || ''), 'base64') })
      .filter(x => x.kind === 'text' ? x.text.trim() : (MEDIA_OK.test(x.mime) && x.buf.length && x.buf.length <= (x.mime.startsWith('video/') ? 50e6 : 16e6)));
    if (blocks.length && b.channel !== 'linked') return json(res, { error: 'الأجزاء المرتبة شغالة مع الربط بالكود بس' }, 400);
    if (b.mode === 'template' ? !b.template : !(b.text || atts.length || blocks.length)) return json(res, { error: 'اكتب الرسالة أو اسم القالب' }, 400);
    job = { rows: b.rows.slice(0, +b.limit > 0 ? +b.limit : 1000).map(r => ({ number: r.number, name: r.name || '', status: 'queued', info: '' })), done: false, stop: false, live: b.channel === 'linked' || isLive(), note: '' };
    run(job, { blocks, channel: b.channel, minDelay: Math.max(3, +b.minDelay || 8), maxDelay: Math.max(+b.minDelay || 8, +b.maxDelay || 20), pauseMin: +b.pauseMin || 2, pauseMax: Math.max(+b.pauseMin || 2, +b.pauseMax || 4), dailyCap: +b.dailyCap || 100, optout: String(b.optout || '').slice(0, 200), atts, mode: b.mode, template: b.template, lang: b.lang, text: String(b.text || ''), useName: !!b.useName, batch: Math.max(1, +b.batch || 50), pause: Math.max(0, +b.pause || 60), delay: Math.max(0, +b.delay || 1000) });
    return json(res, { ok: true });
  }
  if (req.url === '/api/ai/key' && req.method === 'POST') {
    const b = await readBody(req); const key = String(b.key || '').trim().slice(0, 200);
    try { if (key) fs.writeFileSync(AIF, JSON.stringify({ key })); else fs.unlinkSync(AIF); } catch {}
    return json(res, { ok: true, hasKey: !!aiKey() });
  }
  if (req.url === '/api/ai/improve' && req.method === 'POST') {
    const b = await readBody(req); const text = String(b.text || '').trim().slice(0, 3000);
    if (!text) return json(res, { error: 'اكتب نص الأول' }, 400);
    try { return json(res, { text: await aiImprove(text) }); } catch (e) { return json(res, { error: e.message, needKey: !!e.needKey }, e.needKey ? 400 : 502); }
  }
  if (req.url === '/api/link/status') return json(res, linked.status());
  if (req.url === '/api/link/start' && req.method === 'POST') { const b = await readBody(req); let ph = String(b.phone || '').replace(/\D/g, '').replace(/^00/, ''); if (/^[569]\d{7}$/.test(ph)) ph = '965' + ph; if (/^01[0125]\d{8}$/.test(ph)) ph = '20' + ph.slice(1); if (ph.length < 8) return json(res, { error: 'اكتب رقمك بالكود الدولي، مثلاً 96566012345' }, 400); linked.start(ph); return json(res, { ok: true }); }
  if (req.url === '/api/link/logout' && req.method === 'POST') { await linked.logout(); return json(res, { ok: true }); }
  if (req.url === '/api/job') return json(res, job || { rows: [], done: true });
  if (req.url === '/api/stop' && req.method === 'POST') { if (job) job.stop = true; return json(res, { ok: true }); }
  res.writeHead(404); res.end();
}).listen(PORT, () => { linked.autostart();
  console.log(`http://localhost:${PORT}  (${isLive() ? 'LIVE - إرسال حقيقي' : 'تجريبي - من غير إرسال فعلي'})`); });

// Render free plan sleeps after ~15 min without inbound HTTP; ping our own public URL so sends keep running.
if (process.env.RENDER_EXTERNAL_URL) setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + '/healthz').catch(() => {}); }, 4 * 60 * 1000);
