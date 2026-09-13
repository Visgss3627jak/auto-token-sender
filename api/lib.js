// ============================================================
// AUTO TOKEN SENDER — shared pure helpers (no IO)
// ============================================================

// ------------------------------------------------------------
// BANK CONFIG — All Indian banks
// sms_number  → SMS balance enquiry shortcode/number
// missed_call → missed-call balance enquiry number
// scan_only   → true = no reliable trigger, balance parsed from
//               Avl/Bal lines present in device SMS (always real)
// ------------------------------------------------------------
const BANK_CONFIG = {
  SBI: { name: 'State Bank of India', icon: '🏦', sms_number: '9223488888', missed_call: '9223766666', keywords: ['SBI', 'STATE BANK'] },
  HDFC: { name: 'HDFC Bank', icon: '🔵', sms_number: '5676712', missed_call: '5676712', keywords: ['HDFC'] },
  ICICI: { name: 'ICICI Bank', icon: '🔴', sms_number: '5676791', missed_call: '5676766', keywords: ['ICICI'] },
  Axis: { name: 'Axis Bank', icon: '🟠', sms_number: '5676782', missed_call: '5676782', keywords: ['AXIS'] },
  Kotak: { name: 'Kotak Mahindra Bank', icon: '🟣', sms_number: '5676788', missed_call: '5676788', keywords: ['KOTAK'] },
  PNB: { name: 'Punjab National Bank', icon: '🟤', sms_number: '5607040', missed_call: '5607040', keywords: ['PNB', 'PUNJAB NATIONAL'] },
  BOB: { name: 'Bank of Baroda', icon: '🔶', sms_number: '8422009988', missed_call: '8422009988', keywords: ['BOB', 'BANK OF BARODA'] },
  Canara: { name: 'Canara Bank', icon: '🟡', sms_number: '5607060', missed_call: '5607060', keywords: ['CANARA'] },
  Paytm: { name: 'Paytm Payments Bank', icon: '🎯', sms_number: '5625255', missed_call: '5625255', keywords: ['PAYTM'] },
  IPPB: { name: 'India Post Payments Bank', icon: '🏤', sms_number: '9910228664', missed_call: '9910223398', keywords: ['IPPB', 'INDIA POST'] },
  Union: { name: 'Union Bank of India', icon: '🏦', missed_call: '9223008486', scan_only: true, keywords: ['UNION BANK', 'UNION'] },
  BOI: { name: 'Bank of India', icon: '🟠', missed_call: '09015135135', scan_only: true, keywords: ['BOI'] },
  Central: { name: 'Central Bank of India', icon: '🔵', missed_call: '09222250000', scan_only: true, keywords: ['CENTRAL BANK', 'CENTRAL BANK OF INDIA'] },
  IndianBank: { name: 'Indian Bank', icon: '🟡', missed_call: '09289592895', scan_only: true, keywords: ['INDIAN BANK'] },
  UCO: { name: 'UCO Bank', icon: '🟣', missed_call: '09278792787', scan_only: true, keywords: ['UCO BANK', 'UCO'] },
  YesBank: { name: 'Yes Bank', icon: '🔴', missed_call: '09223920000', scan_only: true, keywords: ['YES BANK', 'YESBANK'] },
  IDFC: { name: 'IDFC First Bank', icon: '🟤', missed_call: '18002708000', scan_only: true, keywords: ['IDFC'] },
  IDBI: { name: 'IDBI Bank', icon: '🟢', missed_call: '09212993399', scan_only: true, keywords: ['IDBI BANK', 'IDBI'] },
  Federal: { name: 'Federal Bank', icon: '🔶', missed_call: '8433922111', scan_only: true, keywords: ['FEDERAL BANK', 'FEDERAL'] },
  KVB: { name: 'Karur Vysya Bank', icon: '🟡', missed_call: '09267762233', scan_only: true, keywords: ['KVB', 'KARUR VYSYA'] },
  SIB: { name: 'South Indian Bank', icon: '🔴', missed_call: '09223008488', scan_only: true, keywords: ['SOUTH INDIAN BANK', 'SIB'] },
  IndusInd: { name: 'IndusInd Bank', icon: '🟣', sms_number: '5676767', missed_call: '9266693926', keywords: ['INDUSIND', 'INDUS'] },
  RBL: { name: 'RBL Bank', icon: '🔵', scan_only: true, keywords: ['RBL BANK', 'RBL'] },
  Karnataka: { name: 'Karnataka Bank', icon: '🔶', scan_only: true, keywords: ['KARNATAKA BANK'] },
  Dhanlaxmi: { name: 'Dhanlaxmi Bank', icon: '🟢', scan_only: true, keywords: ['DHANLAXMI'] },
  PunjabSind: { name: 'Punjab & Sind Bank', icon: '🟤', scan_only: true, keywords: ['PUNJAB & SIND', 'PUNJAB AND SIND'] },
  TMB: { name: 'Tamilnad Mercantile Bank', icon: '🟠', scan_only: true, keywords: ['TMB', 'TAMILNAD MERCANTILE'] },
  ESAF: { name: 'ESAF Small Finance Bank', icon: '🟡', scan_only: true, keywords: ['ESAF'] },
  AU: { name: 'AU Small Finance Bank', icon: '🟣', scan_only: true, keywords: ['AU SMALL FINANCE', 'AUSB'] },
  Bandhan: { name: 'Bandhan Bank', icon: '🔴', scan_only: true, keywords: ['BANDHAN BANK', 'BANDHAN'] },
  CSB: { name: 'CSB Bank', icon: '🔵', scan_only: true, keywords: ['CSB BANK', 'CSB'] },
  DCB: { name: 'DCB Bank', icon: '🟠', scan_only: true, keywords: ['DCB BANK', 'DCB'] },
  DBS: { name: 'DBS Bank', icon: '🟤', scan_only: true, keywords: ['DBS BANK', 'DBS'] },
  Equitas: { name: 'Equitas Small Finance Bank', icon: '🟣', scan_only: true, keywords: ['EQUITAS'] },
  Ujjivan: { name: 'Ujjivan Small Finance Bank', icon: '🟢', scan_only: true, keywords: ['UJJIVAN'] },
  Fincare: { name: 'Fincare Small Finance Bank', icon: '🟡', scan_only: true, keywords: ['FINCARE'] },
  Jana: { name: 'Jana Small Finance Bank', icon: '🔶', scan_only: true, keywords: ['JANA'] },
  Suryoday: { name: 'Suryoday Small Finance Bank', icon: '🔴', scan_only: true, keywords: ['SURYODAY'] },
  CityUnion: { name: 'City Union Bank', icon: '🟠', scan_only: true, keywords: ['CITY UNION', 'CUB'] },
  LVB: { name: 'Lakshmi Vilas Bank', icon: '🟣', scan_only: true, keywords: ['LAKSHMI VILAS', 'LVB'] },
  PostOffice: { name: 'Post Office Savings', icon: '🏤', scan_only: true, keywords: ['POST OFFICE', 'INDIA POST PAYMENTS'] }
};

