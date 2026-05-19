require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

process.stdin.resume();
process.on('SIGTERM', () => { console.log('⚠️ SIGTERM - IGNORING'); });
process.on('SIGINT',  () => { console.log('⚠️ SIGINT - IGNORING');  });

setInterval(() => {
  console.log('💓 BOT ALIVE - ' + new Date().toISOString());
  const fs = require('fs');
  try { fs.writeFileSync('/tmp/bot-alive.txt', Date.now().toString()); } catch(e) {}
}, 5 * 60 * 1000);

// ==========================
// 🔹 Logging
// ==========================
let logCounter = 0;
function smartLog(...args) { if (++logCounter <= 50) console.log(...args); }
setInterval(() => { logCounter = 0; }, 5 * 60 * 1000);

// ==========================
// 🔹 إعدادات الأدمن
// ==========================
const ADMIN_CHAT_ID = "6970148965";
const ADMIN_CHAT_IDS = ["6970148965", "8250574282"];
const isAdminId = (id) => ADMIN_CHAT_IDS.includes(String(id));

// ==========================
// 🔹 إعدادات المعالجة
// ==========================
const MAX_RETRIES         = 3;
const RETRY_DELAY         = 10000;

let PROCESSING_MODE       = 'batch';
let BATCH_SIZE            = 10;
const BATCH_FLUSH_SECONDS = 120;
const BATCH_BETWEEN_DELAY = 3000;
let SINGLE_DELAY_MS       = 3000;

let MAX_WITHDRAWAL_AMOUNT = 10;
let MIN_WITHDRAWAL_AMOUNT = 0.5;
let MAX_BALANCE_BUFFER    = 0.1;
let BAMBOO_TO_TON_RATE    = 50000;
let DAILY_LIMIT           = 2;
let DAILY_COOLDOWN_HOURS  = 24;
let systemPaused          = false;

// ==========================
// 🔹 تحكم في نظام السحب
// ==========================
let WITHDRAWAL_ENABLED = true;

// ==========================
// 🔹 دالة تقريب المبلغ
// ==========================
function roundAmount(amount) {
  try {
    const n = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (isNaN(n) || n <= 0) return 0;
    const r = Math.floor(n * 1000) / 1000;
    return r < 0.001 ? 0.001 : r;
  } catch { return 0.001; }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseLogLimitArg(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (['all', 'كل', 'الجميع', 'جميع'].includes(raw)) return 'all';
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return null;
  return Math.min(n, 1000);
}

function getLogLimitLabel(limit) {
  return limit === 'all' ? 'جميع النشاطات' : `آخر ${limit} نشاط`;
}

function getActivityTimestamp(entry) {
  if (entry?.ts) return Number(entry.ts) || 0;
  if (entry?.timestamp) return Number(entry.timestamp) || 0;
  if (entry?.date) {
    const parsed = Date.parse(entry.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function formatCompactNumber(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function firstNumeric(entry, keys) {
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') {
      const n = Number(entry[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function formatActivityValue(entry) {
  const lines = [];
  const requested = firstNumeric(entry, ['amount_requested', 'amtRequested', 'requestedAmount', 'withdrawRequested']);
  const net = firstNumeric(entry, ['amount_net', 'amt', 'netAmount', 'withdrawNet']);
  const fee = firstNumeric(entry, ['fee', 'withdrawFee']);

  if (requested !== null || net !== null || fee !== null) {
    const parts = [];
    if (requested !== null) parts.push(`المطلوب ${formatCompactNumber(requested)} TON`);
    if (net !== null) parts.push(`الصافي ${formatCompactNumber(net)} TON`);
    if (fee !== null) parts.push(`رسوم ${formatCompactNumber(fee)} TON`);
    lines.push(`💎 <b>قيمة السحب:</b> ${parts.join(' | ')}`);
  }

  const deposit = firstNumeric(entry, ['deposit', 'tonAdded', 'depositAmount']);
  if (deposit !== null) lines.push(`📥 <b>الإيداع:</b> ${formatCompactNumber(deposit)} TON`);

  const tonReward = firstNumeric(entry, ['rewardTon', 'tonReward', 'reward_ton', 'ton_reward', 'tonPrize', 'earnedTon']);
  if (tonReward !== null) lines.push(`🎁 <b>مكافأة TON:</b> ${formatCompactNumber(tonReward)} TON`);

  const bambooReward = firstNumeric(entry, ['rewardBamboo', 'bambooReward', 'reward_bamboo', 'bamboo_reward', 'bambooEarned']);
  if (bambooReward !== null) lines.push(`🎍 <b>مكافأة Bamboo:</b> ${formatCompactNumber(bambooReward, 0)}`);

  const coinsReward = firstNumeric(entry, ['rewardCoins', 'coinsReward', 'reward_coins', 'coins_reward', 'coinsEarned']);
  if (coinsReward !== null) lines.push(`🪙 <b>مكافأة Coins:</b> ${formatCompactNumber(coinsReward, 0)}`);

  const genericReward = firstNumeric(entry, ['reward', 'rewardAmount', 'amountReward', 'prize', 'earned']);
  if (genericReward !== null && tonReward === null && bambooReward === null && coinsReward === null) {
    const unit = entry.rewardUnit || entry.unit || entry.currency || '';
    lines.push(`🎁 <b>المكافأة:</b> ${formatCompactNumber(genericReward)}${unit ? ' ' + escapeHtml(unit) : ''}`);
  }

  const amount = firstNumeric(entry, ['amount']);
  if (amount !== null && deposit === null && genericReward === null && requested === null && net === null) {
    lines.push(`💎 <b>القيمة:</b> ${formatCompactNumber(amount)} TON`);
  }

  const price = firstNumeric(entry, ['price', 'cost']);
  if (price !== null) lines.push(`💳 <b>السعر:</b> ${formatCompactNumber(price)} TON`);

  if (!lines.length) return '🎁 <b>المكافأة:</b> —';
  return lines.join('\n  ');
}

function formatActivityBalances(entry) {
  const lines = [];
  const tonBefore = firstNumeric(entry, ['tonBalance_before', 'ton_before']);
  const tonAfter = firstNumeric(entry, ['tonBalance_after', 'ton_after']);
  if (tonBefore !== null || tonAfter !== null) {
    lines.push(`💰 <b>رصيد TON:</b> ${tonBefore !== null ? formatCompactNumber(tonBefore) : '—'} → ${tonAfter !== null ? formatCompactNumber(tonAfter) : '—'}`);
  }
  const bambooBefore = firstNumeric(entry, ['bamboo_before', 'bambooBalance_before']);
  const bambooAfter = firstNumeric(entry, ['bamboo_after', 'bambooBalance_after']);
  if (bambooBefore !== null || bambooAfter !== null) {
    lines.push(`🎍 <b>Bamboo:</b> ${bambooBefore !== null ? formatCompactNumber(bambooBefore, 0) : '—'} → ${bambooAfter !== null ? formatCompactNumber(bambooAfter, 0) : '—'}`);
  }
  const coinsBefore = firstNumeric(entry, ['coins_before', 'coinsBalance_before']);
  const coinsAfter = firstNumeric(entry, ['coins_after', 'coinsBalance_after']);
  if (coinsBefore !== null || coinsAfter !== null) {
    lines.push(`🪙 <b>Coins:</b> ${coinsBefore !== null ? formatCompactNumber(coinsBefore, 0) : '—'} → ${coinsAfter !== null ? formatCompactNumber(coinsAfter, 0) : '—'}`);
  }
  return lines.join('\n  ');
}

async function showLogLimitChooser(bot, chatId, userId) {
  await adminReply(bot, chatId,
    `📋 <b>سجل المستخدم</b> <code>${escapeHtml(userId)}</code>\n\n` +
    `اختر عدد النشاطات التي تريد عرضها أو استخدم:\n` +
    `<code>/logs ${escapeHtml(userId)} 100</code>\n` +
    `<code>/logs ${escapeHtml(userId)} all</code>`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'آخر 30', callback_data: `log_limit:${userId}:30` },
            { text: 'آخر 100', callback_data: `log_limit:${userId}:100` },
          ],
          [
            { text: 'آخر 200', callback_data: `log_limit:${userId}:200` },
            { text: 'جميع النشاطات', callback_data: `log_limit:${userId}:all` },
          ],
        ],
      },
    }
  );
}

async function sendUserLogs(bot, chatId, userId, limitOption = 30) {
  const limit = limitOption === 'all' ? 'all' : (parseLogLimitArg(limitOption) || 30);
  await adminReply(bot, chatId, `🔍 جاري جلب ${getLogLimitLabel(limit)} للمستخدم <code>${escapeHtml(userId)}</code>...`);

  const logRef = db.ref(`users/${userId}/log`);
  const [logSnap, wdSnap, depSnap] = await Promise.all([
    limit === 'all' ? logRef.once('value') : logRef.limitToLast(limit).once('value'),
    db.ref(`users/${userId}/wdHistory`).once('value'),
    db.ref(`users/${userId}/deposits`).once('value'),
  ]);

  const logs     = logSnap.val()  || {};
  const wdHist   = wdSnap.val()   || {};
  const deposits = depSnap.val()  || {};

  const totalDep  = Object.values(deposits).reduce((s, d) => s + Number(d.amount || d.tonAdded || 0), 0);
  const totalPaid = Object.values(wdHist).filter(w => w.status === 'paid').reduce((s, w) => s + Number(w.sentAmount || 0), 0);
  const paidCount = Object.values(wdHist).filter(w => w.status === 'paid').length;

  let text =
    `📊 <b>السجل المالي — المستخدم <code>${escapeHtml(userId)}</code></b>\n` +
    `${'━'.repeat(30)}\n\n` +
    `📥 إجمالي الإيداعات: <b>${totalDep.toFixed(4)} TON</b>\n` +
    `📤 إجمالي المسحوب: <b>${totalPaid.toFixed(4)} TON</b>\n` +
    `✅ سحوبات ناجحة: <b>${paidCount}</b>\n\n` +
    `${'─'.repeat(30)}\n` +
    `📋 <b>${getLogLimitLabel(limit)}:</b>\n\n`;

  const logEntries = Object.entries(logs)
    .sort((a, b) => getActivityTimestamp(b[1]) - getActivityTimestamp(a[1]));

  if (!logEntries.length) {
    text += `<i>لا يوجد سجل نشاط</i>`;
  } else {
    logEntries.forEach(([, entry]) => {
      const ts = getActivityTimestamp(entry);
      const date = ts ? new Date(ts).toISOString().substring(0, 16).replace('T', ' ') : (entry.date ? String(entry.date).substring(0, 16).replace('T', ' ') : '—');
      const type = escapeHtml(entry.type || entry.activityName || entry.name || 'نشاط');
      const cat  = entry.taskCategory || entry.category ? escapeHtml(entry.taskCategory || entry.category) : '';
      const tid  = entry.taskId || entry.activityId || '';
      const valueLine = formatActivityValue(entry);
      const balanceLine = formatActivityBalances(entry);
      text += `• <b>${type}</b>${cat ? ' | ' + cat : ''}${tid ? ' | <code>' + escapeHtml(tid) + '</code>' : ''}\n`;
      text += `  🕐 ${date}\n`;
      text += `  ${valueLine}\n`;
      if (balanceLine) text += `  ${balanceLine}\n`;
      text += `\n`;
    });
  }

  const chunks = [];
  let remaining = text;
  while (remaining.length > 3500) {
    let cut = remaining.lastIndexOf('\n', 3500);
    if (cut < 1000) cut = 3500;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut);
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    await adminReply(bot, chatId, chunk);
    await new Promise(r => setTimeout(r, 300));
  }
}

// ==========================
// 🔹 Firebase
// ==========================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  console.log("✅ Firebase connected");
} catch (e) { console.error("❌ Firebase error:", e.message); process.exit(1); }
const db = admin.database();

// ==========================
// 🔹 TON Client
// ==========================
if (!process.env.TON_API_KEY) { console.error("❌ TON_API_KEY missing"); process.exit(1); }
const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
});

// ==========================
// 🔹 متغيرات المحفظة
// ==========================
let walletContract = null;
let walletKey      = null;
let walletAddress  = null;
let isProcessing   = false;
const processingQueue = new Set();
let botInstance    = null;

// ==========================
// 🔹 إنشاء المحفظة
// ==========================
async function getWallet() {
  if (walletContract && walletKey && walletAddress)
    return { contract: walletContract, key: walletKey, address: walletAddress };
  const mnemonic = process.env.TON_MNEMONIC.split(" ");
  const key      = await mnemonicToWalletKey(mnemonic);
  const wallet   = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });
  const contract = client.open(wallet);
  const address  = contract.address.toString();
  walletContract = contract; walletKey = key; walletAddress = address;
  console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
  return { contract, key, address };
}

async function getWalletBalance() {
  try {
    const { contract } = await getWallet();
    return Number(await contract.getBalance()) / 1e9;
  } catch (e) { console.log(`❌ getWalletBalance: ${e.message}`); return 0; }
}

// ==========================
// 🔹 فحص الحظر
// ==========================
async function isWalletBanned(address) {
  try {
    const snap = await db.ref(`bannedWallets/${address.replace(/[.$#[\]/]/g, '_')}`).once("value");
    return snap.exists();
  } catch { return false; }
}

async function isUserBanned(userId) {
  try {
    const snap = await db.ref(`bannedUsers/${userId}`).once("value");
    return snap.exists();
  } catch { return false; }
}

// ==========================
// 🔹 فحص عدد السحوبات اليومية
// ==========================
async function getUserDailyWithdrawalCount(userId) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const snap = await db.ref("withdrawQueue")
      .orderByChild("userId").equalTo(userId).once("value");
    if (!snap.exists()) return 0;
    let count = 0;
    snap.forEach(child => {
      const d = child.val();
      const ts = d.ts || d.timestamp || 0;
      const status = d.status || '';
      if (ts >= startOfDay.getTime() && ['paid', 'processing', 'pending', 'awaiting_approval', 'awaiting_manual'].includes(status)) {
        count++;
      }
    });
    return count;
  } catch (e) { console.log(`❌ getUserDailyWithdrawalCount: ${e.message}`); return 0; }
}

