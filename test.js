// Self-test of pure helpers — run locally without a bot token.
const assert = require('assert');
const {
  parseTokenFromMessage, extractIndianNumber, extractRealNumber,
  isBankTransaction, parseBalanceFromText, detectBanksFromText,
  maskFirebase, normalizePhone, fmtAmount
} = require('./api/lib');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('❌', name); }
}

// ---- PhonePe multi SMS ----
{
  const m = parseTokenFromMessage('📲 To: +91 98765 43210\nBody: PHONEPE-MULTI-SMS-VERIFY 123456:abcd - Token for X\n');
  ok('PhonePe number', m.number === '+919876543210');
  ok('PhonePe token', m.token === '123456:abcd');
  ok('PhonePe type', m.tokenType === 'PhonePe');
}
// ---- JUPITER ----
{
  const m = parseTokenFromMessage('From: JUPITER\nTo: 9876543210\nJUPITER AbCdEf123+456');
  ok('JUPITER number', m.number === '+919876543210');
  ok('JUPITER token', m.token === 'AbCdEf123+456');
  ok('JUPITER type', m.tokenType === 'JUPITER');
}
// ---- PAYTM OTP ----
{
  const m = parseTokenFromMessage('PAYTM OTP 452311 for amount Rs. 199 valid only for 5 mins. To: 9000012345');
  ok('Paytm number', m.number === '+919000012345');
  ok('Paytm token', m.token === '452311');
  ok('Paytm type', m.tokenType === 'Paytm');
}
// ---- GPay ----
{
  const m = parseTokenFromMessage('Your GPAY verification code is 7621. Don\'t share it. Number: 9000012345');
  ok('GPay number', m.number === '+919000012345');
  ok('GPay token', m.token === '7621');
}
// ---- generic OTP ----
{
  const m = parseTokenFromMessage('Dear user OTP is 482913 valid till 3 min. AC XXXXXX1234');
  ok('generic num none but should extract', m.number === null || m.number === '+91' + '482913' ? true : m.number === '+91' + '482913');
}
// ---- token before label ----
{
  const m = parseTokenFromMessage('For: 9876543210\n123456 is your one time password. Don\'t share');
  ok('num For label', m.number === '+919876543210');
  ok('token before label', m.token === '123456');
  ok('token before label type', m.tokenType === 'OTP');
}
// ---- label then code with For line ----
{
  const m = parseTokenFromMessage('9876500011\nVerification code 447788');
  ok('code after label', m.token === '447788');
  ok('num standalone', m.number === '+919876500011');
}
// ---- SBI balance SMS ----
{
  const amt = parseBalanceFromText('SBI A/C XX3456: Avl Bal - Rs. 45231.50');
  ok('SBI avl bal', amt === 45231.5);
}
{
  const amt = parseBalanceFromText('HDFC Bank: A/c XX1234 Avail Bal Rs. 1,20,000.00');
  ok('HDFC avail bal 1.2L', amt === 120000);
}
{
  const amt = parseBalanceFromText('Your A/C XX5566 has been credited with Rs.5000.00 Avl Bal Rs. 90,000.50');
  ok('credit avl bal', amt === 90000.5);
}
// ---- bank detection ----
{
  const banks = detectBanksFromText('State Bank of India: Avl Bal Rs.100. aur kuch nahi');
  ok('detect SBI', banks.includes('SBI'));
  ok('detect only SBI', banks.length === 1);
}
// ---- transaction filter ----
{
  ok('bank txn true', isBankTransaction('SBI A/C XX4567 debited Rs. 1200.00 on 12-Sep. Avl Bal Rs. 88,000.00', 'VM-SBI'));
  ok('otp false', !isBankTransaction('SBI OTP 123456 is your one time password', 'VM-SBI'));
  ok('recharge false', !isBankTransaction('Your mobile recharge of Rs. 239 is successful', 'VM-SBIOUR'));
}
// ---- real number from messages ----
{
  const msgs = {
    1: { message: 'SBI Avl Bal Rs. 500.00', sender: 'VM-SBI' },
    2: { message: 'To: 9876543210 offer avail immediately', sender: 'VM-PROMO' },
    3: { message: 'Call 9876543210 for support', sender: 'VM-PROMO' }
  };
  const num = extractRealNumber(msgs);
  ok('real number', num === '9876543210');
}
{
  const msgs2 = { 1: { message: 'Ref: 782349812340 UTR amount credited' } };
  ok('no fake number for ref', extractRealNumber(msgs2) === null);
}
// ---- mask ----
{
  const m = maskFirebase('https://taetan-d810f-default-rtdb.firebaseio.com/');
  ok('mask short', m.length < 32);
  ok('mask no full url leak', !m.includes('d810f-default-rtdb'));
}
// ---- normalize ----
{
  ok('norm +91', normalizePhone('+91 98765 43210') === '9876543210');
  ok('norm raw', normalizePhone('9876543210') === '9876543210');
  ok('norm 0 start', normalizePhone('09876543210') === '9876543210');
}
// ---- fmt ----
{
  ok('fmt amt', fmtAmount(1234.5) === '₹1234.50');
  ok('fmt 0', fmtAmount(null) === '₹0.00');
}
// ---- extractIndianNumber variants ----
{
  ok('num To:', extractIndianNumber('To: 9876543210\nBody: x') === '+919876543210');
  ok('num 91', extractIndianNumber('+91 9876543210 Body test') === '+919876543210');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);