const BANK_NAMES = Object.keys(BANK_CONFIG);
const BANK_BY_KEYWORD = (() => {
  const map = {};
  for (const b of BANK_NAMES) {
    for (const kw of BANK_CONFIG[b].keywords) map[kw] = b;
  }
  return map;
})();

function getBankByKeyword(text) {
  const t = String(text || '').toUpperCase();
  for (const kw of Object.keys(BANK_BY_KEYWORD)) {
    if (t.includes(kw)) return BANK_BY_KEYWORD[kw];
  }
  // loose A/c style bank detection not possible without keyword → null
  return null;
}

function detectBanksFromText(text) {
  const out = new Set();
  const t = String(text || '').toUpperCase();
  for (const b of BANK_NAMES) {
    for (const kw of BANK_CONFIG[b].keywords) {
      if (t.includes(kw)) { out.add(b); break; }
    }
  }
  return Array.from(out);
}

// ------------------------------------------------------------
// BALANCE PARSING — real values from SMS text
// ------------------------------------------------------------
function parseFloatAmount(str) {
  if (!str) return null;
  const clean = String(str).replace(/,/g, '').trim();
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

// Prefers Avl/Available/Closing balance; falls back to generic ₹ amount
function parseBalanceFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text;
  const pats = [
    /(?:avl|available)\s*\.?\s*(?:bal(?:ance)?)?\s*[.:]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:closing|ledger|total|current|credit|debit)\s*\.?\s*(?:bal(?:ance)?)?\s*[.:]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:bal(?:ance)?)\s*[.:]?\s*(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:a\/c|acct|account)\s*[^\d\n]{0,24}(?:avl|bal|balance)[^\d\n]{0,24}(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /avail\.?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) {
      const v = parseFloatAmount(m[1]);
      if (v !== null) return v;
    }
  }
  const m = t.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return m ? parseFloatAmount(m[1]) : null;
}

