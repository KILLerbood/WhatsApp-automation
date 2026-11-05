// Linked-device mode (unofficial, like WhatsApp Web). Lazy-loads Baileys so the app works without it.
const fs = require('fs'), path = require('path');
const DATA = process.env.DATA_DIR || __dirname; try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
const AUTH = path.join(DATA, 'auth');
const USAGE = path.join(DATA, 'usage.json');
const L = { state: 'none', code: '', number: '', error: '', sock: null, starting: false };
let B = null;

async function load() {
  if (B) return B;
  try { B = await import('@whiskeysockets/baileys'); return B; }
  catch (e) { throw new Error('مكتبة الربط مش متثبتة. شغّل install.bat الأول (أو: npm install)'); }
}
const silent = { level: 'silent', child() { return silent; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

const LOG = path.join(DATA, 'link.log');
const log = m => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n'); } catch {} };
const fmt = c => { c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c; };

let gen = 0;
async function start(phone) {
  if (phone) { gen++; const old = L.sock; L.sock = null; L.starting = false; L.code = ''; if (old) { try { old.ev.removeAllListeners('connection.update'); old.end(undefined); } catch {} } }
  if (L.starting) return; L.starting = true; L.error = ''; const my = gen;
  try {
    const b = await load(); const make = b.default.default || b.default || b.makeWASocket;
    if (phone) { try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch {} } // fresh pairing each time
    const { state, saveCreds } = await b.useMultiFileAuthState(AUTH);
    const { version } = await b.fetchLatestBaileysVersion().catch(() => ({}));
    log('start phone=' + (phone || '-') + ' version=' + version + ' registered=' + !!state.creds.registered);
    const sock = make({ auth: state, version, logger: silent, printQRInTerminal: false, browser: b.Browsers.macOS('Chrome'), syncFullHistory: false, markOnlineOnConnect: false });
    L.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    let asked = false;
    sock.ev.on('connection.update', async u => {
      if (my !== gen) return;
      log('update ' + JSON.stringify({ c: u.connection, qr: !!u.qr, sc: u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode }));
      if ((u.qr || u.connection === 'connecting') && !state.creds.registered && phone && !asked) {
        asked = true;
        try { await new Promise(r => setTimeout(r, 1500)); const c = await sock.requestPairingCode(phone); L.code = fmt(c); L.state = 'pairing'; log('code ' + L.code); }
        catch (e) { L.error = 'تعذر إنشاء الكود: ' + e.message; log('code error ' + e.message); asked = false; }
      }
      if (u.connection === 'open') { L.state = 'connected'; L.code = ''; L.error = ''; L.number = (sock.user.id || '').split(':')[0].split('@')[0]; log('open ' + L.number); }
      if (u.connection === 'close') {
        const sc = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
        L.sock = null; L.starting = false;
        if (sc === b.DisconnectReason.loggedOut) { L.state = 'none'; L.number = ''; L.code = ''; try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch {} }
        else if (state.creds.registered) { L.state = 'connecting'; L.code = ''; setTimeout(() => start(''), 2000); } // normal after entering the code (515)
        else if (L.state === 'pairing') { L.state = 'none'; L.code = ''; L.error = 'الكود انتهى أو اترفض. اطلب كود جديد واكتبه بسرعة (خلال دقيقة).'; }
      }
    });
    if (state.creds.registered) L.state = 'connecting';
  } catch (e) { L.error = e.message; log('start error ' + e.stack); L.starting = false; L.state = 'none'; }
}
async function logout() {
  try { if (L.sock) await L.sock.logout(); } catch {}
  L.sock = null; L.state = 'none'; L.code = ''; L.number = ''; L.starting = false;
  try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch {}
}
function autostart() { if (fs.existsSync(path.join(AUTH, 'creds.json'))) start(''); }

async function check(number) { // is the number on WhatsApp?
  try { const r = await L.sock.onWhatsApp(number + '@s.whatsapp.net'); return !!(r && r[0] && r[0].exists); } catch { return true; }
}
async function sendText(number, text, atts = []) {
  if (L.state !== 'connected' || !L.sock) throw new Error('واتساب مش متصل');
  const jid = number + '@s.whatsapp.net';
  try { await L.sock.sendPresenceUpdate('composing', jid); } catch {}
  await new Promise(r => setTimeout(r, Math.min(6000, 800 + text.length * 40)));
  let id = '';
  if (!atts.length) { const m = await L.sock.sendMessage(jid, { text }); id = m && m.key && m.key.id; }
  for (let k = 0; k < atts.length; k++) {
    const a = atts[k], caption = k === 0 ? text : undefined;
    const msg = a.mime.startsWith('image/') ? { image: a.buf, caption, mimetype: a.mime }
      : { document: a.buf, mimetype: a.mime, fileName: a.name, caption };
    const m = await L.sock.sendMessage(jid, msg); id = id || (m && m.key && m.key.id);
    if (k < atts.length - 1) await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
  }
  try { await L.sock.sendPresenceUpdate('paused', jid); } catch {}
  return id;
}
// daily cap bookkeeping
const today = () => new Date().toISOString().slice(0, 10);
function used() { try { const u = JSON.parse(fs.readFileSync(USAGE, 'utf8')); return u.day === today() ? u.n : 0; } catch { return 0; } }
function bump() { fs.writeFileSync(USAGE, JSON.stringify({ day: today(), n: used() + 1 })); }
const status = () => ({ state: L.state, code: L.code, number: L.number, error: L.error, usedToday: used() });
module.exports = { start, logout, autostart, status, check, sendText, used, bump };