// ==========================
// 🔹 إشعار الأدمن بطلب موافقة
// ==========================
async function sendAdminApprovalRequest(botInstance, withdrawId, data, dailyCount) {
  const roundedAmount = roundAmount(data.ton);
  const userId        = data.userId || 'unknown';
  const address       = data.address || '—';
  const amountCoins   = data.amt || 0;
  const requestTime   = new Date(data.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

  const text =
    `⚠️ <b>سحب يحتاج موافقة</b>\n\n` +
    `👤 User: <code>${userId}</code>\n` +
    `📅 عدد السحوبات اليوم: <b>${dailyCount}</b> (تجاوز الحد المسموح)\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${withdrawId}</code>\n` +
    `💰 المبلغ: <b>${roundedAmount} TON</b>\n` +
    `🪙 Bamboo: <b>${Number(amountCoins).toLocaleString()}</b>\n` +
    `📬 المحفظة:\n<code>${address}</code>\n` +
    `🕐 الوقت: ${requestTime} UTC\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `هل توافق على هذا السحب؟`;

  try {
    await botInstance.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ موافقة — ادفع الآن", callback_data: `approve_wd:${withdrawId}` },
          { text: "❌ رفض — إلغاء",        callback_data: `reject_wd:${withdrawId}`  },
        ]]
      }
    });
    console.log(`📨 Approval request sent for ${withdrawId}`);
  } catch (e) { console.log(`❌ sendAdminApprovalRequest: ${e.message}`); }
}

async function checkSufficientBalance(requiredAmount) {
  const balance = await getWalletBalance();
  return {
    sufficient: balance >= (requiredAmount + MAX_BALANCE_BUFFER),
    balance, required: requiredAmount
  };
}

// ==========================
// 🔹 دالة مساعدة للرد على الأدمن
// ==========================
async function adminReply(bot, chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) { console.log(`❌ adminReply: ${e.message}`); }
}

// ==========================
// 🔹 التحقق من تأكيد المعاملة (لـ Batch)
// ==========================
async function confirmBatchTransaction(expectedSeqno, maxWaitMs = 120000) {
  const start = Date.now();
  console.log(`🔍 Waiting for batch seqno ${expectedSeqno + 1} to confirm...`);

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { contract } = await getWallet();
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > expectedSeqno) {
        console.log(`✅ Batch seqno advanced: ${expectedSeqno} → ${currentSeqno}`);
        return { confirmed: true, reason: 'seqno_advanced' };
      }
    } catch (e) { console.log(`⚠️ seqno check error: ${e.message}`); }
  }

  return { confirmed: false, reason: 'seqno_timeout' };
}

// ==========================
// 🔹 إشعار المستخدم بالسحب
// ==========================
async function sendUserNotification(chatId, amountTon, amountCoins, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;
  const txLink  = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;
  const caption =
    `🔥 <b>RASEENRACING • WITHDRAW SUCCESSFUL</b> 🔥\n` +
    `Your TON has left the garage and is on the way to your wallet 🏍️💸\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💎 <b>Withdraw Amount:</b> ${amountTon.toFixed(6)} TON\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ Transaction completed successfully\n` +
    `⚡ Funds have been sent to your TON wallet\n\n` +
    `Keep racing. Keep earning. Keep winning 🏁🔥\n\n` +
    (txLink ? `🔗 <a href="${txLink}">View Transaction</a>` : ``);
  const keys = [];
  if (txLink) keys.push({ text: "🔗 View TX", url: txLink });
  keys.push({ text: "🚀 Open", url: "https://t.me/RaseenRacing_bot/app?startapp=" });
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: "https://res.cloudinary.com/dktppfipy/image/upload/v1779060536/withdraw_amyrsy.jpg",
        caption, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [keys] }
      }),
    });
    const data = await res.json();
    if (data.ok) { console.log(`✅ User notified: ${chatId}`); return true; }
    console.log(`❌ Telegram: ${data.description}`); return false;
  } catch (e) { console.log(`❌ sendUserNotification: ${e.message}`); return false; }
}

// ==========================
// 🔹 إشعار مجموعة المدفوعات
// ==========================

// إعدادات المجموعة الجديدة
const GROUP_CHAT_ID        = "@RaseenRacing_chat";   // المجموعة العامة
const GROUP_TOPIC_UNDER    = 2;                       // قسم السحوبات أقل من 0.1 تون
const GROUP_TOPIC_OVER     = 3;                       // قسم السحوبات أكثر من 0.1 تون
const PHOTO_UNDER_0_1      = "https://res.cloudinary.com/dktppfipy/image/upload/v1779064664/nder0.1_lk6y4h.jpg";
const PHOTO_OVER_0_1       = "https://res.cloudinary.com/dktppfipy/image/upload/v1779064664/over_0.1_brou8i.jpg";
const THRESHOLD_TON        = 0.1;                     // حد التصنيف

function maskUserId(userId) {
  const uid = String(userId || 'Unknown');
  if (uid.length <= 4) return uid;
  const start = Math.ceil(uid.length / 3);
  const end   = Math.floor(uid.length / 4);
  return uid.substring(0, start) + '***' + uid.substring(uid.length - end);
}

async function sendChannelNotification(items, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const txLink   = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;
  const totalTON = items.reduce((s, i) => s + i.roundedAmount, 0);
  const isSingle = items.length === 1;

  // سطر أو أسطر الـ Rider IDs
  const riderLines = items.map(item => {
    const masked = maskUserId(item.userId);
    return `👤 Rider ID: <code>${masked}</code>`;
  }).join('\n');

  // مبلغ السحب
  const amountLine = isSingle
    ? `💰 Withdrawal Amount: <b>${items[0].roundedAmount.toFixed(4)} TON</b>`
    : `💰 Withdrawal Amount: <b>${totalTON.toFixed(4)} TON</b>`;

  // Payment Statistics فقط للبادج (أكثر من مستخدم)
  const statsBlock = isSingle ? `` :
    `\n📊 <b>Payment Statistics</b>\n` +
    `• Successful Payments: <b>${items.length}</b>\n` +
    `• Total Distributed: <b>${totalTON.toFixed(4)} TON</b>\n`;

  const caption =
    `🏍️💎 RaseenRacing has successfully processed a new TON withdrawal.\n` +
    `A rider has received their payout directly to their TON\n\n` +
    `${riderLines}\n` +
    `${amountLine}` +
    (statsBlock ? `\n${statsBlock}` : ``);

  const keys = [];
  if (txLink) keys.push({ text: "🔗 View TX", url: txLink });
  keys.push({ text: "🚀 Open", url: "https://t.me/RaseenRacing_bot/app?startapp=" });

  // تحديد القسم والصورة بناءً على إجمالي المبلغ
  const isUnder  = totalTON < THRESHOLD_TON;
  const topicId  = isUnder ? GROUP_TOPIC_UNDER : GROUP_TOPIC_OVER;
  const photoUrl = isUnder ? PHOTO_UNDER_0_1   : PHOTO_OVER_0_1;
  const label    = isUnder ? "< 0.1 TON" : ">= 0.1 TON";

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:           GROUP_CHAT_ID,
        message_thread_id: topicId,
        photo:             photoUrl,
        caption,
        parse_mode:        'HTML',
        reply_markup:      { inline_keyboard: [keys] }
      }),
    });
    const d = await res.json();
    if (d.ok) console.log(`✅ Group notified (${label}) — ${items.length} users | topic: ${topicId}`);
    else console.log(`❌ Group notification failed: ${d.description}`);
  } catch (e) { console.log(`❌ sendChannelNotification: ${e.message}`); }
}

// ==========================
// 🔹 تحديث wdHistory
// ==========================
async function updateUserWdHistory(userId, wdId, txHash, amountTon) {
  if (!userId || !wdId) return;
  try {
    await db.ref(`users/${userId}/wdHistory/${wdId}`).update({
      status:      "paid",
      txHash:      txHash || null,
      sentAmount:  amountTon,
      paidAt:      Date.now(),
    });
    console.log(`✅ wdHistory updated: users/${userId}/wdHistory/${wdId}`);
  } catch (e) { console.log(`❌ updateUserWdHistory: ${e.message}`); }
}

// ==========================
// 🔹 التحقق من صلاحية السحب
// ==========================
async function validateWithdrawal(withdrawId, data) {
  if (!data?.address || (!data?.ton && !data?.amt)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid data", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  const roundedAmount = roundAmount(data.ton ?? data.amt);
  const userId        = data.userId || null;
  const wdId          = data.wdId   || withdrawId;
  const addr          = String(data.address || '').trim();

  const validPrefix  = addr.startsWith("EQ") || addr.startsWith("UQ");
  const validLength  = addr.length === 48;
  const validChars   = /^[A-Za-z0-9+/\-_=]+$/.test(addr);
  const duplicated   = addr.indexOf("EQ", 2) !== -1 || addr.indexOf("UQ", 2) !== -1;
  const hasSpaces    = addr.includes(' ');

  let addrError = null;
  if (!validPrefix)  addrError = `Invalid prefix (expected EQ/UQ, got ${addr.substring(0,2)})`;
  else if (duplicated) addrError = `Duplicated address — two addresses merged`;
  else if (!validLength) addrError = `Invalid length: ${addr.length} (expected 48)`;
  else if (!validChars)  addrError = `Invalid characters in address`;
  else if (hasSpaces)    addrError = `Address contains spaces`;

  if (addrError) {
    console.log(`❌ Bad address [${withdrawId}]: ${addrError} | ${addr.substring(0, 30)}...`);
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: addrError, updatedAt: Date.now() });
    if (userId && wdId) {
      await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
    }
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `⚠️ <b>عنوان محفظة فاسد — تم إلغاء الطلب</b>\n\n🆔 ID: <code>${withdrawId}</code>\n👤 User: <code>${userId || '?'}</code>\n❌ السبب: ${addrError}\n📬 العنوان:\n<code>${addr.substring(0, 80)}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return { valid: false, skip: true };
  }
  data.address = addr;

  if (userId && await isUserBanned(userId)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "User is banned", updatedAt: Date.now() });
    if (wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  if (await isWalletBanned(data.address)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "Wallet is banned", updatedAt: Date.now() });
    if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  if (data.status === 'awaiting_approval') {
    return { valid: false, skip: false };
  }

  // فحص الإيداعات الموحد — يغطي كل الحالات
  if (userId && !data.approvedByAdmin) {
    try {
      const [depositsSnap, paidWdSnap] = await Promise.all([
        db.ref(`users/${userId}/deposits`).once("value"),
        db.ref("withdrawQueue").orderByChild("userId").equalTo(userId).once("value"),
      ]);

      const depositsData    = depositsSnap.val() || {};
      const confirmedDeps   = Object.values(depositsData).filter(d => !d.status || d.status !== 'pending');
      const totalDepositTon = confirmedDeps.reduce((s, d) => s + (Number(d.amount) || 0), 0);

      const paidWdData   = paidWdSnap.val() || {};
      const totalPaidTon = Object.values(paidWdData)
        .filter(d => d.status === 'paid')
        .reduce((s, d) => s + roundAmount(d.ton), 0);

      const projectedTotal = totalPaidTon + roundedAmount;

      console.log(`🔍 Deposit check [${userId}]: deposited=${totalDepositTon.toFixed(3)} paidSoFar=${totalPaidTon.toFixed(3)} thisWd=${roundedAmount} projected=${projectedTotal.toFixed(3)}`);

      if (projectedTotal > totalDepositTon) {
        if (totalDepositTon === 0 && roundedAmount <= 0.1) {
          console.log(`✅ Free user withdrawal allowed (≤0.1 TON): user ${userId} | ${roundedAmount} TON`);
        } else {
        await db.ref(`withdrawQueue/${withdrawId}`).update({
          status:    "awaiting_approval",
          updatedAt: Date.now(),
          holdReason: `السحوبات (${projectedTotal.toFixed(3)} TON) تتجاوز الإيداعات (${totalDepositTon.toFixed(3)} TON)`,
        });

        const zeroDeposit = totalDepositTon === 0;
        const requestTime = new Date(data.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
        const warningText =
          `⚠️ <b>سحب يحتاج موافقة — ${zeroDeposit ? '🚨 لا يوجد إيداع' : 'تجاوز الإيداعات'}</b>\n\n` +
          `👤 User: <code>${userId}</code>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `🆔 ID: <code>${withdrawId}</code>\n` +
          `💰 المبلغ: <b>${roundedAmount} TON</b>\n` +
          `📥 إجمالي الإيداعات: <b>${zeroDeposit ? '❌ لا يوجد' : totalDepositTon.toFixed(3) + ' TON'}</b>\n` +
          `📤 سحوبات مدفوعة سابقاً: <b>${totalPaidTon.toFixed(3)} TON</b>\n` +
          `📊 الإجمالي بعد الدفع: <b>${projectedTotal.toFixed(3)} TON</b>\n` +
          `📬 المحفظة:\n<code>${data.address}</code>\n` +
          `🕐 الوقت: ${requestTime} UTC\n` +
          `━━━━━━━━━━━━━━━━\n\n` +
          (zeroDeposit ? `🚨 المستخدم لم يودع أي مبلغ! هل توافق؟` : `⚠️ السحوبات ستتجاوز الإيداعات! هل توافق؟`);

        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id:      ADMIN_CHAT_ID,
              text:         warningText,
              parse_mode:   'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ موافقة — ادفع الآن", callback_data: `approve_wd:${withdrawId}` },
                  { text: "❌ رفض — إلغاء",        callback_data: `reject_wd:${withdrawId}`  },
                ]]
              }
            }),
          });
          const resData = await res.json();
          if (resData.ok) console.log(`📨 Deposit alert sent for ${withdrawId}`);
          else console.log(`❌ Deposit alert failed: ${JSON.stringify(resData)}`);
        }
        return { valid: false, skip: false };
        }
      }
      console.log(`✅ Deposit check passed for ${userId}`);
    } catch (e) { console.log(`⚠️ Deposit check error: ${e.message}`); }
  }

  if (userId && !data.approvedByAdmin) {
    const dailyCount = await getUserDailyWithdrawalCount(userId);
    if (dailyCount >= DAILY_LIMIT) {
      const cooldownMs  = DAILY_COOLDOWN_HOURS * 60 * 60 * 1000;
      const unlockTime  = (data.ts || Date.now()) + cooldownMs;
      const unlockStr   = new Date(unlockTime).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
      await db.ref(`withdrawQueue/${withdrawId}`).update({
        status: "awaiting_approval", updatedAt: Date.now(),
        holdReason: `تجاوز الحد اليومي (${dailyCount}/${DAILY_LIMIT}) — سيُدفع تلقائياً بعد ${DAILY_COOLDOWN_HOURS}ساعة`,
        unlockAt:  unlockTime,
      });
      console.log(`⏳ Daily limit — ${withdrawId} queued until ${unlockStr} UTC`);
      return { valid: false, skip: false };
    }
  }

  if (roundedAmount > MAX_WITHDRAWAL_AMOUNT && !data.approvedByAdmin) {
    // سحب يتجاوز الحد الأقصى — يحتاج مراجعة يدوية من الأدمن
    const already = (data.status === 'awaiting_manual');
    if (!already) {
      await db.ref(`withdrawQueue/${withdrawId}`).update({
        status: 'awaiting_manual',
        updatedAt: Date.now(),
        holdReason: `يتجاوز الحد الأقصى للدفع التلقائي (${MAX_WITHDRAWAL_AMOUNT} TON) — يحتاج موافقة يدوية`,
      });
      console.log(`⏸ Manual review required: ${withdrawId} | ${roundedAmount} TON > ${MAX_WITHDRAWAL_AMOUNT} TON`);
    }
    return { valid: false, skip: false };
  }
  if (roundedAmount < MIN_WITHDRAWAL_AMOUNT) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Below min ${MIN_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
    return { valid: false, skip: false };
  }

  await db.ref(`withdrawQueue/${withdrawId}`).update({ error: null, lastError: null, updatedAt: Date.now() }).catch(() => {});
  return { valid: true, roundedAmount, userId, wdId };
}

// ==========================
// 🔹 إرسال دفعة Batch
// ==========================
async function sendBatchTransfer(items, attempt = 0) {
  const MAX_BATCH_RETRIES = 2;
  const batchIds = items.map(i => i.id).join(', ');
  const totalTON = items.reduce((s, i) => s + i.roundedAmount, 0);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📦 BATCH TRANSFER | ${items.length} items | ${totalTON.toFixed(4)} TON total`);
  console.log(`   IDs: ${batchIds}`);
  console.log(`${'='.repeat(50)}`);

  const balanceCheck = await checkSufficientBalance(totalTON);
  if (!balanceCheck.sufficient) {
    console.log(`⏭️ Insufficient balance for batch: ${balanceCheck.balance.toFixed(3)} TON < ${totalTON.toFixed(3)} TON`);
    for (const item of items) {
      processingQueue.delete(item.id);
      await db.ref(`withdrawQueue/${item.id}`).update({
        status: "pending", updatedAt: Date.now(),
        lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON`
      }).catch(() => {});
    }
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();

    const validMessages = [];
    const invalidItems  = [];

    for (const item of items) {
      try {
        const needsComment = item.roundedAmount > 0.1;
        const msg = internal({
          to: item.data.address,
          value: toNano(item.roundedAmount.toFixed(3)),
          bounce: false,
          ...(needsComment ? { body: 'RaseenRacing_bot' } : {})
        });
        validMessages.push({ item, msg });
      } catch (addrErr) {
        const reason = addrErr.message || 'Invalid address';
        console.log(`❌ Bad address — cancelling ${item.id}: ${reason}`);
        invalidItems.push({ item, reason });
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "cancelled", updatedAt: Date.now(), error: `Bad address: ${reason}` }).catch(() => {});
        if (item.userId && item.wdId) {
          await db.ref(`users/${item.userId}/wdHistory/${item.wdId}`).update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
        }
        processingQueue.delete(item.id);
      }
    }

    if (invalidItems.length > 0 && botInstance) {
      const lines = invalidItems.map(x =>
        `• <code>${x.item.id}</code> | 👤 <code>${x.item.userId || '?'}</code>\n  📬 <code>${String(x.item.data.address).substring(0, 60)}</code>\n  ❌ ${x.reason}`
      ).join('\n\n');
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `⚠️ <b>${invalidItems.length} عنوان فاسد — تم إلغاؤها تلقائياً</b>\n\n${lines}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    if (validMessages.length === 0) {
      console.log(`🚫 Batch cancelled — all addresses invalid`);
      return { success: false, reason: 'all_invalid' };
    }

    const cleanItems = validMessages.map(x => x.item);
    const messages   = validMessages.map(x => x.msg);
    const cleanTotal = cleanItems.reduce((s, i) => s + i.roundedAmount, 0);
    console.log(`📦 Building batch: ${cleanItems.length}/${items.length} valid | ${cleanTotal.toFixed(4)} TON`);

    const recheck = await checkSufficientBalance(cleanTotal);
    if (!recheck.sufficient) {
      for (const item of cleanItems) {
        processingQueue.delete(item.id);
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Insufficient balance: ${recheck.balance.toFixed(3)} TON` }).catch(() => {});
      }
      return { success: false, reason: 'insufficient_balance' };
    }

    await new Promise(r => setTimeout(r, 1000));
    await contract.sendTransfer({ secretKey: key.secretKey, seqno, messages });
    console.log(`📤 Batch submitted — seqno: ${seqno} | ${cleanItems.length} msgs | attempt: ${attempt + 1}`);

    const confirmation = await confirmBatchTransaction(seqno, 120000);

    if (!confirmation.confirmed) {
      console.log(`⚠️ Batch TIMEOUT — seqno ${seqno} not advanced. Marking as needs_review.`);
      for (const item of cleanItems) {
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "needs_review", updatedAt: Date.now(), lastError: `Batch timeout — seqno ${seqno} — verify manually`, batchSeqno: seqno }).catch(() => {});
        processingQueue.delete(item.id);
      }
      if (botInstance) {
        await botInstance.sendMessage(ADMIN_CHAT_ID,
          `⚠️ <b>Batch Timeout</b>\n\n${cleanItems.length} سحوبات تحتاج مراجعة يدوية\nSeqno: <code>${seqno}</code>\n\nIDs:\n${cleanItems.map(i => `• <code>${i.id}</code>`).join('\n')}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return { success: false, reason: 'timeout', seqno };
    }

    let batchTxHash = null;
    try {
      const txRes  = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=5`, { headers: { "X-API-Key": process.env.TON_API_KEY } });
      const txData = await txRes.json();
      batchTxHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch (e) { console.log(`⚠️ Could not fetch batch tx hash: ${e.message}`); }

    console.log(`✅ Batch confirmed | hash: ${batchTxHash ? batchTxHash.substring(0, 14) + '...' : 'N/A'}`);

    const updatePromises = cleanItems.map(async (item) => {
      try {
        await db.ref(`withdrawQueue/${item.id}`).update({ status: "paid", updatedAt: Date.now(), completedAt: Date.now(), txHash: batchTxHash || null, sentAmount: item.roundedAmount, batchSize: cleanItems.length });
        await updateUserWdHistory(item.userId, item.wdId, batchTxHash, item.roundedAmount);
        processingQueue.delete(item.id);
        console.log(`   ✅ Marked paid: ${item.id}`);
      } catch (e) { console.log(`   ❌ Failed to update ${item.id}: ${e.message}`); }
    });
    await Promise.all(updatePromises);

    for (const item of cleanItems) {
      const sent = await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash);
      if (!sent) { await new Promise(r => setTimeout(r, 2000)); await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash); }
    }
    await sendChannelNotification(cleanItems, batchTxHash).catch(() => {});
    console.log(`🎉 Batch complete: ${cleanItems.length} paid`);
    return { success: true, txHash: batchTxHash, count: cleanItems.length };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Batch attempt ${attempt + 1} failed: ${msg}`);
    const isNetworkError = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');
    if (isNetworkError && attempt < MAX_BATCH_RETRIES) {
      const waitSec = 20 * (attempt + 1);
      console.log(`🔁 Network error — retrying batch in ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendBatchTransfer(items, attempt + 1);
    }
    const revertList = (typeof cleanItems !== 'undefined') ? cleanItems : items;
    for (const item of revertList) {
      await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Batch failed (attempt ${attempt + 1}): ${msg}`, attempts: (item.data.attempts || 0) + 1 }).catch(() => {});
      processingQueue.delete(item.id);
    }
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `🔴 <b>Batch Failed</b>\n\n${items.length} سحوبات فشلت وأُعيدت لـ pending\n\n<i>${msg.substring(0, 300)}</i>\n\nIDs:\n${items.map(i => `• <code>${i.id}</code>`).join('\n')}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 إرسال سحب واحد (Single mode)
// ==========================
async function sendSingleTransfer(item, attempt = 0) {
  const MAX_SINGLE_RETRIES = 3;
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`💸 SINGLE TRANSFER | ${item.id} | ${item.roundedAmount} TON → ${item.data.address.substring(0,10)}...`);

  const balanceCheck = await checkSufficientBalance(item.roundedAmount);
  if (!balanceCheck.sufficient) {
    processingQueue.delete(item.id);
    await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON` }).catch(() => {});
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();
    await new Promise(r => setTimeout(r, 1000));
    const needsComment = item.roundedAmount > 0.1;
    await contract.sendTransfer({ secretKey: key.secretKey, seqno, messages: [internal({ to: item.data.address, value: toNano(item.roundedAmount.toFixed(3)), bounce: false, ...(needsComment ? { body: 'RaseenRacing_bot' } : {}) })] });
    console.log(`📤 Single submitted — seqno: ${seqno} | attempt: ${attempt + 1}`);

    const confirmation = await confirmBatchTransaction(seqno, 90000);
    if (!confirmation.confirmed) {
      console.log(`⚠️ Single TIMEOUT — seqno ${seqno}`);
      await db.ref(`withdrawQueue/${item.id}`).update({ status: "needs_review", updatedAt: Date.now(), lastError: `Single timeout — seqno ${seqno} — verify manually` }).catch(() => {});
      processingQueue.delete(item.id);
      if (botInstance) {
        await botInstance.sendMessage(ADMIN_CHAT_ID, `⚠️ <b>Single Timeout</b>\n\n<code>${item.id}</code>\nSeqno: <code>${seqno}</code>\nراجع يدوياً`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return { success: false, reason: 'timeout' };
    }

    let txHash = null;
    try {
      const txRes  = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=3`, { headers: { "X-API-Key": process.env.TON_API_KEY } });
      const txData = await txRes.json();
      txHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch(e) {}

    await db.ref(`withdrawQueue/${item.id}`).update({ status: "paid", updatedAt: Date.now(), completedAt: Date.now(), txHash: txHash || null, sentAmount: item.roundedAmount, batchSize: 1 });
    await updateUserWdHistory(item.userId, item.wdId, txHash, item.roundedAmount);
    processingQueue.delete(item.id);
    console.log(`✅ Single paid: ${item.id} | hash: ${txHash ? txHash.substring(0,12)+'...' : 'N/A'}`);

    const sent = await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, txHash);
    if (!sent) { await new Promise(r => setTimeout(r, 2000)); await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, txHash); }
    await sendChannelNotification([item], txHash).catch(() => {});
    return { success: true, txHash };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Single attempt ${attempt + 1} failed: ${msg}`);
    const isNetwork = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');
    if (isNetwork && attempt < MAX_SINGLE_RETRIES) {
      const waitSec = 15 * (attempt + 1);
      console.log(`🔁 Retrying single in ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendSingleTransfer(item, attempt + 1);
    }
    await db.ref(`withdrawQueue/${item.id}`).update({ status: "pending", updatedAt: Date.now(), lastError: `Single failed (${attempt + 1}): ${msg}`, attempts: (item.data.attempts || 0) + 1 }).catch(() => {});
    processingQueue.delete(item.id);
    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 معالجة السحوبات المعلقة
// ==========================
async function processPendingWithdrawals() {
  if (!WITHDRAWAL_ENABLED) { console.log("⛔ Withdrawal system disabled — skipping"); return; }
  if (systemPaused) { console.log("⏸️ Paused — skipping"); return; }
  if (isProcessing)  { console.log("⚠️ Already processing — skipping"); return; }

  try {
    isProcessing = true;
    await unlockExpiredDailyLimits();

    const snapshot    = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
    const withdrawals = snapshot.val();
    if (!withdrawals) { console.log("📭 No pending withdrawals"); isProcessing = false; return; }

    const list = Object.entries(withdrawals)
      .filter(([id]) => !processingQueue.has(id))
      .map(([id, d]) => ({ id, data: d, timestamp: d.ts || d.timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!list.length) { console.log("📭 All pending already in processingQueue"); isProcessing = false; return; }

    const mode = PROCESSING_MODE;
    console.log(`\n📋 ${list.length} pending | Mode: ${mode.toUpperCase()} | BatchSize: ${BATCH_SIZE}`);

    const validItems = [];
    for (const { id, data } of list) {
      processingQueue.add(id);
      const validation = await validateWithdrawal(id, data);
      if (!validation.valid) { processingQueue.delete(id); continue; }

      let locked = false;
      await db.ref(`withdrawQueue/${id}`).transaction((current) => {
        if (!current || current.status !== "pending") return;
        locked = true;
        return { ...current, status: "processing", updatedAt: Date.now(), attempts: (current.attempts || 0) + 1 };
      });

      if (!locked) { console.log(`⏭️ ${id} already taken — skipping`); processingQueue.delete(id); continue; }

      validItems.push({ id, data, roundedAmount: validation.roundedAmount, userId: validation.userId, wdId: validation.wdId, amountCoins: data.amt || 0 });
    }

    if (!validItems.length) { console.log("📭 No valid withdrawals after checks"); isProcessing = false; return; }

    const totalTON = validItems.reduce((s, i) => s + i.roundedAmount, 0);

    if (mode === 'batch') {
      const batchCount = Math.ceil(validItems.length / BATCH_SIZE);
      console.log(`\n🚀 BATCH | ${validItems.length} items → ${batchCount} batch(es) | ${totalTON.toFixed(4)} TON`);
      for (let b = 0; b < batchCount; b++) {
        const batch = validItems.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        console.log(`\n▶️ Batch ${b + 1}/${batchCount} (${batch.length} items)...`);
        await sendBatchTransfer(batch);
        if (b < batchCount - 1) { console.log(`⏳ Waiting ${BATCH_BETWEEN_DELAY / 1000}s...`); await new Promise(r => setTimeout(r, BATCH_BETWEEN_DELAY)); }
      }
    } else {
      console.log(`\n🚀 SINGLE | ${validItems.length} items | ${totalTON.toFixed(4)} TON | delay: ${SINGLE_DELAY_MS/1000}s`);
      for (let i = 0; i < validItems.length; i++) {
        if (systemPaused) { console.log("⏸ Paused mid-single — stopping"); break; }
        console.log(`\n▶️ Single ${i + 1}/${validItems.length}: ${validItems[i].id}`);
        await sendSingleTransfer(validItems[i]);
        if (i < validItems.length - 1) { await new Promise(r => setTimeout(r, SINGLE_DELAY_MS)); }
      }
    }

  } catch (e) { console.log(`❌ processPendingWithdrawals: ${e.message}`); }
  finally { isProcessing = false; console.log("✅ processPendingWithdrawals cycle done"); }
}

// ==========================
// 🔹 فتح الطلبات المعلقة التي انتهت مدة الانتظار
// ==========================
async function unlockExpiredDailyLimits() {
  try {
    const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
    const items = snap.val();
    if (!items) return;
    const now = Date.now();
    let unlocked = 0;
    for (const [id, d] of Object.entries(items)) {
      if (d.unlockAt && now >= d.unlockAt) {
        await db.ref(`withdrawQueue/${id}`).update({ status: "pending", updatedAt: now, holdReason: null, unlockAt: null, lastError: null });
        unlocked++;
        console.log(`🔓 Unlocked daily-limit withdrawal: ${id}`);
      }
    }
    if (unlocked > 0) console.log(`🔓 Unlocked ${unlocked} daily-limit withdrawals`);
  } catch (e) { console.log(`❌ unlockExpiredDailyLimits: ${e.message}`); }
}

// ==========================
// 🔹 فحص الإيداعات (كل 5 دقايق) - تعديل: إضافة TON Balance بدلاً من Bamboo
// ==========================
async function checkDeposits() {
  const wallet   = process.env.TON_WALLET_ADDRESS;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!wallet || !botToken) return;

  console.log("💰 Checking TON deposits...");

  try {
    const response = await fetch(
      `https://toncenter.com/api/v2/getTransactions?address=${wallet}&limit=120`,
      { headers: { "X-API-Key": process.env.TON_API_KEY } }
    );
    const data = await response.json();
    if (!data.result) { console.log("No transactions found"); return; }

    for (const tx of data.result) {
      const txHash = tx.transaction_id.hash;
      if (!tx.in_msg || !tx.in_msg.message) continue;
      let comment = tx.in_msg.message.trim();
      if (!comment) continue;

      // استخراج userId من الكومنت — يدعم الشكلين:
      //   الجديد: {"user_id":"7278991674","TG":"RaseenRacing_bot"}
      //   القديم: 7278991674
      let userId = null;
      if (comment.startsWith('{')) {
        try {
          const parsed = JSON.parse(comment);
          if (parsed && parsed.user_id && /^\d+$/.test(String(parsed.user_id))) {
            userId = String(parsed.user_id);
          }
        } catch (e) {}
      } else if (/^\d+$/.test(comment)) {
        userId = comment;
      }
      if (!userId) continue;
      const amountTon = Number(tx.in_msg.value) / 1e9;
      if (amountTon <= 0) continue;

      // تحقق هل المعاملة اتعالجت قبل كده
      let alreadyProcessed = false;
      try {
        const snap = await db.ref(`processed/${txHash}`).once("value");
        alreadyProcessed = snap.exists();
      } catch(e) {}
      if (alreadyProcessed) continue;

      // جلب بيانات المستخدم
      let userData = null;
      try {
        const snap = await db.ref(`users/${userId}`).once("value");
        userData = snap.val();
      } catch(e) {}
      if (!userData) continue;

      // 🔁 تعديل: إضافة رصيد TON مباشرة بدلاً من Bamboo (بدون 50% Bonus)
      const currentTonBalance = Number(userData.tonBalance || 0);
      const newTonBalance = currentTonBalance + amountTon;

      // تحديث رصيد TON + تعليم المستخدم كمودع
      await db.ref(`users/${userId}`).update({
        tonBalance:   newTonBalance,
        hasDeposited: true,
      });

      // تسجيل بيانات الإيداع
      const txLink           = `https://tonscan.org/tx/${encodeURIComponent(txHash)}`;
      const depositTimestamp = Date.now();
      await db.ref(`users/${userId}/deposits`).push({
        amount:      amountTon,
        tonAdded:    amountTon,
        txHash,
        txLink,
        date:        new Date(depositTimestamp).toISOString(),
        timestamp:   depositTimestamp,
      });

      // تعليم المعاملة كمُعالجة
      await db.ref(`processed/${txHash}`).set(true);

      console.log(`💰 Deposit: +${amountTon} TON → user ${userId} (${currentTonBalance} → ${newTonBalance} TON)`);

      // 🔁 تعديل: إشعار المستخدم برصيد TON (بدون Bamboo وبدون 50% Bonus)
      const formattedTon    = amountTon.toFixed(6);
      const formattedNewBalance = newTonBalance.toFixed(6);
      const depositCaption =
        `🔥 <b>RASEENRACING • DEPOSIT SUCCESSFUL</b> 🔥\n` +
        `Your TON has arrived and you're ready to hit the track 🏍️⚡\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💎 <b>Deposit:</b> ${formattedTon} TON\n` +
        `💰 <b>Balance:</b> ${formattedNewBalance} TON\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🏁 Upgrade your bike\n` +
        `⚔️ Join PvP races\n` +
        `⛏️ Start mining TON rewards\n\n` +
        `The road to victory starts now 🚀\n\n` +
        `🔗 <a href="${txLink}">View Transaction</a>`;

      await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    userId,
          photo:      "https://res.cloudinary.com/dktppfipy/image/upload/v1779060536/deposit_glopgj.jpg",
          caption:    depositCaption,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "🚀 Open", url: "https://t.me/RaseenRacing_bot/app?startapp=" }]]
          }
        })
      });
      console.log(`📨 Deposit notification sent to user ${userId}`);

      // 🔁 تعديل: إشعار الأدمن بالإيداع (بدون Bamboo)
      const adminMessage =
        `💰 <b>إيداع جديد تم معالجته ✅</b>\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `👤 User ID: <code>${userId}</code>\n` +
        `💎 المبلغ: <b>${formattedTon} TON</b>\n` +
        `🏦 رصيد TON الجديد: <b>${formattedNewBalance} TON</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `✅ تم تحديث الرصيد\n` +
        `✅ تم إرسال إشعار للمستخدم\n` +
        `🔗 <a href="${txLink}">View Transaction</a>`;

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:                ADMIN_CHAT_ID,
          text:                   adminMessage,
          parse_mode:             "HTML",
          disable_web_page_preview: false,
        })
      });
      console.log(`📨 Admin notified about deposit from user ${userId}`);
    }

    console.log("✅ Deposit check completed.");
  } catch (e) { console.log(`❌ checkDeposits: ${e.message}`); }
}