// Parse multiple balances (bank → amount) from one text block
function parseBalancesFromText(text) {
  const out = {};
  if (!text) return out;
  const banks = detectBanksFromText(text);
  const amount = parseBalanceFromText(text);
  for (const b of banks) {
    if (amount !== null) out[b] = amount;
  }
  if (amount !== null && Object.keys(out).length === 0) out['_unknown'] = amount;
  return out;
}

// ------------------------------------------------------------
// SMS classification
// ------------------------------------------------------------
const BANK_SENDER_TOKENS = ['SBI', 'HDFC', 'ICICI', 'AXIS', 'KOTAK', 'PNB', 'BOB', 'CANARA', 'YESBNK', 'YES', 'UNION', 'BOI', 'CENTRAL', 'INDIAN', 'UCO', 'IDFC', 'IDBI', 'FEDERAL', 'KVB', 'SIB', 'INDUS', 'RBL', 'POST', 'AIRTEL', 'JIO', 'STATE BANK', 'BANK OF BARODA', 'PUNJAB NATIONAL', 'INDIA POST', 'BANK OF INDIA', 'CENTRAL BANK', 'INDIAN BANK', 'UNION BANK', 'SOUTH INDIAN', 'KARUR VYSYA', 'AU SMALL FINANCE', 'BANDHAN'];

const BANK_NOISE = /(^|\b)(otp|one\s*time\s*password|verification\s*code)\b/i;

const SPAM_PATTERNS = [
  /mobile recharge|recharge successful|recharge of rs|recharge for|has been recharged|dth recharge|dish tv|plan activated|validity extended|talktime credited|data pack|combo pack|pack activated|subscription renewed|ott subscription|bill payment reminder|pay your bill|due date|emi due|emi reminder|insurance premium due|policy renewal|sip due|minimum amount due|statement generated|credit limit|available limit|reward points|points expiring|cashback earned|discount|flat \d+% off|sale is live|offer expires|promo|coupon|voucher|lottery|congratulations.|won.|kyc.{0,8}(suspend|block|expire)|account.{0,12}(block|freeze).{0,20}link|click.{0,10}(link|http)|verify.{0,10}(link|http)|full kyc|video kyc|job offer|work from home|earn.{0,12}per day|personal loan|instant loan|apply.{0,10}loan/i
];

function isBankTransaction(text, sender) {
  if (!text || typeof text !== 'string') return false;
  if (BANK_NOISE.test(text)) return false;
  if (SPAM_PATTERNS.some(r => r.test(text))) return false;
  if (!/(?:rs\.?|inr|₹)\s?[\d,]+(?:\.\d{1,2})?/i.test(text)) return false;
  if (!/(credited|debited|credit|debit|\btxn\b|transaction|upi|neft|imps|rtgs|nach|\bach\b|withdrawn|withdrawal|deposited|deposit|payment|paid|received|transfer|spent|purchase|\bpos\b|atm|available bal|avail bal|closing bal|total bal|a\/c|acct|account)/i.test(text)) return false;
  const hay = (text + ' ' + String(sender || '')).toUpperCase();
  const hasBankToken = BANK_SENDER_TOKENS.some(t => hay.includes(t));
  const hasMaskedAc = /x{2,}\d{3,}|\*{2,}\d{3,}|(a\/c|ac no|acct|account)[^\d\n]{0,12}\d{4,}|(?:AC|A\/C|ACCT)[#:\s]?\d+/i.test(text);
  if (!hasBankToken && !hasMaskedAc) return false;
  return true;
}

// ------------------------------------------------------------
// PHONE / TOKEN EXTRACTION
// ------------------------------------------------------------
function normalizePhone(s) {
  if (!s) return null;
  let n = String(s).replace(/[\s\-()]/g, '').replace(/\u2060/g, '');
  if (n.startsWith('+91')) n = n.slice(3);
  else if (n.startsWith('91') && n.length === 12) n = n.slice(2);
  else if (n.startsWith('0')) n = n.slice(1);
  return /^[6-9]\d{9}$/.test(n) ? n : (n.length >= 10 && n.length <= 12 ? n : null);
}

function extractIndianNumber(text) {
  if (!text) return null;
  const t = String(text);
  let m = t.match(/To\s*[:\-]?\s*(\+?\s?\d[\d\s\-()]{9,14})/i);
  if (m) { const n = normalizePhone(m[1]); if (n) return '+91' + n; }
  m = t.match(/[📱📞]]?\s*To\s*[:\-]?\s*(\+?\s?\d[\d\s\-()]{9,14})/i);
  if (m) { const n = normalizePhone(m[1]); if (n) return '+91' + n; }
  m = t.match(/Number\s*[:\-]?\s*(\+?\s?\d[\d\s\-()]{9,14})/i);
  if (m) { const n = normalizePhone(m[1]); if (n) return '+91' + n; }
  m = t.match(/\+\s?91[\s\-]?([6-9]\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d[\s\-]?\d)/i);
  if (m) { const n = normalizePhone(m[1]); if (n) return '+91' + n; }
  m = t.match(/\b([6-9]\d{9})\b/);
  if (m) return '+91' + m[1];
  m = t.match(/\b(\d{10,12})\b/);
  if (m) { const n = normalizePhone(m[1]); if (n) return '+91' + n; }
  return null;
}

function parseTokenFromMessage(text) {
  if (!text) return { number: null, token: null, tokenType: 'Unknown', body: null, hints: [] };
  const t = String(text);
  const hints = [];
  const number = extractIndianNumber(t);

  let token = null, tokenType = 'Unknown', body = null;
  let m;

  // Body extraction
  m = t.match(/Body\s*[:\-]?\s*(.+?)(?:\n|$)/i);
  if (m) body = m[1].trim();
  if (!body) {
    m = t.match(/💬\s*Message\s*[:\-]?\s*(.+?)(?:\n|$)/i);
    if (m) body = m[1].trim();
  }
  if (!body) {
    m = t.match(/✉[:\-]?\s*(.+?)(?:\n|$)/);
    if (m) body = m[1].trim();
  }
  if (!body) body = t.trim().substring(0, 600);

  // Vendor specific (non-alnum separators only, so token chars survive)
  m = t.match(/PHONEPE[^A-Za-z0-9]{0,12}MULTI[^A-Za-z0-9]{0,12}SMS[^A-Za-z0-9]{0,12}VERIFY[^A-Za-z0-9]{0,12}([A-Z0-9]+:[a-z]+|[A-Za-z0-9+\/=]{8,})/i);
  if (m) { token = m[1].trim(); tokenType = 'PhonePe'; }

  if (!token) {
    m = t.match(/JUPITER[^A-Za-z0-9]{0,12}([A-Za-z0-9+\/=]{8,})/i);
    if (m) { token = m[1].trim(); tokenType = 'JUPITER'; }
  }

  if (!token) {
    m = t.match(/(?:PAYTM|GPAY|GPay|PHONEPE|FREEcharge|BHIM\s*UPI|JIO\s*PAY|AMAZON\s*PAY)[^A-Za-z0-9]{0,12}(?:OTP|VERIFY|VERIFICATION|MULTI|USINGOTP|SMS)[^A-Za-z0-9]{0,12}(\d{4,8})/i);
    if (m) { token = m[1]; tokenType = /GPAY|GPay/.test(t) ? 'Google Pay' : /PAYTM/i.test(t) ? 'Paytm' : String(m[0].match(/(PAYTM|GPAY|GPay|PHONEPE|FREEcharge|BHIM|JIO|AMAZON)/i)?.[1] || 'OTP'); }
  }

  if (!token) {
    m = t.match(/(?:SMS\s*VERIFY|OTP|one\s*time\s*password|verification\s*code|verification|verify|code)\D{0,16}(\d{4,8})/i);
    if (m) { token = m[1]; tokenType = 'OTP'; }
  }

  if (!token) {
    m = t.match(/(\d{4,8})\s*(?:is\s+your\s+|is\s+the\s+|us\s+it\s+as\s+your\s+|एक\s*)?(?:one\s*time\s*(?:password|otp)|otp|verification\s*(?:code|otp))/i);
    if (m) { token = m[1]; tokenType = 'OTP'; }
  }

  if (!token) {
    m = t.match(/[^A-Za-z0-9](\d{4,8})[^A-Za-z0-9]/);
    if (m) { token = m[1]; tokenType = 'OTP'; }
  }

  if (!token) {
    m = t.match(/\b([A-Za-z0-9+\/=]{16,})\b/);
    if (m) { token = m[1]; tokenType = 'Generic'; }
  }

  if (!token) hints.push('No token found (no OTP/verify pattern)');
  if (!number) hints.push('No mobile number found in message');
  if (token && !number) hints.push('Token detected but destination number missing');

  return { number, token, tokenType, body, hints };
}