// ==========================
// 🔹 بوت الترحيب + أوامر الأدمن
// ==========================
function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.log("⚠️ TELEGRAM_BOT_TOKEN missing"); return; }

  const bot = new TelegramBot(botToken, { polling: true });
  botInstance = bot;
  bot.setMyCommands([
    { command: 'start', description: 'رسالة الترحيب' },
    { command: 'help', description: 'كل أوامر الأدمن' },
    { command: 'balance', description: 'رصيد محفظة TON' },
    { command: 'queue', description: 'حالة قوائم السحب' },
    { command: 'pending_reasons', description: 'أسباب السحوبات المعلقة' },
    { command: 'pending_wd', description: 'مراجعة السحوبات اليدوية' },
    { command: 'awaiting_queue', description: 'قائمة السحوبات المنتظرة' },
    { command: 'unlock', description: 'تحرير سحوبات معلقة' },
    { command: 'logs', description: 'سجل نشاط مستخدم مع المكافآت' },
    { command: 'stats', description: 'إحصائيات كاملة' },
    { command: 'lastpaid', description: 'آخر معاملات مدفوعة' },
    { command: 'mode', description: 'وضع المعالجة الحالي' },
    { command: 'batchstatus', description: 'حالة نظام المعالجة' },
    { command: 'process', description: 'تشغيل المعالجة' },
    { command: 'pause', description: 'إيقاف المعالجة' },
    { command: 'resume', description: 'استئناف المعالجة' },
    { command: 'clearqueue', description: 'إلغاء السحوبات pending' },
    { command: 'retryall', description: 'إعادة محاولة الفاشلة' },
    { command: 'setmax', description: 'تعيين حد الدفع التلقائي' },
    { command: 'setmin', description: 'تعيين الحد الأدنى' },
    { command: 'setrate', description: 'تعيين سعر Bamboo' },
    { command: 'setdaily', description: 'تعيين الحد اليومي' },
    { command: 'setcooldown', description: 'تعيين مدة الانتظار' },
    { command: 'setmode', description: 'تغيير Batch/Single' },
    { command: 'setbatchsize', description: 'تعيين حجم الدفعة' },
    { command: 'setsingledelay', description: 'تعيين تأخير Single' },
    { command: 'userinfo', description: 'معلومات مستخدم' },
    { command: 'banuser', description: 'حظر مستخدم' },
    { command: 'unbanuser', description: 'رفع حظر مستخدم' },
    { command: 'banwallet', description: 'حظر محفظة' },
    { command: 'unwallet', description: 'رفع حظر محفظة' },
    { command: 'addcoins', description: 'إضافة Coins' },
    { command: 'addbamboo', description: 'إضافة Bamboo' },
    { command: 'addton', description: 'إضافة TON' },
    { command: 'sendmsg', description: 'إرسال رسالة لمستخدم' },
    { command: 'broadcast', description: 'إرسال رسالة للجميع' },
    { command: 'broadcast_status', description: 'حالة البث' },
    { command: 'broadcast_debug', description: 'فحص البث' },
    { command: 'cancel', description: 'إلغاء جلسة الرسائل' },
    { command: 'check_suspicious', description: 'كشف محافظ مشتركة' },
    { command: 'reject_suspicious', description: 'رفض المشبوهين' },
    { command: 'check_nodeposit', description: 'سحبوا بدون إيداع' },
  ]).catch(e => console.log(`⚠️ setMyCommands: ${e.message}`));

  const isAdmin = (msg) => isAdminId(msg.chat.id);
  const unauth  = async (msg) => await bot.sendMessage(msg.chat.id, "⛔ Unauthorized");

  // ─── /start ───────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`👋 /start: ${chatId}`);
    const caption =
      `🏍️🔥 <b>Welcome to RaseenRacing!</b>\n\n` +
      `Race REAL players in intense 3D PvP battles and win TON rewards 💎\n\n` +
      `🏁 Upgrade your bike\n` +
      `⛏️ Mine daily TON rewards\n` +
      `👥 Invite friends &amp; earn commissions\n` +
      `💰 Withdraw your earnings anytime\n\n` +
      `🚀 Start now and become a racing legend!`;
    try {
      await bot.sendPhoto(chatId,
        "https://res.cloudinary.com/dktppfipy/image/upload/v1779047977/image_potboz.jpg",
        {
          caption,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Open", url: "https://t.me/RaseenRacing_bot/app?startapp=" }],
              [
                { text: "📢 Channel", url: "https://t.me/RaseenRacing" },
                { text: "💬 Community", url: "https://t.me/RaseenRacing_chat" }
              ]
            ]
          }
        }
      );
    } catch (e) {
      console.log(`❌ /start sendPhoto error: ${e.message}`);
    }
  });

  // ─── /help ────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
      `🐼 <b>RaseenRacing — لوحة الأدمن</b>\n` +
      `${'═'.repeat(32)}\n\n` +
      `👋 <b>أساسي</b>\n` +
      `/start — رسالة الترحيب\n` +
      `/help — عرض كل الأوامر\n` +
      `/my — لوحة التحكم الخاصة\n\n` +
      `📊 <b>المعلومات والمراقبة</b>\n` +
      `/balance — رصيد محفظة TON\n` +
      `/queue — حالة كل قوائم السحب\n` +
      `/lastpaid — آخر 5 معاملات مدفوعة\n` +
      `/batchstatus — حالة نظام المعالجة\n\n` +
      `⚙️ <b>إعدادات السحب</b>\n` +
      `/setmax [TON] — الحد الأقصى للدفع التلقائي\n` +
      `/setmin [TON] — الحد الأدنى للسحب\n` +
      `/setdaily [رقم] — الحد اليومي للمستخدم\n` +
      `/setcooldown [ساعات] — مدة الانتظار بعد تجاوز الحد\n` +
      `/setmode batch|single — تغيير وضع المعالجة\n` +
      `/setbatchsize [1-4] — حجم الدفعة\n` +
      `/setsingledelay [ثواني] — تأخير Single\n\n` +
      `💸 <b>السحوبات والمراجعة</b>\n` +
      `/process — تشغيل المعالجة يدوياً\n` +
      `/clearqueue — إلغاء السحوبات pending\n` +
      `/pause — إيقاف المعالجة\n` +
      `/resume — استئناف المعالجة\n\n` +
      `👤 <b>إدارة المستخدمين</b>\n` +
      `/banwallet [address] — حظر محفظة\n` +
      `/unwallet [address] — رفع حظر محفظة\n` +
      `/addcoins [userId] [كمية] — إضافة Coins\n` +
      `/addbamboo [userId] [كمية] — إضافة Bamboo\n\n` +
      `📨 <b>إرسال رسائل</b>\n` +
      `/sendmsg [userId] — إرسال رسالة لمستخدم\n` +
      `/broadcast — إرسال رسالة للجميع\n` +
      `/broadcast_status — حالة البث\n` +
      `/broadcast_debug — فحص مسار المستخدمين\n` +
      `/cancel — إلغاء جلسة إرسال الرسائل\n\n` +
      `🕵️ <b>كشف التلاعب</b>\n` +
      `/check_suspicious — كشف محافظ مشتركة (+3 مستخدمين)\n` +
      `/reject_suspicious — رفض وحظر المشبوهين\n` +
      `/check_nodeposit — كشف مستخدمين سحبوا بدون إيداع`
    );
  });

  // ─── /my ──────────────────────────────────────────────
  bot.onText(/\/my/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
      `🎛 <b>RaseenRacing — لوحة التحكم الخاصة</b>\n` +
      `${'═'.repeat(32)}\n\n` +
      `📊 <b>الإحصائيات والمراقبة</b>\n` +
      `/stats — إحصائيات كاملة\n\n` +
      `🔍 <b>معلومات المستخدمين</b>\n` +
      `/userinfo [userId] — معلومات مستخدم كاملة\n` +
      `/logs [userId] [30|100|200|all] — سجل النشاطات مع المكافآت\n\n` +
      `💸 <b>إدارة السحوبات</b>\n` +
      `/pending_wd — مراجعة السحوبات التي تحتاج موافقة يدوية\n` +
      `/awaiting_queue — سحوبات معلقة بسبب الحد اليومي/الموافقة\n` +
      `/unlock [عدد] — تحرير عدد من السحوبات المعلقة للدفع\n` +
      `/retryall — إعادة محاولة السحوبات failed\n\n` +
      `👤 <b>إدارة المستخدمين</b>\n` +
      `/banuser [userId] — حظر مستخدم\n` +
      `/unbanuser [userId] — رفع حظر مستخدم\n\n` +
      `💎 <b>إضافة رصيد</b>\n` +
      `/addton [userId] [كمية] — إضافة TON\n\n` +
      `⚙️ <b>إعدادات السعر</b>\n` +
      `/setrate [رقم] — سعر Bamboo→TON\n` +
      `/mode — الوضع الحالي Batch/Single`
    );
  });

  // ─── /balance ─────────────────────────────────────────
  bot.onText(/\/balance/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const b = await getWalletBalance();
    await adminReply(bot, msg.chat.id, `💰 <b>Wallet Balance:</b> ${b.toFixed(6)} TON\n📬 <code>${walletAddress || 'not loaded'}</code>`);
  });

  // ─── /queue ───────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const [snapP, snapM, snapA, snapR] = await Promise.all([
        db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_manual").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value"),
      ]);
      const pendingItems = snapP.exists() ? snapP.val() : {};
      const manualItems  = snapM.exists() ? snapM.val() : {};
      const approvalItems = snapA.exists() ? snapA.val() : {};
      const processingItems = snapR.exists() ? snapR.val() : {};
      const pendingCount = Object.keys(pendingItems).length;
      const manualCount = Object.keys(manualItems).length;
      const approvalCount = Object.keys(approvalItems).length;
      const processingCount = Object.keys(processingItems).length;
      const totalTON = [...Object.values(pendingItems), ...Object.values(manualItems), ...Object.values(approvalItems), ...Object.values(processingItems)]
        .reduce((s, d) => s + roundAmount(d.ton ?? d.amt), 0).toFixed(4);
      await adminReply(bot, msg.chat.id,
        `📋 <b>Queue Status</b>\n\n` +
        `⏳ Pending: <b>${pendingCount}</b>\n` +
        `📝 Awaiting manual: <b>${manualCount}</b>\n` +
        `⏸ Awaiting approval/daily: <b>${approvalCount}</b>\n` +
        `🔄 Processing: <b>${processingCount}</b>\n` +
        `💰 Total held: <b>${totalTON} TON</b>\n\n` +
        `📦 Batch size: <b>${BATCH_SIZE}</b> per batch\n` +
        `⚡ Est. batches needed: <b>${Math.ceil(pendingCount / BATCH_SIZE)}</b>\n\n` +
        `💡 استخدم /pending_wd لمراجعة السحوبات اليدوية`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /mode ────────────────────────────────────────────
  bot.onText(/\/mode/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
    await adminReply(bot, msg.chat.id,
      `${modeIcon} <b>وضع المعالجة الحالي: ${PROCESSING_MODE.toUpperCase()}</b>\n\n` +
      (PROCESSING_MODE === 'batch'
        ? `📦 Batch: يجمع حتى <b>${BATCH_SIZE}</b> سحوبات في معاملة واحدة\n⏳ تأخير بين الدفعات: <b>${BATCH_BETWEEN_DELAY/1000}s</b>`
        : `💸 Single: يرسل كل سحب منفرداً\n⏳ تأخير بين كل سحب: <b>${SINGLE_DELAY_MS/1000}s</b>`) +
      `\n\n🔄 Processing: <b>${isProcessing ? '✅ يعمل' : '⏹ متوقف'}</b>` +
      `\n⏸ Paused: <b>${systemPaused ? 'نعم ⏸' : 'لا ✅'}</b>` +
      `\n🔒 في القائمة: <b>${processingQueue.size}</b>`
    );
  });

  // ─── /batchstatus ─────────────────────────────────────
  bot.onText(/\/batchstatus/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const [snapP, snapA, snapM, snapR] = await Promise.all([
        db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_manual").once("value"),
        db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value"),
      ]);
      const pendingCount  = snapP.exists() ? Object.keys(snapP.val()).length : 0;
      const approvalCount = snapA.exists() ? Object.keys(snapA.val()).length : 0;
      const manualCount   = snapM.exists() ? Object.keys(snapM.val()).length : 0;
      const processingCount = snapR.exists() ? Object.keys(snapR.val()).length : 0;
      const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
      await adminReply(bot, msg.chat.id,
        `${modeIcon} <b>حالة نظام المعالجة</b>\n\n🔀 الوضع: <b>${PROCESSING_MODE.toUpperCase()}</b>\n🔢 حجم الدفعة: <b>${BATCH_SIZE}</b>\n⏱ Flush كل: <b>${BATCH_FLUSH_SECONDS}s</b>\n⏳ تأخير بين دفعات: <b>${BATCH_BETWEEN_DELAY/1000}s</b>\n💸 تأخير Single: <b>${SINGLE_DELAY_MS/1000}s</b>\n\n📋 Pending: <b>${pendingCount}</b>\n📝 Awaiting manual: <b>${manualCount}</b>\n⏳ Awaiting approval/daily: <b>${approvalCount}</b>\n🔄 Processing: <b>${processingCount}</b>\n🔄 Processing now: <b>${isProcessing ? 'نعم' : 'لا'}</b>\n⏸ Paused: <b>${systemPaused ? 'نعم ⏸' : 'لا ✅'}</b>\n🔒 In processingQueue: <b>${processingQueue.size}</b>\n\n📅 الحد اليومي: <b>${DAILY_LIMIT}</b> سحوبات\n⏰ Cooldown: <b>${DAILY_COOLDOWN_HOURS}</b> ساعة\n💡 اليدوي يظهر في /pending_wd`
      );
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /stats ───────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val() || {};
      const counts = { pending: 0, processing: 0, paid: 0, failed: 0, bounced: 0, cancelled: 0, awaiting_approval: 0, awaiting_manual: 0, needs_review: 0 };
      let totalPaid = 0;
      Object.values(items).forEach(d => {
        counts[d.status] = (counts[d.status] || 0) + 1;
        if (d.status === 'paid') totalPaid += Number(d.sentAmount || d.amt || d.ton || 0);
      });
      const bal = await getWalletBalance();
      const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
      await adminReply(bot, msg.chat.id,
        `📊 <b>إحصائيات الوضع الحالي</b>\n\n` +
        `✅ مدفوعة: <b>${counts.paid}</b> (${totalPaid.toFixed(3)} TON)\n` +
        `⏳ Pending: <b>${counts.pending}</b>\n` +
        `🔄 Processing: <b>${counts.processing}</b>\n` +
        `⏸ Awaiting (daily): <b>${counts.awaiting_approval}</b>\n` +
        `📝 Awaiting manual: <b>${counts.awaiting_manual}</b>\n` +
        `🔴 Bounced: <b>${counts.bounced}</b>\n` +
        `❌ Failed: <b>${counts.failed}</b>\n` +
        `🔍 Needs review: <b>${counts.needs_review}</b>\n` +
        `🚫 Cancelled: <b>${counts.cancelled}</b>\n\n` +
        `💰 رصيد المحفظة: <b>${bal.toFixed(4)} TON</b>\n\n` +
        `${'─'.repeat(28)}\n` +
        `${modeIcon} الوضع: <b>${PROCESSING_MODE.toUpperCase()}</b> | حجم الدفعة: <b>${BATCH_SIZE}</b>\n` +
        `📈 Max: <b>${MAX_WITHDRAWAL_AMOUNT}</b> | Min: <b>${MIN_WITHDRAWAL_AMOUNT}</b> TON\n` +
        `📅 الحد اليومي: <b>${DAILY_LIMIT}</b> سحوبات | Cooldown: <b>${DAILY_COOLDOWN_HOURS}h</b>\n` +
        `💱 Rate: <b>1 TON = ${BAMBOO_TO_TON_RATE} Bamboo</b>\n` +
        `⏸ Paused: <b>${systemPaused ? 'نعم' : 'لا'}</b>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /setmax ──────────────────────────────────────────
  bot.onText(/\/setmax (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    MAX_WITHDRAWAL_AMOUNT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد الأقصى: <b>${v} TON</b>\n🔄 جاري إعادة معالجة الطلبات المعلقة...`);
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /setmin ──────────────────────────────────────────
  bot.onText(/\/setmin (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    MIN_WITHDRAWAL_AMOUNT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد الأدنى: <b>${v} TON</b>\n🔄 جاري إعادة معالجة الطلبات المعلقة...`);
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /setrate ─────────────────────────────────────────
  bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    BAMBOO_TO_TON_RATE = v;
    await adminReply(bot, msg.chat.id, `✅ السعر: <b>1 TON = ${v} Bamboo</b>`);
  });

  // ─── /setdaily ────────────────────────────────────────
  bot.onText(/\/setdaily (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v < 1) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح (1 على الأقل)"); return; }
    DAILY_LIMIT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد اليومي: <b>${v}</b> سحوبات لكل مستخدم`);
  });

  // ─── /setcooldown ─────────────────────────────────────
  bot.onText(/\/setcooldown (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    DAILY_COOLDOWN_HOURS = v;
    await adminReply(bot, msg.chat.id, `✅ مدة الانتظار: <b>${v}</b> ساعة بعد تجاوز الحد اليومي`);
  });

  // ─── /setmode ─────────────────────────────────────────
  bot.onText(/\/setmode (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const m = match[1].trim().toLowerCase();
    if (m !== 'batch' && m !== 'single') { await adminReply(bot, msg.chat.id, "❌ الوضع يجب أن يكون: <b>batch</b> أو <b>single</b>"); return; }
    PROCESSING_MODE = m;
    const icon = m === 'batch' ? '📦' : '💸';
    await adminReply(bot, msg.chat.id, `${icon} تم التبديل إلى وضع <b>${m.toUpperCase()}</b>\n\n` + (m === 'batch' ? `يجمع حتى <b>${BATCH_SIZE}</b> سحوبات في معاملة واحدة` : `يرسل كل سحب منفرداً بتأخير <b>${SINGLE_DELAY_MS/1000}s</b>`));
  });

  // ─── /setbatchsize ────────────────────────────────────
  bot.onText(/\/setbatchsize (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v < 1 || v > 4) { await adminReply(bot, msg.chat.id, "❌ حجم الدفعة يجب أن يكون بين 1 و4"); return; }
    BATCH_SIZE = v;
    await adminReply(bot, msg.chat.id, `✅ حجم الدفعة: <b>${v}</b> سحوبات في المعاملة الواحدة`);
  });

  // ─── /setsingledelay ──────────────────────────────────
  bot.onText(/\/setsingledelay (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v < 1) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح (ثانية واحدة على الأقل)"); return; }
    SINGLE_DELAY_MS = v * 1000;
    await adminReply(bot, msg.chat.id, `✅ تأخير Single: <b>${v}</b> ثانية بين كل سحب`);
  });

  // ─── /clearqueue ──────────────────────────────────────
  bot.onText(/\/clearqueue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات pending"); return; }
      const count = Object.keys(items).length;
      const updates = {};
      Object.keys(items).forEach(id => { updates[`${id}/status`] = "cancelled"; updates[`${id}/updatedAt`] = Date.now(); updates[`${id}/holdReason`] = "إلغاء جماعي من الأدمن"; });
      await db.ref("withdrawQueue").update(updates);
      await adminReply(bot, msg.chat.id, `🗑 تم إلغاء <b>${count}</b> سحب من القائمة`);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /retryall ────────────────────────────────────────
  bot.onText(/\/retryall/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("failed").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات failed"); return; }
      const count = Object.keys(items).length;
      const updates = {};
      Object.keys(items).forEach(id => { updates[`${id}/status`] = "pending"; updates[`${id}/updatedAt`] = Date.now(); updates[`${id}/lastError`] = null; updates[`${id}/attempts`] = 0; });
      await db.ref("withdrawQueue").update(updates);
      await adminReply(bot, msg.chat.id, `🔄 تمت إعادة <b>${count}</b> سحب فاشل للمعالجة`);
      setTimeout(() => processPendingWithdrawals(), 1000);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /banuser ─────────────────────────────────────────
  bot.onText(/\/banuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    await db.ref(`bannedUsers/${userId}`).set({ bannedAt: Date.now(), by: 'admin' });
    await adminReply(bot, msg.chat.id, `🚫 تم حظر المستخدم <code>${userId}</code>`);
  });

  // ─── /unbanuser ───────────────────────────────────────
  bot.onText(/\/unbanuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    await db.ref(`bannedUsers/${userId}`).remove();
    await adminReply(bot, msg.chat.id, `✅ تم رفع حظر المستخدم <code>${userId}</code>`);
  });

  // ─── /banwallet ───────────────────────────────────────
  bot.onText(/\/banwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    const key  = addr.replace(/[.$#[\]/]/g, '_');
    await db.ref(`bannedWallets/${key}`).set({ address: addr, bannedAt: Date.now(), reason: 'يدوي من الأدمن' });
    await adminReply(bot, msg.chat.id, `🚫 تم حظر المحفظة:\n<code>${addr}</code>`);
  });

  // ─── /unwallet ────────────────────────────────────────
  bot.onText(/\/unwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    const key  = addr.replace(/[.$#[\]/]/g, '_');
    await db.ref(`bannedWallets/${key}`).remove();
    await adminReply(bot, msg.chat.id, `✅ تم رفع حظر المحفظة:\n<code>${addr}</code>`);
  });

  // ─── /userinfo ────────────────────────────────────────
  bot.onText(/\/userinfo (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    try {
      const [bannedSnap, wdSnap, depositsSnap, referralsSnap, userSnap] = await Promise.all([
        db.ref(`bannedUsers/${userId}`).once("value"),
        db.ref("withdrawQueue").orderByChild("userId").equalTo(userId).once("value"),
        db.ref(`users/${userId}/deposits`).once("value"),
        db.ref(`users/${userId}/referrals`).once("value"),
        db.ref(`users/${userId}`).once("value"),
      ]);

      const isBanned  = bannedSnap.exists();
      const wdItems   = wdSnap.val() || {};
      const allWds    = Object.values(wdItems);
      const paid      = allWds.filter(d => d.status === 'paid');
      const pending   = allWds.filter(d => ['pending','awaiting_approval','awaiting_manual','processing'].includes(d.status));
      const cancelled = allWds.filter(d => d.status === 'cancelled');
      const totalPaid = paid.reduce((s, d) => s + roundAmount(d.ton), 0);
      const wallets   = [...new Set(allWds.map(d => d.address).filter(Boolean))];

      // إحصائيات الإيداعات
      const depositsData = depositsSnap.val() || {};
      const depositsList = Object.entries(depositsData);
      const confirmedDeposits = depositsList.filter(([, d]) => !d.status || d.status !== 'pending');
      const totalDepositTon   = confirmedDeposits.reduce((s, [, d]) => s + (Number(d.amount) || 0), 0);
      const totalDepositCount = confirmedDeposits.length;

      // إحصائيات الإحالات
      const referralsData    = referralsSnap.val() || {};
      const totalReferrals   = Object.keys(referralsData).length;

      let activeReferrals = 0;
      const referralIds = Object.keys(referralsData);
      for (const referralId of referralIds) {
        try {
          const depSnap = await db.ref(`users/${referralId}/hasDeposited`).once("value");
          if (depSnap.val() === true) activeReferrals++;
        } catch (e) { /* تجاهل الأخطاء الفردية */ }
      }

      // رصيد الكوينز والبامبو والتون
      const userData   = userSnap.val() || {};
      const bambooBalance = userData.bamboo || 0;
      const coinsBalance  = userData.coins  || 0;
      const tonBalance    = userData.tonBalance || 0;

      // إجمالي السحوبات لمقارنة مع الإيداعات
      const totalWithdrawTon = paid.reduce((s, d) => s + roundAmount(d.ton), 0);

      // روابط الإيداعات
      let depositsText = '';
      if (confirmedDeposits.length > 0) {
        const lastDeposits = confirmedDeposits.slice(-5);
        depositsText = `\n🔗 <b>آخر الإيداعات (روابط المعاملات):</b>\n`;
        lastDeposits.forEach(([, d], idx) => {
          const amt  = Number(d.amount || 0).toFixed(3);
          const date = d.date ? new Date(d.date).toLocaleDateString('en-GB') : (d.timestamp ? new Date(d.timestamp).toLocaleDateString('en-GB') : '—');
          if (d.txLink) {
            depositsText += `${idx + 1}. 💎 ${amt} TON — ${date} — <a href="${d.txLink}">🔍 عرض</a>\n`;
          } else if (d.txHash) {
            const cleanHash = encodeURIComponent(d.txHash);
            depositsText += `${idx + 1}. 💎 ${amt} TON — ${date} — <a href="https://tonscan.org/tx/${cleanHash}">🔍 عرض</a>\n`;
          } else {
            depositsText += `${idx + 1}. 💎 ${amt} TON — ${date}\n`;
          }
        });
        if (confirmedDeposits.length > 5) depositsText += `... و${confirmedDeposits.length - 5} إيداع أقدم\n`;
      } else {
        depositsText = `\n⚠️ لا توجد إيداعات مؤكدة\n`;
      }

      // تحذير إذا السحوبات > الإيداعات
      const suspiciousWithdraw = totalDepositTon > 0 && totalWithdrawTon > totalDepositTon;
      const noDepositWarning   = totalDepositTon === 0 && totalPaid > 0;

      let text =
        `👤 <b>معلومات المستخدم</b>\n` +
        `🆔 ID: <code>${userId}</code>\n` +
        `🚫 محظور: <b>${isBanned ? 'نعم ❌' : 'لا ✅'}</b>\n` +
        `${'━'.repeat(30)}\n\n` +

        `💰 <b>الرصيد الحالي</b>\n` +
        `🎍 Bamboo: <b>${Number(bambooBalance).toLocaleString()}</b>\n` +
        `🪙 Coins: <b>${Number(coinsBalance).toLocaleString()}</b>\n` +
        `💎 TON: <b>${Number(tonBalance).toFixed(6)} TON</b>\n` +
        `${'━'.repeat(30)}\n\n` +

        `📥 <b>الإيداعات</b>\n` +
        `💎 إجمالي الإيداعات: <b>${totalDepositTon.toFixed(3)} TON</b>\n` +
        `🔢 عدد المعاملات: <b>${totalDepositCount}</b>\n` +
        depositsText +
        `${'━'.repeat(30)}\n\n` +

        `📤 <b>السحوبات</b>\n` +
        `✅ مدفوعة: <b>${paid.length}</b> (<b>${totalPaid.toFixed(3)} TON</b>)\n` +
        `⏳ معلقة: <b>${pending.length}</b>\n` +
        `🚫 ملغاة: <b>${cancelled.length}</b>\n` +
        (suspiciousWithdraw ? `\n⚠️ <b>تحذير: إجمالي السحوبات (${totalWithdrawTon.toFixed(3)} TON) يتجاوز إجمالي الإيداعات (${totalDepositTon.toFixed(3)} TON)!</b>\n` : '') +
        (noDepositWarning   ? `\n⚠️ <b>تحذير: هذا المستخدم لم يودع ولكنه سحب!</b>\n` : '') +
        `${'━'.repeat(30)}\n\n` +

        `👥 <b>الإحالات</b>\n` +
        `📊 إجمالي الإحالات: <b>${totalReferrals}</b>\n` +
        `✅ إحالات نشطة (أودعوا): <b>${activeReferrals}</b>\n` +
        `${'━'.repeat(30)}\n\n` +

        `📬 <b>المحافظ المستخدمة (${wallets.length})</b>\n`;

      wallets.slice(0, 5).forEach(w => { text += `• <code>${w}</code>\n`; });
      if (wallets.length > 5) text += `... و${wallets.length - 5} أخرى\n`;

      const keyboard = [];
      if (!isBanned) keyboard.push([{ text: "🚫 حظر المستخدم", callback_data: `ban_user:${userId}` }]);
      else           keyboard.push([{ text: "✅ رفع الحظر",     callback_data: `unban_user:${userId}` }]);

      await adminReply(bot, msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: false });
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /addcoins [userId] [amount] ─────────────────────
  bot.onText(/\/addcoins (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts  = match[1].trim().split(/\s+/);
    const userId = parts[0];
    const amount = parseInt(parts[1]);
    if (!userId || isNaN(amount) || amount <= 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /addcoins [userId] [المبلغ]\nمثال: /addcoins 123456789 5000`);
      return;
    }
    try {
      const userSnap    = await db.ref(`users/${userId}`).once("value");
      if (!userSnap.exists()) { await adminReply(bot, msg.chat.id, `❌ المستخدم <code>${userId}</code> غير موجود`); return; }
      const userData    = userSnap.val() || {};
      const currentCoins = Number(userData.coins || 0);
      const newCoins     = currentCoins + amount;
      await db.ref(`users/${userId}`).update({ coins: newCoins, updatedAt: Date.now() });
      await adminReply(bot, msg.chat.id,
        `✅ <b>تمت إضافة Coins بنجاح</b>\n\n` +
        `👤 User: <code>${userId}</code>\n` +
        `➕ مضاف: <b>${amount.toLocaleString()} Coins</b>\n` +
        `📊 الرصيد القديم: <b>${currentCoins.toLocaleString()}</b>\n` +
        `💰 الرصيد الجديد: <b>${newCoins.toLocaleString()} Coins</b>`
      );
      console.log(`✅ Admin added ${amount} coins → user ${userId} (${currentCoins} → ${newCoins})`);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /addbamboo [userId] [amount] ────────────────────
  bot.onText(/\/addbamboo (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts  = match[1].trim().split(/\s+/);
    const userId = parts[0];
    const amount = parseInt(parts[1]);
    if (!userId || isNaN(amount) || amount <= 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /addbamboo [userId] [المبلغ]\nمثال: /addbamboo 123456789 50000`);
      return;
    }
    try {
      const userSnap      = await db.ref(`users/${userId}`).once("value");
      if (!userSnap.exists()) { await adminReply(bot, msg.chat.id, `❌ المستخدم <code>${userId}</code> غير موجود`); return; }
      const userData      = userSnap.val() || {};
      const currentBamboo = Number(userData.bamboo || 0);
      const newBamboo     = currentBamboo + amount;
      await db.ref(`users/${userId}`).update({ bamboo: newBamboo, updatedAt: Date.now() });
      await adminReply(bot, msg.chat.id,
        `✅ <b>تمت إضافة Bamboo بنجاح</b>\n\n` +
        `👤 User: <code>${userId}</code>\n` +
        `➕ مضاف: <b>${amount.toLocaleString()} 🎍 Bamboo</b>\n` +
        `📊 الرصيد القديم: <b>${currentBamboo.toLocaleString()}</b>\n` +
        `🎍 الرصيد الجديد: <b>${newBamboo.toLocaleString()} Bamboo</b>`
      );
      console.log(`✅ Admin added ${amount} bamboo → user ${userId} (${currentBamboo} → ${newBamboo})`);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /addton [userId] [amount] ───────────────────────
  bot.onText(/\/addton (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const parts  = match[1].trim().split(/\s+/);
    const userId = parts[0];
    const amount = parseFloat(parts[1]);
    if (!userId || isNaN(amount) || amount <= 0) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /addton [userId] [المبلغ]\nمثال: /addton 123456789 10.5`);
      return;
    }
    try {
      const userSnap    = await db.ref(`users/${userId}`).once("value");
      if (!userSnap.exists()) { await adminReply(bot, msg.chat.id, `❌ المستخدم <code>${userId}</code> غير موجود`); return; }
      const userData    = userSnap.val() || {};
      const currentTon = Number(userData.tonBalance || 0);
      const newTon     = currentTon + amount;
      await db.ref(`users/${userId}`).update({ tonBalance: newTon, updatedAt: Date.now() });
      await adminReply(bot, msg.chat.id,
        `✅ <b>تمت إضافة TON بنجاح</b>\n\n` +
        `👤 User: <code>${userId}</code>\n` +
        `➕ مضاف: <b>${amount.toFixed(6)} TON</b>\n` +
        `📊 الرصيد القديم: <b>${currentTon.toFixed(6)} TON</b>\n` +
        `💰 الرصيد الجديد: <b>${newTon.toFixed(6)} TON</b>`
      );
      console.log(`✅ Admin added ${amount} TON → user ${userId} (${currentTon} → ${newTon})`);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });


  // ─── /pending_wd — مراجعة السحوبات التي تتجاوز الحد الأقصى ─────────────────
  // حالة المراجعة اليدوية (session state)
  const manualReviewState = {};   // { [adminChatId]: { list: [], index: 0, mode: 'one_by_one'|'all' } }

  async function buildManualWdMessage(wd, wdId) {
    const roundedAmount = roundAmount(wd.ton ?? wd.amt);
    const userId  = wd.userId || 'unknown';
    const address = wd.address || '—';
    const requestTime = new Date(wd.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

    // إجمالي الإيداعات
    let totalDepositTon = 0;
    try {
      const depSnap = await db.ref(`users/${userId}/deposits`).once('value');
      const deps = depSnap.val() || {};
      totalDepositTon = Object.values(deps).reduce((s, d) => s + (Number(d.amount || d.tonAdded || 0)), 0);
    } catch(e) {}

    // إجمالي السحوبات المدفوعة
    let totalPaidTon = 0;
    try {
      const wdSnap = await db.ref(`users/${userId}/wdHistory`).once('value');
      const wds = wdSnap.val() || {};
      totalPaidTon = Object.values(wds).filter(w => w.status === 'paid').reduce((s, w) => s + (Number(w.sentAmount || 0)), 0);
    } catch(e) {}

    // الإحالات النشطة
    let activeReferrals = 0;
    try {
      const refSnap = await db.ref(`users/${userId}/referrals`).once('value');
      if (refSnap.exists()) activeReferrals = Object.keys(refSnap.val() || {}).length;
    } catch(e) {}

    // عدد السحوبات الناجحة
    let paidCount = 0;
    try {
      const wdSnap2 = await db.ref(`users/${userId}/wdHistory`).once('value');
      const wds2 = wdSnap2.val() || {};
      paidCount = Object.values(wds2).filter(w => w.status === 'paid').length;
    } catch(e) {}

    const text =
      `🔍 <b>سحب يحتاج موافقة يدوية</b>
` +
      `${'━'.repeat(30)}

` +
      `👤 <b>المستخدم:</b> <code>${userId}</code>
` +
      `🆔 <b>ID السحب:</b> <code>${wdId}</code>

` +
      `${'─'.repeat(30)}
` +
      `💰 <b>المبلغ المطلوب:</b> <b>${roundedAmount.toFixed(4)} TON</b>
` +
      `📬 <b>المحفظة:</b>
<code>${address}</code>

` +
      `${'─'.repeat(30)}
` +
      `📥 <b>إجمالي الإيداعات:</b> ${totalDepositTon.toFixed(4)} TON
` +
      `📤 <b>إجمالي السحوبات المدفوعة:</b> ${totalPaidTon.toFixed(4)} TON
` +
      `✅ <b>عدد السحوبات الناجحة:</b> ${paidCount}
` +
      `👥 <b>الإحالات النشطة:</b> ${activeReferrals}

` +
      `${'─'.repeat(30)}
` +
      `🕐 <b>الوقت:</b> ${requestTime} UTC
` +
      `${'━'.repeat(30)}`;

    return text;
  }

  bot.onText(/\/pending_wd/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const chatId = msg.chat.id.toString();
    try {
      const snap  = await db.ref('withdrawQueue').orderByChild('status').equalTo('awaiting_manual').once('value');
      const items = snap.val();
      if (!items) { await adminReply(bot, chatId, '📭 لا توجد سحوبات تحتاج مراجعة يدوية حالياً'); return; }

      const list = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      const totalTON = list.reduce((s, w) => s + roundAmount(w.ton ?? w.amt), 0);

      await bot.sendMessage(chatId,
        `📋 <b>السحوبات التي تحتاج موافقة يدوية</b>

` +
        `📊 العدد: <b>${list.length}</b> طلب
` +
        `💰 الإجمالي: <b>${totalTON.toFixed(4)} TON</b>

` +
        `اختر طريقة المراجعة:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: `📩 طلب طلب (${list.length})`, callback_data: 'manual_wd_one_by_one' },
              { text: `📋 عرض الكل`,                  callback_data: 'manual_wd_list_all'   },
            ]]
          }
        }
      );

      manualReviewState[chatId] = { list, index: 0 };
    } catch(e) { await adminReply(bot, chatId, `❌ ${e.message}`); }
  });

  // ─── /logs [userId] [count|all] — السجل المالي الكامل للمستخدم ────────────
  bot.onText(/\/logs(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const raw = (match && match[1] ? match[1] : '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    const userId = parts[0];
    const limit = parseLogLimitArg(parts[1]);

    if (!userId) {
      await adminReply(bot, msg.chat.id,
        `❌ الاستخدام:\n` +
        `<code>/logs [userId]</code> لاختيار العدد\n` +
        `<code>/logs [userId] 100</code> لعرض آخر 100 نشاط\n` +
        `<code>/logs [userId] all</code> لعرض جميع النشاطات`
      );
      return;
    }

    try {
      if (!limit) {
        await showLogLimitChooser(bot, msg.chat.id, userId);
        return;
      }
      await sendUserLogs(bot, msg.chat.id, userId, limit);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });


    // ─── /check_nodeposit ─────────────────────────────────
  bot.onText(/\/check_nodeposit/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري فحص جميع السحوبات المدفوعة...");
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("paid").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات مدفوعة"); return; }

      const userMap = {};
      Object.values(items).forEach(d => {
        if (!d.userId) return;
        if (!userMap[d.userId]) userMap[d.userId] = { totalPaid: 0, count: 0 };
        userMap[d.userId].totalPaid += roundAmount(d.ton);
        userMap[d.userId].count++;
      });

      await adminReply(bot, msg.chat.id, `👥 ${Object.keys(userMap).length} مستخدم فريد — جاري فحص الإيداعات...`);

      const noDepositUsers = [];
      for (const [userId, info] of Object.entries(userMap)) {
        try {
          const [flagSnap, depositsSnap] = await Promise.all([
            db.ref(`users/${userId}/hasDeposited`).once("value"),
            db.ref(`users/${userId}/deposits`).once("value"),
          ]);
          const flagTrue   = flagSnap.val() === true;
          const depositsData = depositsSnap.val() || {};
          const confirmed  = Object.values(depositsData).filter(d => !d.status || d.status !== 'pending');
          const hasDeposit = flagTrue || confirmed.length > 0;
          if (!hasDeposit) noDepositUsers.push({ userId, ...info });
        } catch (e) { /* تجاهل الأخطاء الفردية */ }
      }

      if (!noDepositUsers.length) {
        await adminReply(bot, msg.chat.id, "✅ <b>لا يوجد مستخدمون سحبوا بدون إيداع</b>");
        return;
      }

      noDepositUsers.sort((a, b) => b.totalPaid - a.totalPaid);
      let text = `🚨 <b>مستخدمون سحبوا بدون إيداع (${noDepositUsers.length})</b>\n${'━'.repeat(30)}\n\n`;
      const CHUNK = 20;
      for (let i = 0; i < noDepositUsers.length; i += CHUNK) {
        const chunk = noDepositUsers.slice(i, i + CHUNK);
        text = i === 0
          ? `🚨 <b>مستخدمون سحبوا بدون إيداع (${noDepositUsers.length})</b>\n${'━'.repeat(30)}\n\n`
          : `🚨 <b>تابع... (${i + 1}–${Math.min(i + CHUNK, noDepositUsers.length)})</b>\n\n`;
        chunk.forEach((u, idx) => {
          text += `${i + idx + 1}. 👤 <code>${u.userId}</code> — <b>${u.totalPaid.toFixed(3)} TON</b> (${u.count} سحب)\n`;
        });
        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < noDepositUsers.length) await new Promise(r => setTimeout(r, 400));
      }
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  bot.onText(/\/lastpaid/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("paid").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات مدفوعة بعد"); return; }

      const paid = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .filter(d => d.completedAt || d.updatedAt)
        .sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0))
        .slice(0, 5);

      let text = `💸 <b>آخر 5 معاملات مدفوعة</b>\n${'━'.repeat(30)}\n\n`;
      paid.forEach((w, idx) => {
        const ton    = roundAmount(w.ton ?? w.amt);
        const time   = new Date(w.completedAt || w.updatedAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
        const txLink = w.txHash ? `https://tonscan.org/tx/${encodeURIComponent(w.txHash)}` : null;
        text +=
          `${idx + 1}. 👤 <code>${w.userId || '?'}</code>\n` +
          `   💰 <b>${ton} TON</b>\n` +
          `   🆔 <code>${w.id}</code>\n` +
          `   📬 <code>${(w.address || '—').substring(0, 20)}...</code>\n` +
          `   🕐 ${time} UTC\n` +
          (txLink ? `   🔗 <a href="${txLink}">View TX</a>\n` : ``) +
          `\n`;
      });

      await adminReply(bot, msg.chat.id, text, { disable_web_page_preview: true });
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = true;
    await adminReply(bot, msg.chat.id, "⏸ System paused");
  });

  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = false;
    await adminReply(bot, msg.chat.id, "▶️ System resumed");
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /process ─────────────────────────────────────────
  bot.onText(/\/process/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await adminReply(bot, msg.chat.id, "🔄 Starting batch processing...");
    setTimeout(() => processPendingWithdrawals(), 500);
  });

  // ─── /check_suspicious ────────────────────────────────
  bot.onText(/\/check_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري فحص السحوبات المعلقة بحثاً عن التلاعب...");
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات في القائمة"); return; }
      const walletUsers = {};
      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'awaiting_manual', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;
        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), withdrawIds: [], totalTon: 0 };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].withdrawIds.push(id);
        walletUsers[addr].totalTon += roundAmount(d.ton);
      });
      const suspicious = Object.entries(walletUsers).filter(([, v]) => v.userIds.size > 3).sort((a, b) => b[1].userIds.size - a[1].userIds.size);
      if (!suspicious.length) { await adminReply(bot, msg.chat.id, `✅ <b>لم يتم اكتشاف أي نشاط مشبوه</b>`); return; }
      let text = `🚨 <b>محافظ مشبوهة — تعدد حسابات</b>\naكتُشفت <b>${suspicious.length}</b> محفظة\n${'━'.repeat(32)}\n\n`;
      for (let i = 0; i < suspicious.length; i++) {
        const [addr, data] = suspicious[i];
        const userList = [...data.userIds].join(', ');
        text += `🔴 <b>محفظة ${i + 1}</b>\n📬 <code>${addr}</code>\n👥 عدد المستخدمين: <b>${data.userIds.size}</b>\n🆔 المستخدمون: <code>${userList}</code>\n📋 طلبات معلقة: <b>${data.withdrawIds.length}</b>\n💰 إجمالي مطلوب: <b>${data.totalTon.toFixed(3)} TON</b>\n\n`;
        if (text.length > 3000 && i < suspicious.length - 1) {
          await adminReply(bot, msg.chat.id, text, { reply_markup: { inline_keyboard: [[{ text: "🚫 رفض جميع المشبوهين", callback_data: "reject_all_suspicious" }]] } });
          text = `🚨 <b>تابع — محافظ مشبوهة</b>\n\n`;
        }
      }
      text += `${'━'.repeat(32)}\n⚡ استخدم /reject_suspicious لرفض جميع طلباتهم`;
      await adminReply(bot, msg.chat.id, text, { reply_markup: { inline_keyboard: [[{ text: "🚫 رفض جميع المشبوهين الآن", callback_data: "reject_all_suspicious" }]] } });
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ خطأ: ${e.message}`); }
  });

  // ─── /reject_suspicious ───────────────────────────────
  bot.onText(/\/reject_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري تحليل البيانات وتنفيذ الرفض...");
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات"); return; }
      const walletUsers = {};
      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'awaiting_manual', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;
        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), entries: [] };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].entries.push({ id, ...d });
      });
      const suspiciousUserIds = new Set();
      const suspiciousWallets = new Set();
      Object.entries(walletUsers).forEach(([addr, v]) => {
        if (v.userIds.size > 3) { suspiciousWallets.add(addr); v.userIds.forEach(uid => suspiciousUserIds.add(uid)); }
      });
      if (!suspiciousUserIds.size) { await adminReply(bot, msg.chat.id, "✅ لا يوجد مستخدمون مشبوهون للرفض"); return; }
      let rejectedCount = 0;
      const rejectPromises = [];
      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'awaiting_manual', 'processing'].includes(status)) return;
        if (!suspiciousUserIds.has(String(d.userId))) return;
        rejectPromises.push(
          db.ref(`withdrawQueue/${id}`).update({ status: "cancelled", updatedAt: Date.now(), holdReason: `مرفوض تلقائياً — تعدد حسابات` }).then(async () => {
            if (d.userId && d.wdId) await db.ref(`users/${d.userId}/wdHistory/${d.wdId}`).update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
            rejectedCount++;
          }).catch(() => {})
        );
      });
      await Promise.all(rejectPromises);
      const banPromises = [];
      suspiciousWallets.forEach(addr => {
        const key = addr.replace(/[.$#[\]/]/g, '_');
        banPromises.push(db.ref(`bannedWallets/${key}`).set({ address: addr, reason: "تعدد حسابات — كشف تلقائي", bannedAt: Date.now(), userCount: walletUsers[addr]?.userIds.size || 0 }).catch(() => {}));
      });
      await Promise.all(banPromises);
      await adminReply(bot, msg.chat.id,
        `✅ <b>تم تنفيذ الرفض الجماعي</b>\n\n${'━'.repeat(30)}\n🚫 طلبات مرفوضة: <b>${rejectedCount}</b>\n👥 مستخدمون متأثرون: <b>${suspiciousUserIds.size}</b>\n📬 محافظ محظورة: <b>${suspiciousWallets.size}</b>\n${'━'.repeat(30)}\n\n🆔 المستخدمون: <code>${[...suspiciousUserIds].join(', ')}</code>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ خطأ: ${e.message}`); }
  });

  // ─── /awaiting_queue ──────────────────────────────────
  bot.onText(/\/awaiting_queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات معلقة بالحد اليومي حالياً"); return; }

      const list = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      const totalTON = list.reduce((s, w) => s + roundAmount(w.ton), 0);
      const CHUNK = 15;

      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        let text = i === 0
          ? `⏳ <b>السحوبات المعلقة — الحد اليومي</b>\n📊 الإجمالي: <b>${list.length}</b> طلب | <b>${totalTON.toFixed(4)} TON</b>\n${'━'.repeat(30)}\n\n`
          : `⏳ <b>تابع... (${i + 1}–${Math.min(i + CHUNK, list.length)})</b>\n\n`;

        chunk.forEach((w, idx) => {
          const ton      = roundAmount(w.ton);
          const time     = w.ts ? new Date(w.ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          const unlockAt = w.unlockAt ? new Date(w.unlockAt).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          text +=
            `${i + idx + 1}. 👤 <code>${w.userId || '?'}</code>\n` +
            `   🆔 <code>${w.id}</code>\n` +
            `   💰 ${ton} TON | 🪙 ${Number(w.amt || 0).toLocaleString()}\n` +
            `   🕐 طلب: ${time} UTC\n` +
            `   🔓 فتح تلقائي: ${unlockAt} UTC\n\n`;
        });

        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < list.length) await new Promise(r => setTimeout(r, 400));
      }
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /unlock [عدد] ────────────────────────────────────
  bot.onText(/\/unlock(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات بانتظار الموافقة اليومية"); return; }

      const list = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      const requestedCount = match && match[1] ? parseInt(match[1]) : list.length;
      const toUnlock = list.slice(0, requestedCount);

      let unlocked = 0;
      const now = Date.now();
      for (const w of toUnlock) {
        await db.ref(`withdrawQueue/${w.id}`).update({
          status:    "pending",
          updatedAt: now,
          holdReason: null,
          unlockAt:  null,
          lastError: null,
          approvedByAdmin: true,
        }).catch(() => {});
        unlocked++;
        console.log(`🔓 Admin unlocked: ${w.id}`);
      }

      await adminReply(bot, msg.chat.id,
        `🔓 <b>تم تحرير ${unlocked} سحب</b> للمعالجة\n\n` +
        `${list.length - unlocked > 0 ? `⏳ متبقي في الانتظار: <b>${list.length - unlocked}</b>` : `✅ تم تحرير جميع السحوبات المعلقة`}\n\n` +
        `🔄 جاري بدء المعالجة...`
      );
      setTimeout(() => processPendingWithdrawals(), 1000);
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /pending_reasons ─────────────────────────────────
  bot.onText(/\/pending_reasons/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات"); return; }
      const held = Object.entries(items).map(([id, d]) => ({ id, ...d })).filter(w => ['pending', 'awaiting_approval', 'awaiting_manual', 'processing'].includes(w.status)).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (!held.length) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات معلقة حالياً"); return; }
      const CHUNK = 15;
      for (let i = 0; i < held.length; i += CHUNK) {
        const chunk = held.slice(i, i + CHUNK);
        let text = i === 0 ? `📋 <b>السحوبات المعلقة (${held.length})</b>\n\n` : `📋 <b>تابع... (${i + 1}–${Math.min(i + CHUNK, held.length)})</b>\n\n`;
        chunk.forEach((w, idx) => {
          const ton    = roundAmount(w.ton);
          const time   = w.ts ? new Date(w.ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          const status = w.status === 'awaiting_manual' ? '📝 موافقة يدوية' : (w.status === 'awaiting_approval' ? '⏳ بانتظار موافقة' : (w.status === 'processing' ? '🔄 processing' : '🔄 pending'));
          let reason = '—';
          if (w.holdReason) reason = w.holdReason;
          else if (w.lastError) reason = w.lastError;
          else if (w.error) reason = w.error;
          else if (w.status === 'awaiting_manual') reason = `يتجاوز الحد الأقصى للدفع التلقائي (${MAX_WITHDRAWAL_AMOUNT} TON)`;
          else if (w.status === 'awaiting_approval') reason = 'تجاوز الحد اليومي';
          else if (ton > MAX_WITHDRAWAL_AMOUNT) reason = `يتجاوز الحد الأقصى (${MAX_WITHDRAWAL_AMOUNT} TON)`;
          else if (ton < MIN_WITHDRAWAL_AMOUNT) reason = `أقل من الحد الأدنى (${MIN_WITHDRAWAL_AMOUNT} TON)`;
          text += `${i + idx + 1}. ${status}\n   🆔 <code>${w.id}</code>\n   👤 User: <code>${w.userId || '?'}</code>\n   💰 ${ton} TON | 🪙 ${Number(w.amt || 0).toLocaleString()}\n   ⚠️ السبب: ${reason}\n   🕐 ${time} UTC\n\n`;
        });
        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < held.length) await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /sendmsg [userId] ────────────────────────────────
  // ─── /broadcast ───────────────────────────────────────
  // حالات المحادثة
  const msgSessions = {};

  // حالة البث الجاري
  let broadcastState = null;

  function buildProgressBar(current, total, width) {
    if (total === 0) return '[' + '░'.repeat(width) + ']';
    const filled = Math.round((current / total) * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
  }

  function formatEta(seconds) {
    if (seconds < 60) return `${seconds}ث`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m}د ${s}ث`;
    const h = Math.floor(m / 60);
    return `${h}س ${m % 60}د`;
  }

  async function startMsgSession(bot, chatId, targetUserId, isBroadcast = false) {
    msgSessions[chatId] = { step: 'text', targetUserId, text: null, photo: null, buttons: [], isBroadcast };
    const header = isBroadcast
      ? `📢 <b>إرسال رسالة لجميع المستخدمين</b>`
      : `📩 <b>إرسال رسالة للمستخدم</b> <code>${targetUserId}</code>`;
    await adminReply(bot, chatId,
      `${header}\n\n` +
      `<b>الخطوة 1 — اكتب نص الرسالة:</b>\n` +
      `(يمكنك استخدام HTML مثل <code>&lt;b&gt;نص&lt;/b&gt;</code>)\n\n` +
      `اكتب /cancel للإلغاء`
    );
  }

  bot.onText(/\/sendmsg(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match && match[1] ? match[1].trim() : null;
    if (!userId) {
      await adminReply(bot, msg.chat.id, `❌ الاستخدام: /sendmsg [userId]\nمثال: /sendmsg 6970148965`);
      return;
    }
    await startMsgSession(bot, msg.chat.id, userId, false);
  });

  bot.onText(/\/broadcast/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await startMsgSession(bot, msg.chat.id, null, true);
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (!isAdmin(msg)) return;
    if (msgSessions[msg.chat.id]) {
      delete msgSessions[msg.chat.id];
      await adminReply(bot, msg.chat.id, `❌ تم إلغاء إرسال الرسالة`);
    }
  });

  bot.onText(/\/broadcast_status/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    if (!broadcastState) {
      await adminReply(bot, msg.chat.id, '📭 لا يوجد بث جاري حالياً');
      return;
    }
    const s        = broadcastState;
    const elapsed  = Math.floor((Date.now() - s.startedAt) / 1000);
    const done     = s.current;
    const remaining = s.total - done;
    const pct      = s.total > 0 ? ((done / s.total) * 100).toFixed(1) : 0;
    const bar      = buildProgressBar(done, s.total, 20);

    if (s.done) {
      const duration = Math.floor((s.doneAt - s.startedAt) / 1000);
      await adminReply(bot, msg.chat.id,
        `✅ <b>البث اكتمل</b>\n\n` +
        `${bar} ${pct}%\n\n` +
        `👥 الإجمالي: <b>${s.total}</b>\n` +
        `✅ وصل: <b>${s.sent}</b>\n` +
        `❌ فشل: <b>${s.failed}</b>\n` +
        `⏱ المدة: <b>${duration}s</b>`
      );
    } else {
      const speed    = elapsed > 0 ? (done / elapsed).toFixed(1) : '—';
      const etaSec   = speed > 0 ? Math.floor(remaining / speed) : null;
      const etaStr   = etaSec !== null ? formatEta(etaSec) : '—';
      await adminReply(bot, msg.chat.id,
        `📡 <b>بث جارٍ الآن</b>\n\n` +
        `${bar} ${pct}%\n\n` +
        `👥 الإجمالي: <b>${s.total}</b>\n` +
        `📤 وصل لحد: <b>${done}</b>\n` +
        `✅ نجح: <b>${s.sent}</b>\n` +
        `❌ فشل: <b>${s.failed}</b>\n` +
        `⏳ باقي: <b>${remaining}</b>\n` +
        `⚡ السرعة: <b>${speed}/ث</b>\n` +
        `🕐 وقت متبقي: <b>${etaStr}</b>\n` +
        `⏱ مضى: <b>${formatEta(elapsed)}</b>`
      );
    }
  });

  bot.onText(/\/broadcast_debug/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await adminReply(bot, msg.chat.id, '🔍 جاري فحص قاعدة البيانات...');
    try {
      const dbUrl  = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
      const token  = await admin.app().options.credential.getAccessToken();
      const res    = await fetch(`${dbUrl}/users.json?shallow=true&access_token=${token.access_token}`);
      const data   = await res.json();
      const count  = data ? Object.keys(data).length : 0;
      const sample = data ? Object.keys(data).slice(0, 5).join(', ') : '—';
      await adminReply(bot, msg.chat.id,
        `🔍 <b>تشخيص قاعدة البيانات</b>\n\n` +
        `📁 مسار: <code>/users</code>\n` +
        `👥 عدد المستخدمين: <b>${count}</b>\n` +
        `🔑 أمثلة على IDs:\n<code>${sample}</code>\n\n` +
        (count === 0
          ? `⚠️ <b>المسار فاضي!</b> تأكد إن المستخدمين متخزنين تحت <code>/users/{userId}</code>`
          : `✅ البيانات موجودة — البث هيشتغل صح`)
      );
    } catch (e) {
      await adminReply(bot, msg.chat.id, `❌ خطأ في الفحص: ${e.message}`);
    }
  });

  // معالج الرسائل لخطوات sendmsg / broadcast
  bot.on('message', async (msg) => {
    const chatId  = msg.chat.id.toString();
    if (!isAdminId(chatId)) return;
    const session = msgSessions[chatId];
    if (!session) return;
    const text = msg.text || '';

    if (session.step === 'text') {
      if (!text || text.startsWith('/')) return;
      session.text = text;
      session.step = 'photo';
      await adminReply(bot, msg.chat.id,
        `✅ تم حفظ النص.\n\n` +
        `<b>الخطوة 2 — أرسل رابط صورة (URL) أو اكتب:</b>\n<code>skip</code> بدون صورة`
      );
      return;
    }

    if (session.step === 'photo') {
      if (text.toLowerCase() === 'skip') {
        session.photo = null;
      } else {
        session.photo = text.trim();
      }
      session.step = 'buttons';
      await adminReply(bot, msg.chat.id,
        `✅ تم.\n\n` +
        `<b>الخطوة 3 — أضف أزرار (كل زر في سطر):</b>\n` +
        `الصيغة: <code>نص الزر | الرابط</code>\n` +
        `مثال:\n<code>🐼 افتح التطبيق | https://t.me/PandaBamboBot</code>\n\n` +
        `أو اكتب <code>skip</code> بدون أزرار`
      );
      return;
    }

    if (session.step === 'buttons') {
      if (text.toLowerCase() !== 'skip') {
        const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
        const buttons = [];
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 2) {
            const label = parts[0].trim();
            const url   = parts.slice(1).join('|').trim();
            if (label && url) buttons.push([{ text: label, url }]);
          }
        }
        session.buttons = buttons;
      } else {
        session.buttons = [];
      }
      session.step = 'preview';

      const targetLabel = session.isBroadcast
        ? `📢 <b>لجميع المستخدمين</b>`
        : `👤 <b>${session.targetUserId}</b>`;

      await adminReply(bot, msg.chat.id,
        `🔍 <b>معاينة الرسالة</b>\n` +
        `${'━'.repeat(30)}\n` +
        `📬 المستقبل: ${targetLabel}\n` +
        (session.photo ? `🖼 صورة: <a href="${session.photo}">رابط الصورة</a>\n` : `🖼 صورة: لا يوجد\n`) +
        `🔘 أزرار: ${session.buttons.length > 0 ? session.buttons.map(r => r.map(b => b.text).join(' | ')).join(' / ') : 'لا يوجد'}\n` +
        `${'━'.repeat(30)}\n\n` +
        `📝 <b>النص:</b>\n${session.text}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ إرسال الآن', callback_data: `do_send_msg:${chatId}` },
              { text: '❌ إلغاء',      callback_data: `cancel_send_msg:${chatId}` },
            ]]
          }
        }
      );
      return;
    }
  });

  // ─── Callbacks ────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    if (!isAdminId(query.message.chat.id)) return;
    if (query.data === 'reject_all_suspicious') {
      await bot.answerCallbackQuery(query.id, { text: "🔄 جاري تنفيذ الرفض..." });
      await bot.sendMessage(ADMIN_CHAT_ID, "/reject_suspicious");
    }
  });

  bot.on('callback_query', async (query) => {
    if (!isAdminId(query.message.chat.id)) return;
    const data   = query.data || '';
    const chatId = query.message.chat.id;

    if (data.startsWith('cancel_send_msg:')) {
      const sid = data.replace('cancel_send_msg:', '').trim();
      delete msgSessions[sid];
      await bot.answerCallbackQuery(query.id, { text: '❌ تم الإلغاء' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
      await adminReply(bot, chatId, '❌ تم إلغاء الإرسال');
      return;
    }

    if (data.startsWith('do_send_msg:')) {
      const sid     = data.replace('do_send_msg:', '').trim();
      const session = msgSessions[sid];
      if (!session) { await bot.answerCallbackQuery(query.id, { text: '❌ انتهت الجلسة' }); return; }
      delete msgSessions[sid];

      await bot.answerCallbackQuery(query.id, { text: '📤 جاري الإرسال...' });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});

      const { text: msgText, photo, buttons, isBroadcast, targetUserId } = session;
      const replyMarkup = buttons.length > 0 ? { inline_keyboard: buttons } : undefined;

      async function sendToUser(uid) {
        try {
          if (photo) {
            await bot.sendPhoto(uid, photo, { caption: msgText, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
          } else {
            await bot.sendMessage(uid, msgText, { parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
          }
          return true;
        } catch (e) { return false; }
      }

      if (!isBroadcast) {
        const ok = await sendToUser(targetUserId);
        await adminReply(bot, chatId,
          ok
            ? `✅ <b>تم إرسال الرسالة بنجاح</b> للمستخدم <code>${targetUserId}</code>`
            : `❌ <b>فشل الإرسال</b> للمستخدم <code>${targetUserId}</code> — تحقق من الـ chat ID`
        );
      } else {
        await adminReply(bot, chatId,
          '📢 <b>جاري إرسال الرسالة لجميع المستخدمين...</b>\n' +
          '💡 استخدم /broadcast_status لمتابعة التقدم في أي وقت'
        );
        try {
          let userIds = [];
          try {
            const dbUrl    = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
            const token    = await admin.app().options.credential.getAccessToken();
            const shallowRes = await fetch(`${dbUrl}/users.json?shallow=true&access_token=${token.access_token}`);
            const shallowData = await shallowRes.json();
            userIds = shallowData ? Object.keys(shallowData) : [];
          } catch (shallowErr) {
            console.log(`⚠️ shallow fetch failed, fallback: ${shallowErr.message}`);
            const usersSnap = await db.ref('users').once('value');
            const users     = usersSnap.val() || {};
            userIds         = Object.keys(users);
          }
          let sent = 0, failed = 0;

          broadcastState = { total: userIds.length, sent: 0, failed: 0, current: 0, startedAt: Date.now(), done: false, doneAt: null };

          for (let i = 0; i < userIds.length; i++) {
            const ok = await sendToUser(userIds[i]);
            if (ok) sent++; else failed++;
            broadcastState.current = i + 1;
            broadcastState.sent    = sent;
            broadcastState.failed  = failed;
            if ((i + 1) % 100 === 0) {
              const pct = ((( i + 1) / userIds.length) * 100).toFixed(1);
              const bar = buildProgressBar(i + 1, userIds.length, 15);
              await adminReply(bot, chatId,
                `📊 ${bar} ${pct}%\n` +
                `📤 <b>${i + 1}</b>/${userIds.length} — ✅ ${sent} | ❌ ${failed}`
              );
            }
            await new Promise(r => setTimeout(r, 50));
          }

          broadcastState.done   = true;
          broadcastState.doneAt = Date.now();
          const duration = Math.floor((broadcastState.doneAt - broadcastState.startedAt) / 1000);

          await adminReply(bot, chatId,
            `🎉 <b>انتهى البث</b>\n\n` +
            `${buildProgressBar(userIds.length, userIds.length, 15)} 100%\n\n` +
            `👥 الإجمالي: <b>${userIds.length}</b>\n` +
            `✅ وصل: <b>${sent}</b>\n` +
            `❌ فشل: <b>${failed}</b>\n` +
            `⏱ المدة: <b>${formatEta(duration)}</b>`
          );
        } catch (e) {
          if (broadcastState) { broadcastState.done = true; broadcastState.doneAt = Date.now(); }
          await adminReply(bot, chatId, `❌ خطأ في البث: ${e.message}`);
        }
      }
      return;
    }

    const msgId  = query.message.message_id;

    // ── مراجعة يدوية: اختيار طريقة العرض ─────────────────────────────────────
    if (data === 'manual_wd_one_by_one' || data === 'manual_wd_list_all') {
      const state = manualReviewState[chatId];
      if (!state || !state.list.length) {
        await bot.answerCallbackQuery(query.id, { text: '📭 انتهت القائمة أو انتهت الجلسة — أعد /pending_wd' });
        return;
      }

      if (data === 'manual_wd_list_all') {
        // عرض قائمة مختصرة بجميع الطلبات
        const totalTON = state.list.reduce((s, w) => s + roundAmount(w.ton ?? w.amt), 0);
        let text = `📋 <b>جميع السحوبات المعلقة (${state.list.length})</b>\n💰 الإجمالي: <b>${totalTON.toFixed(4)} TON</b>\n${'━'.repeat(28)}\n\n`;
        state.list.forEach((w, i) => {
          const amt = roundAmount(w.ton ?? w.amt);
          text += `${i + 1}. 👤 <code>${w.userId || '?'}</code> — <b>${amt.toFixed(4)} TON</b>\n    🆔 <code>${w.id}</code>\n`;
        });
        text += `\n${'━'.repeat(28)}\nاستخدم الزر أدناه لمراجعة واحدة واحدة`;
        await bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '📩 ابدأ المراجعة طلب طلب', callback_data: 'manual_wd_one_by_one' }]] }
        });
        state.index = 0;
        await bot.answerCallbackQuery(query.id);
        return;
      }

      // طلب طلب — إرسال أول/تالي طلب
      const wd = state.list[state.index];
      if (!wd) {
        await bot.answerCallbackQuery(query.id, { text: '✅ انتهت جميع الطلبات' });
        await bot.editMessageText('✅ <b>تمت مراجعة جميع الطلبات</b>', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        delete manualReviewState[chatId];
        return;
      }

      const wdText = await buildManualWdMessage(wd, wd.id);
      const remaining = state.list.length - state.index;
      const fullText = wdText + `\n\n📊 <b>المتبقي: ${remaining}/${state.list.length}</b>`;

      await bot.editMessageText(fullText, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ موافقة — ادفع الآن', callback_data: `manual_approve:${wd.id}` },
            { text: '❌ رفض',                callback_data: `manual_reject:${wd.id}`  },
            { text: '📋 Logs',               callback_data: `wd_logs:${wd.userId || ''}` },
          ]]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    // ── موافقة يدوية على سحب ────────────────────────────────────────────────
    if (data.startsWith('manual_approve:')) {
      const withdrawId = data.replace('manual_approve:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once('value');
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: '❌ السحب غير موجود!' }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({
          status: 'pending', approvedByAdmin: true, updatedAt: Date.now(), holdReason: null, unlockAt: null, lastError: null
        });
        // تقديم التالي في الجلسة
        const state = manualReviewState[chatId];
        if (state) state.index++;
        await bot.editMessageText(
          (query.message.text || '') + `\n\n✅ <b>تمت الموافقة — جاري الدفع...</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: '✅ تمت الموافقة — سيتم الدفع الآن' });
        setTimeout(() => processPendingWithdrawals(), 1000);

        // إرسال الطلب التالي تلقائياً لو في جلسة نشطة
        if (state && state.list[state.index]) {
          const next = state.list[state.index];
          const nextText = await buildManualWdMessage(next, next.id);
          const remaining = state.list.length - state.index;
          await bot.sendMessage(chatId,
            nextText + `\n\n📊 <b>المتبقي: ${remaining}/${state.list.length}</b>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ موافقة — ادفع الآن', callback_data: `manual_approve:${next.id}` },
                  { text: '❌ رفض',                callback_data: `manual_reject:${next.id}`  },
                  { text: '📋 Logs',               callback_data: `wd_logs:${next.userId || ''}` },
                ]]
              }
            }
          );
        } else if (state && !state.list[state.index]) {
          await bot.sendMessage(chatId, '✅ <b>تمت مراجعة جميع الطلبات</b>', { parse_mode: 'HTML' });
          delete manualReviewState[chatId];
        }
      } catch(e) { await bot.answerCallbackQuery(query.id, { text: `❌ ${e.message}` }); }
      return;
    }

    // ── رفض يدوي لسحب ───────────────────────────────────────────────────────
    if (data.startsWith('manual_reject:')) {
      const withdrawId = data.replace('manual_reject:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once('value');
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: '❌ السحب غير موجود!' }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({
          status: 'cancelled', updatedAt: Date.now(), holdReason: 'رُفض يدوياً من الأدمن'
        });
        if (wd.userId && wd.wdId) {
          await db.ref(`users/${wd.userId}/wdHistory/${wd.wdId}`).update({ status: 'cancelled', updatedAt: Date.now() }).catch(() => {});
        }
        const state = manualReviewState[chatId];
        if (state) state.index++;
        await bot.editMessageText(
          (query.message.text || '') + `\n\n❌ <b>تم الرفض والإلغاء</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: '❌ تم رفض السحب' });

        // إرسال الطلب التالي تلقائياً
        if (state && state.list[state.index]) {
          const next = state.list[state.index];
          const nextText = await buildManualWdMessage(next, next.id);
          const remaining = state.list.length - state.index;
          await bot.sendMessage(chatId,
            nextText + `\n\n📊 <b>المتبقي: ${remaining}/${state.list.length}</b>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ موافقة — ادفع الآن', callback_data: `manual_approve:${next.id}` },
                  { text: '❌ رفض',                callback_data: `manual_reject:${next.id}`  },
                  { text: '📋 Logs',               callback_data: `wd_logs:${next.userId || ''}` },
                ]]
              }
            }
          );
        } else if (state && !state.list[state.index]) {
          await bot.sendMessage(chatId, '✅ <b>تمت مراجعة جميع الطلبات</b>', { parse_mode: 'HTML' });
          delete manualReviewState[chatId];
        }
      } catch(e) { await bot.answerCallbackQuery(query.id, { text: `❌ ${e.message}` }); }
      return;
    }

    // ── اختيار عدد اللوج / Logs المستخدم من زر السحب ─────────────────────────
    if (data.startsWith('log_limit:')) {
      const parts = data.split(':');
      const userId = parts[1];
      const limit = parseLogLimitArg(parts[2]) || 30;
      await bot.answerCallbackQuery(query.id, { text: `📋 جاري جلب ${getLogLimitLabel(limit)}...` });
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
        await sendUserLogs(bot, chatId, userId, limit);
      } catch(e) { await adminReply(bot, chatId, `❌ ${e.message}`); }
      return;
    }

    if (data.startsWith('wd_logs:')) {
      const userId = data.replace('wd_logs:', '').trim();
      if (!userId) { await bot.answerCallbackQuery(query.id, { text: '❌ لا يوجد userId' }); return; }
      await bot.answerCallbackQuery(query.id, { text: '📋 اختر عدد النشاطات' });
      await showLogLimitChooser(bot, chatId, userId);
      return;
    }


        if (data.startsWith('ban_user:')) {
      const uid = data.replace('ban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).set({ bannedAt: Date.now(), by: 'admin' });
      await bot.answerCallbackQuery(query.id, { text: `🚫 تم حظر ${uid}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "✅ رفع الحظر", callback_data: `unban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('unban_user:')) {
      const uid = data.replace('unban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).remove();
      await bot.answerCallbackQuery(query.id, { text: `✅ تم رفع حظر ${uid}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "🚫 حظر المستخدم", callback_data: `ban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('reprocess_wd:')) {
      const withdrawId = data.replace('reprocess_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", updatedAt: Date.now(), lastError: null });
        await bot.editMessageText(query.message.text + `\n\n🔄 <b>تمت إعادة الإضافة للمعالجة</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        await bot.answerCallbackQuery(query.id, { text: "🔄 تمت إعادة الإضافة للقائمة" });
        setTimeout(() => processPendingWithdrawals(), 1000);
      } catch (e) { await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` }); }
    }

    if (data.startsWith('approve_wd:')) {
      const withdrawId = data.replace('approve_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        if (!['awaiting_approval', 'awaiting_manual'].includes(wd.status)) { await bot.answerCallbackQuery(query.id, { text: `⚠️ الحالة الحالية: ${wd.status}` }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", approvedByAdmin: true, updatedAt: Date.now(), holdReason: null, unlockAt: null, lastError: null });
        await bot.editMessageText(query.message.text + `\n\n✅ <b>تمت الموافقة</b> — جاري الدفع...`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        await bot.answerCallbackQuery(query.id, { text: "✅ تمت الموافقة — سيتم الدفع الآن" });
        setTimeout(() => processPendingWithdrawals(), 1000);
      } catch (e) { await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` }); }
    }

    if (data.startsWith('reject_wd:')) {
      const withdrawId = data.replace('reject_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        if (!['awaiting_approval', 'awaiting_manual'].includes(wd.status)) { await bot.answerCallbackQuery(query.id, { text: `⚠️ الحالة الحالية: ${wd.status}` }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", updatedAt: Date.now(), holdReason: "رُفض من الأدمن" });
        if (wd.userId && wd.wdId) await db.ref(`users/${wd.userId}/wdHistory/${wd.wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
        await bot.editMessageText(query.message.text + `\n\n❌ <b>تم الرفض والإلغاء</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        await bot.answerCallbackQuery(query.id, { text: "❌ تم رفض وإلغاء السحب" });
      } catch (e) { await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` }); }
    }
  });

  bot.on('polling_error', () => {});
  console.log("✅ Bot running with all admin commands + Batch system + Deposit checker");
}

// ==========================
// 🔹 استرداد السحوبات العالقة
// ==========================
setInterval(async () => {
  if (systemPaused) return;
  if (!WITHDRAWAL_ENABLED) return;
  try {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value");
    const items = snap.val();
    if (!items) return;
    const stuckThreshold = Date.now() - 5 * 60 * 1000;
    let recovered = 0;
    for (const [id, data] of Object.entries(items)) {
      if ((data.updatedAt || 0) < stuckThreshold) {
        await db.ref(`withdrawQueue/${id}`).update({ status: "pending", updatedAt: Date.now(), lastError: "Recovered from stuck processing state" });
        processingQueue.delete(id);
        console.log(`♻️ Recovered stuck withdrawal: ${id}`);
        recovered++;
      }
    }
    if (recovered > 0) { console.log(`♻️ Recovered ${recovered} stuck — triggering re-process`); setTimeout(() => processPendingWithdrawals(), 2000); }
  } catch (e) { console.log(`❌ stuckRecovery: ${e.message}`); }
}, 10 * 60 * 1000);

// ==========================
// 🔹 Flush Timer
// ==========================
setInterval(async () => {
  if (!systemPaused && !isProcessing && WITHDRAWAL_ENABLED) {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value").catch(() => null);
    if (snap && snap.exists()) { console.log(`⏰ Flush timer — running batch process`); processPendingWithdrawals(); }
  }
}, BATCH_FLUSH_SECONDS * 1000);

// ==========================
// 🔹 فحص الإيداعات كل 5 دقايق
// ==========================
setInterval(() => checkDeposits(), 5 * 60 * 1000);

// ==========================
// 🔹 Start
// ==========================
console.log("\n" + "=".repeat(50));
console.log("🐼 PANDA BAMBOO BOT — WITHDRAWAL + DEPOSIT");
console.log("=".repeat(50));
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TON_WALLET_ADDRESS: ${process.env.TON_WALLET_ADDRESS ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
console.log(`📦 Batch size: ${BATCH_SIZE} | Flush: ${BATCH_FLUSH_SECONDS}s | Between batches: ${BATCH_BETWEEN_DELAY / 1000}s`);

startWelcomeBot();

getWallet().then(async () => {
  const b = await getWalletBalance();
  console.log(`💰 Wallet balance: ${b.toFixed(4)} TON`);
  if (WITHDRAWAL_ENABLED) await processPendingWithdrawals();
  else console.log("⛔ Withdrawal system disabled — skipping initial process");
  await checkDeposits();
}).catch(err => { console.error("❌ Wallet error:", err.message); });

setInterval(async () => {
  if (!systemPaused && WITHDRAWAL_ENABLED) await processPendingWithdrawals();
}, 3 * 60 * 1000);

db.ref("withdrawQueue").on("child_added", async (snap) => {
  if (systemPaused) return;
  if (!WITHDRAWAL_ENABLED) return;
  const data = snap.val();
  if (data?.status === "pending" && !processingQueue.has(snap.key)) {
    console.log(`📢 New withdrawal: ${snap.key}`);
    setTimeout(() => processPendingWithdrawals(), 2000);
  }
});

db.ref(".info/connected").on("value", (snap) => { if (snap.val()) console.log("📡 Firebase connected"); });

console.log("💸 Running | 📬 @PandaBambooPayouts | 👤 Admin:", ADMIN_CHAT_ID);
console.log("=".repeat(50) + "\n");