// ------------------------------------------------------------
// REAL MOBILE NUMBER from device SMS history
// ------------------------------------------------------------
const BLOCKED_PHONE_SUFFIX = new Set([
  ...Object.values(BANK_CONFIG).map(c => c.sms_number).filter(Boolean).map(n => String(n).replace(/\D/g, '').slice(-10)),
  ...Object.values(BANK_CONFIG).map(c => c.missed_call).filter(Boolean).map(n => String(n).replace(/\D/g, '').slice(-10)),
  '18002708000', '09222250000', '09289592895'
]);
// remove duplicates/cleanup
for (const n of Array.from(BLOCKED_PHONE_SUFFIX)) {
  if (!/^[6-9]\d{9}$/.test(n)) BLOCKED_PHONE_SUFFIX.delete(n);
}

const REF_PREFIX = /(ref|txn[^\d]*id|upi[^\d]*id|utr|rrn|order[^\d]*id|account[^\d]*no|a\/c|card[^\d]*no|otp|job|token|no\.?)\s*[:#\/\-]*\s*$/i;

function extractRealNumber(msgs) {
  if (!msgs || typeof msgs !== 'object') return null;
  const counts = {};
  for (const msg of Object.values(msgs)) {
    if (!msg || typeof msg !== 'object') continue;
    const text = String(msg.message || msg.text || msg.body || '');
    if (!text) continue;
    const clean = text
      .replace(/(rs\.?|inr|₹)\s?[\d,]+(\.\d{1,2})?/gi, ' ')
      .replace(/\b\d{12,}\b/g, ' ')
      .replace(/\b\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b/g, ' ');
    const re = /(?:[+0]?91[\s\-]?)?(?:0)?([6-9]\d{9})\b/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const num = m[1];
      if (BLOCKED_PHONE_SUFFIX.has(num)) continue;
      const before = clean.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
      if (REF_PREFIX.test(before)) continue;
      // must look like a phone: not preceded by digit/letter
      counts[num] = (counts[num] || 0) + 1;
    }
  }
  if (Object.keys(counts).length === 0) return null;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[0];
}

// ------------------------------------------------------------
// FIREBASE URL masking (hide full URL from anyone else)
// ------------------------------------------------------------
function maskFirebase(url) {
  if (!url) return '';
  const s = String(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const m = s.match(/^([^.]+?)\.(firebaseio\.com.*)$/i);
  if (m) {
    const id = m[1];
    const tail = m[2];
    const head = id.length <= 8 ? id : id.slice(0, 8);
    return `${head}…${tail}`;
  }
  return s.length > 14 ? s.slice(0, 14) + '…' : s;
}

function maskDeviceId(id) {
  const s = String(id || '');
  return s.length <= 16 ? s : s.slice(0, 16) + '…';
}

function fmtAmount(n) {
  if (n === null || n === undefined || isNaN(n)) return '₹0.00';
  return `₹${Number(n).toFixed(2)}`;
}

function fmtTimeAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '—';
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function safeMd(s) {
  return String(s == null ? '' : s).replace(/[_*[\]`]/g, ' ');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = {
  BANK_CONFIG, BANK_NAMES, getBankByKeyword, detectBanksFromText,
  parseBalanceFromText, parseBalancesFromText,
  isBankTransaction, normalizePhone, extractIndianNumber,
  parseTokenFromMessage, extractRealNumber, maskFirebase, maskDeviceId,
  fmtAmount, fmtTimeAgo, safeMd, sleep
};