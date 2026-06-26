import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import cron from 'node-cron';

const { Pool } = pg;

// ============================================================
// SETUP
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Database connected'))
  .catch(err => console.error('❌ Database connection failed:', err.message));

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `
คุณคือ "ลุงโน้ต" ผู้ช่วยดูแลสุขภาพบน LINE สำหรับผู้สูงอายุไทย

กฎ:
- พูดอบอุ่น กระชับ ไม่เกิน 3 บรรทัดต่อการตอบ
- ลงท้ายด้วย "ครับ" เสมอ
- เมื่อเตือนยา ให้บอกชื่อยาและขนาดยาด้วย
- หากค่าใดผิดปกติ ให้แนะนำพบแพทย์ด้วยความห่วงใย แต่ห้ามบอกว่าเป็นโรคอะไร หรือวินิจฉัยอาการ
- รับข้อมูลทั้งภาษาไทยและตัวเลข เช่น "130/85" หรือ "กินยาแล้ว"
- เมื่อผู้ใช้ส่งรูปมา ให้อ่านค่าอย่างระมัดระวัง แล้วทวนให้ผู้ใช้ยืนยันก่อนเสมอ
- ถ้ารูปไม่ชัดหรืออ่านไม่ออก ให้ขอถ่ายใหม่ อย่าเดาค่าเอง
- ห้ามวินิจฉัยโรค ห้ามแนะนำยา ห้ามบอกสาเหตุของอาการ — หน้าที่ลุงคือบันทึกและแจ้งเตือนเท่านั้น
`;

// ============================================================
// TIME LABELS
// ============================================================

const TIME_LABELS = {
  '08:00': 'เช้า', '12:00': 'กลางวัน', '14:00': 'บ่าย',
  '18:00': 'เย็น', '21:00': 'ก่อนนอน', '22:00': 'กลางคืน',
};

// ============================================================
// INTENT CLASSIFIER — uses Haiku for onboarding state machine
// ============================================================

async function classifyIntent(text, context) {
  const prompts = {
    done_or_more:
      `User said: "${text}"\nAre they saying they are DONE (finished, no more, that's all, แค่นี้, พอแล้ว, เท่านี้, ok) or do they have MORE items?\nReply with exactly one word: DONE, MORE, or OTHER`,
    mode_choice:
      `User said: "${text}"\nAre they saying they want this app for THEMSELVES (self, solo, ตัวเอง) or for a FAMILY member (parent, spouse, พ่อแม่, คนอื่น)?\nReply with exactly one word: SELF, FAMILY, or UNCLEAR`,
    has_conditions:
      `User said: "${text}"\nAre they listing medical conditions or saying they have NONE (ไม่มี, ไม่เป็น, สบายดี)?\nReply with exactly one word: HAS_CONDITIONS, NO_CONDITIONS, or UNCLEAR`,
    has_meds:
      `User said: "${text}"\nAre they saying they HAVE medications (yes, มี, มียา) or NO medications (ไม่มี, ไม่ได้กิน)? Or do they want to use a PHOTO?\nReply with exactly one word: HAS_MEDS, NO_MEDS, PHOTO, or UNCLEAR`,
    correct_or_edit:
      `User said: "${text}"\nAre they saying the information is CORRECT (ถูก, ใช่, ok, โอเค, ถูกต้อง) or do they want to EDIT (ผิด, แก้, เปลี่ยน)?\nReply with exactly one word: CORRECT, EDIT, or UNCLEAR`,
  };

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: prompts[context] }],
    });
    return response.content.find(b => b.type === 'text')?.text?.trim().toUpperCase() || 'UNCLEAR';
  } catch (err) {
    console.error('Intent classification failed:', err.message);
    return 'UNCLEAR';
  }
}

// ============================================================
// MASTER INTENT ROUTER — runs on every post-onboarding message
// Single Haiku call replaces all keyword matching in handleTextMessage.
// Returns { intent, entities } where intent is one of:
//   med_taken | med_snooze | log_reading | add_med | update_med |
//   book_appointment | check_patient | check_med_list | check_history |
//   send_invite | other
// ============================================================

async function routeIntent(text, isGuardianUser) {
  const prompt = `You are a routing classifier for a Thai health assistant LINE bot called "ลุงโน้ต".
The user is ${isGuardianUser ? 'a GUARDIAN (adult child managing elderly parent)' : 'a PATIENT (elderly person)'}.

User message: "${text}"

Classify the intent and extract entities. Reply ONLY with valid JSON, no other text:

{
  "intent": "<one of the intents below>",
  "entities": {}
}

INTENTS and when to use them:
- "med_taken": User confirming they took medication. Examples: "กินแล้ว", "ทานยาแล้ว", "เพิ่งกินมา", "กินเรียบร้อย", "ok กินแล้ว", "👍", "✅", "done"
- "med_snooze": User acknowledging reminder but not yet taken. Examples: "เดี๋ยวกิน", "อีกครู่", "รอก่อน", "กำลังจะกิน"
- "log_reading": User reporting a health measurement. Extract: type (bp/glucose/spo2/temp/weight), values. Examples: "130/85", "น้ำตาล 7.2", "วัดความดันได้ 120/80", "อุณหภูมิ 37.5", "น้ำหนัก 65 กิโล"
- "add_med": User wants to add a new medication to their list. Examples: "เพิ่มยา", "มียาตัวใหม่", "ลืมบอกยา"
- "update_med": User wants to change existing medication schedule or dose. Examples: "เปลี่ยนเวลายา", "ลดโดส", "หยุดยา", "แก้ยา"
- "book_appointment": User wants to record a doctor/hospital appointment. Examples: "นัดหมอ", "นัดตรวจ", "วันศุกร์ต้องไปโรงพยาบาล", "จำนัด"
- "check_patient": GUARDIAN ONLY — wants to see patient health status/dashboard. Examples: "แม่เป็นยังไง", "ดูข้อมูลพ่อ", "รายงานวันนี้", "สุขภาพเป็นยังไง"
- "check_med_list": User wants to see their medication list. Examples: "รายการยา", "มียาอะไรบ้าง", "ดูยา", "ยาทั้งหมด"
- "check_history": User wants to see past health data. Examples: "ความดันเดือนนี้", "ประวัติน้ำตาล", "ค่าล่าสุด"
- "send_invite": GUARDIAN ONLY — wants to send invite link to patient. Examples: "เชิญ", "ส่งลิงก์", "เพิ่มพ่อ", "invite"
- "other": Anything else — general chat, questions, unclear messages

For "log_reading", extract entities like:
{"type":"bp","value_1":130,"value_2":85,"unit":"mmHg"}
{"type":"glucose","value_1":7.2,"unit":"mmol"}
{"type":"weight","value_1":65,"unit":"kg"}

For other intents, entities can be {} or relevant extracted info.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { intent: 'other', entities: {} };
    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`🧭 Intent: ${parsed.intent} | "${text.slice(0,40)}"`);
    return { intent: parsed.intent || 'other', entities: parsed.entities || {} };
  } catch (err) {
    console.error('Master intent router failed:', err.message);
    return { intent: 'other', entities: {} };
  }
}

// ============================================================
// MEDICATION PARSER
// ============================================================

const SHORTHAND_TIMES = {
  'วันละครั้ง':        ['08:00'],
  'วันละ1ครั้ง':       ['08:00'],
  'วันละ 1 ครั้ง':     ['08:00'],
  'เช้าเย็น':          ['08:00', '18:00'],
  'เช้ากลางวันเย็น':   ['08:00', '12:00', '18:00'],
  'เช้า กลางวัน เย็น': ['08:00', '12:00', '18:00'],
  'สามมื้อ':           ['08:00', '12:00', '18:00'],
  '3มื้อ':             ['08:00', '12:00', '18:00'],
  'เช้าเย็นก่อนนอน':  ['08:00', '18:00', '21:00'],
};

const SINGLE_TIMES = {
  'เช้า': '08:00', 'กลางวัน': '12:00', 'เที่ยง': '12:00',
  'บ่าย': '14:00', 'เย็น': '18:00', 'ก่อนนอน': '21:00',
  'นอน': '21:00', 'กลางคืน': '21:00', 'ดึก': '22:00',
};

function hasTimeInfo(text) {
  const hasExplicit = /\b([0-9]{1,2}:[0-9]{2})\b/.test(text);
  const hasShorthand = Object.keys(SHORTHAND_TIMES).some(k => text.includes(k));
  const hasSingle = Object.keys(SINGLE_TIMES).some(k => text.includes(k));
  return hasExplicit || hasShorthand || hasSingle;
}

function parseMedication(text) {
  let schedule = [];

  for (const [pattern, times] of Object.entries(SHORTHAND_TIMES)) {
    if (text.includes(pattern)) { schedule = [...times]; break; }
  }
  if (schedule.length === 0) {
    for (const [word, time] of Object.entries(SINGLE_TIMES)) {
      if (text.includes(word) && !schedule.includes(time)) schedule.push(time);
    }
  }
  const explicit = text.match(/\b([0-9]{1,2}:[0-9]{2})\b/g);
  if (explicit) explicit.forEach(t => { const p = t.padStart(5,'0'); if (!schedule.includes(p)) schedule.push(p); });
  if (schedule.length === 0) schedule = ['08:00'];
  schedule.sort();

  const dosageMatch = text.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|เม็ด|แคปซูล|ช้อน|ซีซี)/i);
  const dosage = dosageMatch ? `${dosageMatch[1]}${dosageMatch[2]}` : null;

  let name = text
    .replace(/\d+(?:\.\d+)?\s*(mg|mcg|ml|เม็ด|แคปซูล|ช้อน|ซีซี)/gi, '')
    .replace(/วันละ\s*\d+\s*ครั้ง/g, '')
    .replace(/กิน|ทาน|รับประทาน|ยา/g, '')
    .replace(new RegExp(Object.keys(SHORTHAND_TIMES).join('|'), 'g'), '')
    .replace(new RegExp(Object.keys(SINGLE_TIMES).join('|'), 'g'), '')
    .replace(/\b([0-9]{1,2}:[0-9]{2})\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!name || name.length < 2) name = text.split(' ')[0];

  return { name, dosage, schedule };
}

function formatMed(med) {
  const times = med.schedule.map(t => TIME_LABELS[t] || t).join(', ');
  return `${med.name}${med.dosage ? ` ${med.dosage}` : ''} — ${times}`;
}

async function saveMedicationToDB(patientId, name, dosage, schedule, source = 'chat') {
  const result = await pool.query(
    `INSERT INTO medications (patient_id, name, dosage, schedule, active, source)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     RETURNING id, name, dosage, schedule`,
    [patientId, name, dosage, schedule, source]
  );
  console.log(`💊 Saved: ${name} @ ${schedule.join(', ')}`);
  return result.rows[0];
}

// ============================================================
// FLEX MESSAGE: MEDICATION CARD
// ============================================================

async function buildMedCard(patientId, headerText = '💊 รายการยาของคุณ') {
  const result = await pool.query(
    `SELECT name, dosage, schedule FROM medications
     WHERE patient_id = $1 AND active = TRUE ORDER BY created_at`,
    [patientId]
  );

  const rows = result.rows.map(m => ({
    type: 'box', layout: 'horizontal',
    contents: [
      { type: 'text', text: `${m.name}${m.dosage ? ` ${m.dosage}` : ''}`, size: 'sm', color: '#1a1a1a', flex: 3, wrap: true },
      { type: 'text', text: m.schedule.map(t => TIME_LABELS[t] || t).join(', '), size: 'sm', color: '#555555', flex: 2, align: 'end', wrap: true },
    ],
    paddingTop: '8px', paddingBottom: '8px',
  }));

  return {
    type: 'flex',
    altText: headerText,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: headerText, weight: 'bold', size: 'md', color: '#ffffff' }],
        backgroundColor: '#06C755', paddingAll: '14px',
      },
      body: {
        type: 'box', layout: 'vertical',
        contents: rows.length > 0 ? rows : [{ type: 'text', text: 'ยังไม่มีรายการยาครับ', size: 'sm', color: '#999999' }],
        paddingAll: '12px', spacing: 'md',
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: `รวม ${rows.length} รายการ · แจ้งลุงเพื่อแก้ไขได้เลยครับ`, size: 'xs', color: '#aaaaaa', align: 'center' }],
        paddingAll: '10px',
      },
    },
  };
}

// ============================================================
// LINE QUICK REPLY BUILDER
// ============================================================

function buildQuickReply(text, buttons) {
  return {
    type: 'text', text,
    quickReply: {
      items: buttons.map(b => ({
        type: 'action',
        action: { type: 'message', label: b.label, text: b.text || b.label },
      })),
    },
  };
}

const TIME_BUTTONS = [
  { label: '🌅 เช้า',          text: 'เช้า' },
  { label: '☀️ กลางวัน',       text: 'กลางวัน' },
  { label: '🌆 เย็น',          text: 'เย็น' },
  { label: '🌙 ก่อนนอน',       text: 'ก่อนนอน' },
  { label: '🌅🌆 เช้าเย็น',   text: 'เช้าเย็น' },
  { label: '3 มื้อ',           text: 'เช้ากลางวันเย็น' },
];

const TIME_BUTTONS_EN = [
  { label: '🌅 Morning',       text: 'morning' },
  { label: '☀️ Midday',        text: 'midday' },
  { label: '🌆 Evening',       text: 'evening' },
  { label: '🌙 Bedtime',       text: 'bedtime' },
  { label: '🌅🌆 Twice daily', text: 'morning and evening' },
  { label: '3x daily',         text: 'morning midday evening' },
];

// ============================================================
// BILINGUAL STRING HELPER
// All user-facing hardcoded strings go through S(lang, key, ...args)
// lang is 'th' (default) or 'en'
// ============================================================

const S = (lang, key, ...args) => {
  const [a, b, c] = args;
  const strings = {
    // Onboarding
    welcome_ask_lang: {
      th: '🇹🇭 / 🇬🇧\n\nสวัสดีครับ! ผมลุงโน้ต ผู้ช่วยดูแลสุขภาพบน LINE ครับ 😊\nHi! I\'m Uncle Note, your personal health assistant on LINE.\n\nกรุณาเลือกภาษา / Please choose your language:',
      en: '🇹🇭 / 🇬🇧\n\nสวัสดีครับ! ผมลุงโน้ต ผู้ช่วยดูแลสุขภาพบน LINE ครับ 😊\nHi! I\'m Uncle Note, your personal health assistant on LINE.\n\nกรุณาเลือกภาษา / Please choose your language:',
    },
    ask_name: {
      th: 'สวัสดีครับ ผมลุงโน้ต ผู้ช่วยดูแลสุขภาพครับ 😊\nขอทราบชื่อของคุณด้วยได้ไหมครับ?',
      en: 'Nice to meet you! 😊\nWhat\'s your name?',
    },
    name_retry: {
      th: 'ขอโทษครับ ลุงยังไม่ได้ยินชื่อ ช่วยพิมพ์ชื่อมาอีกครั้งได้ไหมครับ?',
      en: 'Sorry, I didn\'t catch your name. Could you type it again?',
    },
    ask_mode: {
      th: (name) => `ยินดีที่ได้รู้จักคุณ${name}ครับ 😊\n\nลุงโน้ตจะดูแลใครครับ?`,
      en: (name) => `Nice to meet you, ${name}! 😊\n\nWho will Uncle Note be looking after?`,
    },
    mode_unclear: {
      th: 'ขอโทษครับ ลุงยังไม่เข้าใจ — เลือกได้เลยครับ:',
      en: 'Sorry, I didn\'t understand — please choose:',
    },
    mode_buttons: {
      th: [{ label: '🧓 ดูแลตัวเอง', text: 'ดูแลตัวเอง' }, { label: '👨‍👩‍👧 ดูแลคุณพ่อคุณแม่', text: 'ดูแลพ่อแม่' }],
      en: [{ label: '🧓 For myself', text: 'myself' }, { label: '👨‍👩‍👧 For a parent', text: 'my parent' }],
    },
    family_intro: {
      th: 'ดีมากเลยครับที่ดูแลคุณพ่อคุณแม่ 🙏\nลุงจะช่วยตั้งค่าให้ก่อนส่งลิงก์ให้ท่านนะครับ\n\nขอทราบชื่อคุณพ่อหรือคุณแม่ที่จะดูแลด้วยได้ไหมครับ?',
      en: 'That\'s wonderful that you\'re looking after your parent! 🙏\nLet\'s set things up first, then I\'ll send them an invite link.\n\nWhat\'s your parent\'s name?',
    },
    ask_conditions: {
      th: 'รับทราบครับ 😊 ขอถามนิดนึงนะครับ — มีโรคประจำตัวไหมครับ?',
      en: 'Got it! 😊 Quick question — do you have any underlying conditions?',
    },
    ask_conditions_for: {
      th: (name) => `คุณ${name}มีโรคประจำตัวไหมครับ?`,
      en: (name) => `Does ${name} have any underlying conditions?`,
    },
    condition_buttons: {
      th: [
        { label: '❤️ ความดัน', text: 'ความดัน' },
        { label: '🩸 เบาหวาน', text: 'เบาหวาน' },
        { label: '❤️🩸 ทั้งสองอย่าง', text: 'ความดันและเบาหวาน' },
        { label: '✨ ไม่มี', text: 'ไม่มี' },
      ],
      en: [
        { label: '❤️ Hypertension', text: 'hypertension' },
        { label: '🩸 Diabetes', text: 'diabetes' },
        { label: '❤️🩸 Both', text: 'hypertension and diabetes' },
        { label: '✨ None', text: 'none' },
      ],
    },
    ask_meds: {
      th: 'รับทราบครับ 👍\nตอนนี้ทานยาประจำอยู่ไหมครับ?',
      en: 'Got it! 👍\nAre you currently taking any regular medications?',
    },
    ask_meds_for: {
      th: 'รับทราบครับ 👍\nคุณพ่อ/คุณแม่ทานยาประจำอยู่ไหมครับ?',
      en: 'Got it! 👍\nDoes your parent take any regular medications?',
    },
    med_buttons: {
      th: [
        { label: '💊 มียา — พิมพ์บอกลุง', text: 'มียา' },
        { label: '📷 ถ่ายรูปฉลากยา',      text: 'ถ่ายรูปยา' },
        { label: '🚫 ไม่มียา',             text: 'ไม่มียา' },
      ],
      en: [
        { label: '💊 Yes — type med name', text: 'yes medications' },
        { label: '📷 Photo of label',       text: 'photo' },
        { label: '🚫 No medications',       text: 'no medications' },
      ],
    },
    ask_med_name: {
      th: 'พิมพ์ชื่อยามาได้เลยครับ เช่น "Amlodipine 5mg"\nลุงจะถามเวลากินให้ครับ 💊',
      en: 'Type the medication name, e.g. "Amlodipine 5mg"\nI\'ll ask when you take it 💊',
    },
    ask_med_time: {
      th: (name, dosage) => `${name}${dosage ? ` ${dosage}` : ''} — ทานตอนไหนครับ?`,
      en: (name, dosage) => `${name}${dosage ? ` ${dosage}` : ''} — when do you take it?`,
    },
    med_name_unclear: {
      th: 'ขอโทษครับ ลุงอ่านชื่อยาไม่ออก ช่วยพิมพ์ชื่อยาอีกครั้งได้ไหมครับ?',
      en: 'Sorry, I couldn\'t read the medication name. Could you type it again?',
    },
    med_saved: {
      th: (fmt) => `จดไว้แล้วครับ 💊\n✅ ${fmt}\n\n`,
      en: (fmt) => `Saved! 💊\n✅ ${fmt}\n\n`,
    },
    ask_pill_count: {
      th: (name) => `มียา${name}เหลืออยู่กี่เม็ดครับ?`,
      en: (name) => `How many ${name} pills do you have left?`,
    },
    pill_buttons: {
      th: [
        { label: '30 เม็ด', text: '30' }, { label: '60 เม็ด', text: '60' },
        { label: '90 เม็ด', text: '90' }, { label: '⌨️ พิมพ์เอง', text: 'พิมพ์จำนวน' },
        { label: '❌ ไม่ทราบ', text: 'ไม่ทราบ' },
      ],
      en: [
        { label: '30 pills', text: '30' }, { label: '60 pills', text: '60' },
        { label: '90 pills', text: '90' }, { label: '⌨️ Type number', text: 'type number' },
        { label: '❌ Not sure', text: 'not sure' },
      ],
    },
    pill_saved: {
      th: (n) => `รับทราบครับ จด ${n} เม็ดไว้แล้ว 👍\nมียาตัวอื่นอีกไหมครับ?`,
      en: (n) => `Got it, saved ${n} pills 👍\nAny other medications?`,
    },
    pill_skip: {
      th: 'รับทราบครับ 👍\nมียาตัวอื่นอีกไหมครับ?',
      en: 'OK! 👍\nAny other medications?',
    },
    more_med_buttons: {
      th: [{ label: '💊 มียาอีก', text: 'มียาอีก' }, { label: '✅ หมดแล้ว', text: 'หมดแล้ว' }],
      en: [{ label: '💊 Add another', text: 'add another' }, { label: '✅ All done', text: 'all done' }],
    },
    next_med: {
      th: 'พิมพ์ชื่อยาตัวต่อไปได้เลยครับ 💊',
      en: 'Type the next medication name 💊',
    },
    ask_confirm: {
      th: (name) => `ข้อมูลยาถูกต้องไหมครับ คุณ${name || ''}?`,
      en: (name) => `Does everything look correct, ${name || ''}?`,
    },
    confirm_buttons: {
      th: [{ label: '✅ ถูกต้องแล้ว', text: 'ถูกต้องแล้ว' }, { label: '✏️ แก้ไขบางอย่าง', text: 'อยากแก้ไข' }],
      en: [{ label: '✅ Looks good', text: 'correct' }, { label: '✏️ Edit', text: 'edit' }],
    },
    confirm_unclear: {
      th: 'ขอโทษครับ ลุงยังไม่เข้าใจ — ข้อมูลยาถูกต้องไหมครับ?',
      en: 'Sorry, I didn\'t understand — does everything look correct?',
    },
    complete_solo: {
      th: (name, count) => `เยี่ยมเลยครับ คุณ${name || ''} 🎉\nจดยาไว้ ${count} ตัวแล้วครับ ลุงจะเตือนยาตรงเวลาให้นะครับ ⏰\nบอกค่าความดัน น้ำตาล หรืออาการมาได้เลยครับ`,
      en: (name, count) => `All set, ${name || ''}! 🎉\nI've saved ${count} medication(s) and will remind you on time ⏰\nFeel free to log your BP, blood sugar, or any symptoms anytime!`,
    },
    complete_no_meds: {
      th: (name) => `เรียบร้อยครับ คุณ${name || ''} 🎉\nลุงโน้ตพร้อมดูแลแล้วครับ! บอกค่าความดัน น้ำตาล หรืออาการมาได้เลยนะครับ`,
      en: (name) => `All set, ${name || ''}! 🎉\nUncle Note is ready. Feel free to log your BP, blood sugar, or any symptoms!`,
    },
    guardian_complete: {
      th: (name) => `เยี่ยมเลยครับ 🎉 ตั้งค่าเสร็จแล้ว!\nลุงสร้างลิงก์เชิญคุณ${name || 'ท่าน'}ให้แล้วครับ\nส่งลิงก์นี้ให้ท่านกดเพื่อเริ่มใช้งานได้เลยครับ:`,
      en: (name) => `All set! 🎉\nHere's the invite link for ${name || 'your parent'}.\nSend it to them to get started:`,
    },
    guardian_complete_fallback: {
      th: (name) => `เยี่ยมเลยครับ 🎉\nพิมพ์ "เชิญ" เพื่อสร้างลิงก์ให้คุณ${name || 'ท่าน'}ได้เลยครับ`,
      en: (name) => `All set! 🎉\nType "invite" to generate a link for ${name || 'your parent'}.`,
    },
    edit_meds: {
      th: 'บอกลุงได้เลยครับ อยากแก้ไขยาตัวไหน หรือเพิ่ม/ลบอะไรครับ?',
      en: 'Sure! Which medication would you like to change, add, or remove?',
    },
    photo_ask_retake: {
      th: 'ขอโทษครับ ลุงอ่านฉลากไม่ออก ช่วยถ่ายใหม่ให้ชัดขึ้น หรือพิมพ์ชื่อยามาแทนได้ไหมครับ?',
      en: 'Sorry, I couldn\'t read the label. Could you take a clearer photo, or type the name instead?',
    },
    photo_read: {
      th: (name, dosage) => `อ่านได้ครับ 📷\n${name}${dosage ? ` ${dosage}` : ''} — ทานตอนไหนครับ?`,
      en: (name, dosage) => `Got it! 📷\n${name}${dosage ? ` ${dosage}` : ''} — when do you take it?`,
    },
    // Cron pushes
    reminder_push: {
      th: (name, med, dosage) => `💊 ถึงเวลากินยาแล้ว${name}ครับ\nยา: ${med}${dosage ? ` ${dosage}` : ''}\nกินเสร็จแล้วตอบ "กินแล้ว" ให้ลุงทราบด้วยนะครับ 🙏`,
      en: (name, med, dosage) => `💊 Time for your medication${name}!\nMed: ${med}${dosage ? ` ${dosage}` : ''}\nReply "taken" when done 🙏`,
    },
    followup_push: {
      th: (name, med, dosage) => `🔔 ลุงโน้ตเป็นห่วงนะครับ${name}\nยัง${med}${dosage ? ` ${dosage}` : ''} ยังไม่ได้กินใช่ไหมครับ?\nถ้ากินแล้วตอบ "กินแล้ว" ได้เลยครับ 💊`,
      en: (name, med, dosage) => `🔔 Just checking in${name}\nHave you taken ${med}${dosage ? ` ${dosage}` : ''} yet?\nReply "taken" if you have 💊`,
    },
    refill_push: {
      th: (name, med, dosage, days) => `⚠️ ยา${med}${dosage ? ` ${dosage}` : ''} ใกล้หมดแล้วครับ${name}\nเหลืออยู่ประมาณ ${days} วันครับ\nอย่าลืมขอยาเพิ่มจากแพทย์ด้วยนะครับ 🏥`,
      en: (name, med, dosage, days) => `⚠️ ${med}${dosage ? ` ${dosage}` : ''} is running low${name}\nAbout ${days} days left\nPlease ask your doctor for a refill 🏥`,
    },
    appt_48h: {
      th: (name, title, time) => `📅 แจ้งเตือนนัดแพทย์${name}ครับ\n${title}\n🕐 ${time}\n\nอีก 2 วันแล้วนะครับ อย่าลืมเตรียมตัวด้วยนะครับ 😊`,
      en: (name, title, time) => `📅 Appointment reminder${name}\n${title}\n🕐 ${time}\n\nJust 2 days away — don't forget to prepare! 😊`,
    },
    appt_24h: {
      th: (name, title, time) => `📅 แจ้งเตือนนัดแพทย์${name}ครับ\n${title}\n🕐 พรุ่งนี้ ${time}\n\nอย่าลืมนะครับ 🏥 และอย่าลืมนำบัตรประชาชน + ประวัติยาไปด้วยครับ`,
      en: (name, title, time) => `📅 Appointment tomorrow${name}\n${title}\n🕐 ${time}\n\nDon't forget your ID and medication list 🏥`,
    },
    unsupported_msg: {
      th: 'ลุงรับข้อความหรือรูปภาพได้นะครับ 😊',
      en: 'I can only receive text messages or images 😊',
    },
    // Invite
    invite_welcome: {
      th: (name) => `ยินดีต้อนรับครับ คุณ${name || ''}! 🎉\nลุงโน้ตพร้อมดูแลคุณแล้วนะครับ\nลูกหลานของคุณจะได้รับรายงานสุขภาพจากลุงด้วยนะครับ 😊\n\nบอกค่าความดัน น้ำตาล หรืออาการมาได้เลยครับ`,
      en: (name) => `Welcome, ${name || ''}! 🎉\nUncle Note is ready to look after you.\nYour family will receive health updates too 😊\n\nFeel free to log your BP, blood sugar, or any symptoms!`,
    },
    invite_used:    { th: 'ขอโทษครับ ลิงก์นี้ถูกใช้ไปแล้ว ขอให้ลูกหลานสร้างลิงก์ใหม่ให้นะครับ', en: 'Sorry, this link has already been used. Please ask your family to send a new one.' },
    invite_expired: { th: 'ขอโทษครับ ลิงก์หมดอายุแล้ว (ใช้ได้แค่ 24 ชั่วโมง) ขอให้ลูกหลานสร้างลิงก์ใหม่ให้นะครับ', en: 'Sorry, this link has expired (valid for 24 hours). Please ask your family to send a new one.' },
    invite_linked:  { th: 'คุณเชื่อมต่อกับลุงโน้ตอยู่แล้วนะครับ 😊 พิมพ์มาคุยกับลุงได้เลยครับ', en: 'You\'re already connected to Uncle Note 😊 Feel free to chat!' },
    invite_invalid: { th: 'ขอโทษครับ ลิงก์ไม่ถูกต้อง ขอให้ลูกหลานส่งลิงก์ใหม่ให้นะครับ', en: 'Sorry, this link is not valid. Please ask your family to send a new one.' },
  };

  const entry = strings[key];
  if (!entry) return `[missing: ${key}]`;
  const val = entry[lang] ?? entry['th'];
  return typeof val === 'function' ? val(a, b, c) : val;
};

// ============================================================
// ONBOARDING STATE MACHINE
// ============================================================

async function getOrCreatePatient(lineUserId) {
  const existing = await pool.query('SELECT * FROM patients WHERE line_user_id = $1', [lineUserId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const hhResult = await pool.query(`INSERT INTO households (mode) VALUES ('solo') RETURNING id`);
  const householdId = hhResult.rows[0].id;

  const patientResult = await pool.query(
    `INSERT INTO patients (household_id, line_user_id, care_mode, onboarding_state, language)
     VALUES ($1, $2, 'self', 'new', 'th') RETURNING *`,
    [householdId, lineUserId]
  );
  await pool.query(`INSERT INTO subscriptions (household_id, status) VALUES ($1, 'trial')`, [householdId]);
  console.log(`✅ New patient: ${patientResult.rows[0].id}`);
  return patientResult.rows[0];
}

// Convenience: get patient language, defaults to 'th'
function lang(patient) {
  return patient?.language === 'en' ? 'en' : 'th';
}

function needsOnboarding(patient) {
  return !patient.onboarding_state || patient.onboarding_state !== 'complete';
}

async function setOnboardingState(patientId, state) {
  await pool.query(`UPDATE patients SET onboarding_state = $1 WHERE id = $2`, [state, patientId]);
}

async function handleOnboarding(event, patient) {
  const { replyToken } = event;
  const text = event.message?.text?.trim() || '';
  const { id: patientId } = patient;
  const lineUserId = event.source.userId;
  const state = patient.onboarding_state || 'new';
  const l = lang(patient);

  // ── new: send welcome via push (follow event already handled),
  //   but if somehow a message arrives before language is chosen, re-ask
  if (state === 'new') {
    await setOnboardingState(patientId, 'asking_language');
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      S('th', 'welcome_ask_lang'),
      [{ label: '🇹🇭 ภาษาไทย', text: 'ภาษาไทย' }, { label: '🇬🇧 English', text: 'English' }]
    )]});
    return;
  }

  // ── asking_language: save preference, ask name ─────────────
  if (state === 'asking_language') {
    const isEn = /english|en\b/i.test(text) || text.trim() === 'English';
    const isTh = /ไทย|thai/i.test(text) || text.trim() === 'ภาษาไทย';
    if (!isEn && !isTh) {
      await client.replyMessage({ replyToken, messages: [buildQuickReply(
        S('th', 'welcome_ask_lang'),
        [{ label: '🇹🇭 ภาษาไทย', text: 'ภาษาไทย' }, { label: '🇬🇧 English', text: 'English' }]
      )]});
      return;
    }
    const chosenLang = isEn ? 'en' : 'th';
    await pool.query(`UPDATE patients SET language=$1, onboarding_state='asking_name' WHERE id=$2`, [chosenLang, patientId]);
    // Re-read patient with updated language for S() calls below
    patient.language = chosenLang;
    const l2 = chosenLang;
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l2, 'ask_name') }]});
    return;
  }

  // ── asking_name: save name + ask mode ─────────────────────
  if (state === 'asking_name') {
    if (!text || text.length < 1) {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'name_retry') }]});
      return;
    }
    await pool.query(`UPDATE patients SET display_name = $1 WHERE id = $2`, [text, patientId]);
    await setOnboardingState(patientId, 'asking_mode');
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      S(l, 'ask_mode', text),
      S(l, 'mode_buttons')
    )]});
    return;
  }

  // ── asking_mode: classify intent + branch ─────────────────
  if (state === 'asking_mode') {
    const intent = await classifyIntent(text, 'mode_choice');
    if (intent === 'UNCLEAR') {
      await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'mode_unclear'), S(l, 'mode_buttons'))]});
      return;
    }
    if (intent === 'FAMILY') {
      const hhResult = await pool.query(`SELECT household_id FROM patients WHERE id=$1`, [patientId]);
      const householdId = hhResult.rows[0].household_id;
      await pool.query(`UPDATE households SET mode='guardian' WHERE id=$1`, [householdId]);
      await pool.query(
        `INSERT INTO guardians (household_id, line_user_id, display_name, notification_level)
         VALUES ($1, $2, $3, 'realtime')
         ON CONFLICT (household_id) DO UPDATE SET line_user_id=$2`,
        [householdId, lineUserId, patient.display_name]
      );
      await setOnboardingState(patientId, 'guardian_asking_patient_name');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'family_intro') }]});
      return;
    }
    // SELF → ask conditions
    await setOnboardingState(patientId, 'asking_conditions');
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_conditions'), S(l, 'condition_buttons'))]});
    return;
  }

  // ── guardian_asking_patient_name ───────────────────────────
  if (state === 'guardian_asking_patient_name') {
    if (!text || text.length < 1) {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'name_retry') }]});
      return;
    }
    await pool.query(`UPDATE patients SET display_name=$1 WHERE id=$2`, [text, patientId]);
    await setOnboardingState(patientId, 'guardian_asking_patient_conditions');
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_conditions_for', text), S(l, 'condition_buttons'))]});
    return;
  }

  // ── guardian_asking_patient_conditions ─────────────────────
  if (state === 'guardian_asking_patient_conditions') {
    const condIntent = await classifyIntent(text, 'has_conditions');
    const conditions = condIntent === 'NO_CONDITIONS' ? null : text;
    await pool.query(`UPDATE patients SET conditions=$1 WHERE id=$2`, [conditions, patientId]);
    await setOnboardingState(patientId, 'guardian_asking_patient_meds');
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_meds_for'), S(l, 'med_buttons'))]});
    return;
  }

  // ── guardian_asking_patient_meds ───────────────────────────
  if (state === 'guardian_asking_patient_meds') {
    const { name: gDirectName } = parseMedication(text);
    const gDoneWords = ['หมด','พอ','เท่านี้','ถูก','โอเค','ok','ใช่','ครบ','เสร็จ','ไม่มี','no','none','done'];
    const gStartsWithDone = gDoneWords.some(w => text.toLowerCase().startsWith(w) || text.toLowerCase() === w);
    if (gDirectName && gDirectName.length >= 2 && !gStartsWithDone && text.length < 60) {
      await handleGuardianMedEntry(replyToken, patientId, text, patient);
      return;
    }
    const medIntent = await classifyIntent(text, 'has_meds');
    if (medIntent === 'NO_MEDS') {
      await setOnboardingState(patientId, 'guardian_confirming');
      await guardianShowConfirmation(replyToken, patientId, l);
      return;
    }
    if (medIntent === 'PHOTO') {
      await setOnboardingState(patientId, 'guardian_asking_more_meds');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: l === 'en' ? 'Send a photo of the medicine label 📷' : 'ถ่ายรูปฉลากยามาได้เลยครับ 📷' }]});
      return;
    }
    if (medIntent === 'HAS_MEDS') {
      await setOnboardingState(patientId, 'guardian_asking_more_meds');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'ask_med_name') }]});
      return;
    }
    await handleGuardianMedEntry(replyToken, patientId, text, patient);
    return;
  }

  // ── guardian_asking_med_time ───────────────────────────────
  if (state === 'guardian_asking_med_time') {
    const pendingResult = await pool.query(`SELECT pending_med_name, pending_med_dosage FROM patients WHERE id=$1`, [patientId]);
    const { pending_med_name, pending_med_dosage } = pendingResult.rows[0];
    const { schedule } = parseMedication(text);
    const finalSchedule = schedule.length > 0 ? schedule : ['08:00'];
    const med = await saveMedicationToDB(patientId, pending_med_name, pending_med_dosage, finalSchedule);
    await pool.query(`UPDATE patients SET pending_med_name=$1, pending_med_dosage=NULL, onboarding_state='guardian_asking_pill_count' WHERE id=$2`, [med.name, patientId]);
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      S(l, 'med_saved', formatMed(med)) + S(l, 'ask_pill_count', med.name),
      S(l, 'pill_buttons')
    )]});
    return;
  }

  // ── guardian_asking_pill_count ─────────────────────────────
  if (state === 'guardian_asking_pill_count') {
    const pendingResult = await pool.query(`SELECT pending_med_name FROM patients WHERE id=$1`, [patientId]);
    const medName = pendingResult.rows[0]?.pending_med_name;
    const numMatch = text.match(/\d+/);
    const pills = numMatch ? parseInt(numMatch[0]) : null;
    const unknown = /ไม่ทราบ|ไม่รู้|not sure|unknown/i.test(text);
    if (pills && !unknown) {
      const doseResult = await pool.query(
        `SELECT array_length(schedule,1) as doses_per_day FROM medications WHERE patient_id=$1 AND name=$2 AND active=TRUE ORDER BY created_at DESC LIMIT 1`,
        [patientId, medName]
      );
      const dosesPerDay = doseResult.rows[0]?.doses_per_day || 1;
      await pool.query(`UPDATE medications SET pills_remaining=$1, refill_alert_at=$2 WHERE patient_id=$3 AND name=$4 AND active=TRUE`,
        [pills, Math.max(7, dosesPerDay * 7), patientId, medName]);
    }
    await pool.query(`UPDATE patients SET pending_med_name=NULL, onboarding_state='guardian_asking_more_meds' WHERE id=$1`, [patientId]);
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      pills && !unknown ? S(l, 'pill_saved', pills) : S(l, 'pill_skip'),
      S(l, 'more_med_buttons')
    )]});
    return;
  }

  // ── guardian_asking_more_meds ──────────────────────────────
  if (state === 'guardian_asking_more_meds') {
    const { name: parsedName } = parseMedication(text);
    const doneWords = ['หมด','พอ','เท่านี้','ถูก','โอเค','ok','ใช่','ครบ','เสร็จ','all done','done','finish'];
    const startsWithDone = doneWords.some(w => text.toLowerCase().startsWith(w) || text.toLowerCase() === w);
    if (parsedName && parsedName.length >= 2 && !startsWithDone && text.length < 60) {
      await handleGuardianMedEntry(replyToken, patientId, text, patient);
      return;
    }
    const doneIntent = await classifyIntent(text, 'done_or_more');
    if (doneIntent === 'DONE') {
      await setOnboardingState(patientId, 'guardian_confirming');
      await guardianShowConfirmation(replyToken, patientId, l);
      return;
    }
    if (doneIntent === 'MORE') {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'next_med') }]});
      return;
    }
    await handleGuardianMedEntry(replyToken, patientId, text, patient);
    return;
  }

  // ── guardian_confirming ────────────────────────────────────
  if (state === 'guardian_confirming') {
    const confirmIntent = await classifyIntent(text, 'correct_or_edit');
    if (confirmIntent === 'CORRECT') {
      await setOnboardingState(patientId, 'complete');
      const patientData = await pool.query(`SELECT display_name FROM patients WHERE id=$1`, [patientId]);
      const patientName = patientData.rows[0]?.display_name;
      try {
        const { deepLink } = await createInviteLink(lineUserId, patientName);
        const card = buildInviteCard(deepLink, patientName);
        await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'guardian_complete', patientName) }, card]});
      } catch (err) {
        await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'guardian_complete_fallback', patientName) }]});
      }
      return;
    }
    if (confirmIntent === 'EDIT') {
      await setOnboardingState(patientId, 'guardian_asking_more_meds');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'edit_meds') }]});
      return;
    }
    await guardianShowConfirmation(replyToken, patientId, l);
    return;
  }
  if (state === 'asking_conditions') {
    const intent = await classifyIntent(text, 'has_conditions');
    const conditions = intent === 'NO_CONDITIONS' ? null : text;
    await pool.query(`UPDATE patients SET conditions = $1 WHERE id = $2`, [conditions, patientId]);
    await setOnboardingState(patientId, 'asking_meds');
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_meds'), S(l, 'med_buttons'))]});
    return;
  }

  // ── asking_meds ───────────────────────────────────────────
  if (state === 'asking_meds') {
    const { name: soloDirectName } = parseMedication(text);
    const soloDoneWords = ['หมด','พอ','เท่านี้','ถูก','โอเค','ok','ใช่','ครบ','เสร็จ','ไม่มี','no','none','done'];
    const soloStartsWithDone = soloDoneWords.some(w => text.toLowerCase().startsWith(w) || text.toLowerCase() === w);
    if (soloDirectName && soloDirectName.length >= 2 && !soloStartsWithDone && text.length < 60) {
      await handleMedEntry(replyToken, patientId, text, patient);
      return;
    }
    const intent = await classifyIntent(text, 'has_meds');
    if (intent === 'NO_MEDS') {
      await setOnboardingState(patientId, 'complete');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'complete_no_meds', patient.display_name) }]});
      return;
    }
    if (intent === 'PHOTO') {
      await setOnboardingState(patientId, 'asking_more_meds');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: l === 'en' ? 'Send a photo of the medicine label 📷' : 'ถ่ายรูปฉลากยามาได้เลยครับ ลุงจะอ่านและจดไว้ให้ครับ 📷' }]});
      return;
    }
    if (intent === 'HAS_MEDS') {
      await setOnboardingState(patientId, 'asking_more_meds');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'ask_med_name') }]});
      return;
    }
    const { name: directName } = parseMedication(text);
    if (directName && directName.length >= 2) {
      await handleMedEntry(replyToken, patientId, text, patient);
      return;
    }
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_meds'), S(l, 'med_buttons'))]});
    return;
  }

  // ── asking_med_time ───────────────────────────────────────
  if (state === 'asking_med_time') {
    const pendingResult = await pool.query(`SELECT pending_med_name, pending_med_dosage FROM patients WHERE id = $1`, [patientId]);
    const { pending_med_name, pending_med_dosage } = pendingResult.rows[0];
    const { schedule } = parseMedication(text);
    const finalSchedule = schedule.length > 0 ? schedule : ['08:00'];
    const med = await saveMedicationToDB(patientId, pending_med_name, pending_med_dosage, finalSchedule);
    await pool.query(`UPDATE patients SET pending_med_name=$1, pending_med_dosage=NULL, onboarding_state='asking_pill_count' WHERE id=$2`, [med.name, patientId]);
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      S(l, 'med_saved', formatMed(med)) + S(l, 'ask_pill_count', med.name),
      S(l, 'pill_buttons')
    )]});
    return;
  }

  // ── asking_pill_count ─────────────────────────────────────
  if (state === 'asking_pill_count') {
    const pendingResult = await pool.query(`SELECT pending_med_name FROM patients WHERE id=$1`, [patientId]);
    const medName = pendingResult.rows[0]?.pending_med_name;
    const numMatch = text.match(/\d+/);
    const pills = numMatch ? parseInt(numMatch[0]) : null;
    const unknown = /ไม่ทราบ|ไม่รู้|not sure|unknown|พิมพ์จำนวน|type number/i.test(text);
    if (pills && !unknown) {
      const doseResult = await pool.query(
        `SELECT array_length(schedule,1) as doses_per_day FROM medications WHERE patient_id=$1 AND name=$2 AND active=TRUE ORDER BY created_at DESC LIMIT 1`,
        [patientId, medName]
      );
      const dosesPerDay = doseResult.rows[0]?.doses_per_day || 1;
      await pool.query(`UPDATE medications SET pills_remaining=$1, refill_alert_at=$2 WHERE patient_id=$3 AND name=$4 AND active=TRUE`,
        [pills, Math.max(7, dosesPerDay * 7), patientId, medName]);
    }
    await pool.query(`UPDATE patients SET pending_med_name=NULL, onboarding_state='asking_more_meds' WHERE id=$1`, [patientId]);
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      pills && !unknown ? S(l, 'pill_saved', pills) : S(l, 'pill_skip'),
      S(l, 'more_med_buttons')
    )]});
    return;
  }

  if (state === 'asking_more_meds') {
    const { name: parsedName } = parseMedication(text);
    const doneWords = ['หมด','พอ','เท่านี้','เท่า','ถูก','โอเค','ok','ใช่','ครบ','เสร็จ','all done','done','finish'];
    const moreWords = ['มียาอีก','มีอีก','เพิ่ม','add another','more'];
    const startsWithDoneOrMore = [...doneWords, ...moreWords].some(w => text.toLowerCase().startsWith(w) || text.toLowerCase() === w);
    if (parsedName && parsedName.length >= 2 && !startsWithDoneOrMore && text.length < 60) {
      await handleMedEntry(replyToken, patientId, text, patient);
      return;
    }
    const intent = await classifyIntent(text, 'done_or_more');
    if (intent === 'DONE') {
      await setOnboardingState(patientId, 'confirming_meds');
      const card = await buildMedCard(patientId, l === 'en' ? '💊 Your medications' : '💊 รายการยาที่ลุงจดไว้');
      await client.replyMessage({ replyToken, messages: [
        card,
        buildQuickReply(S(l, 'ask_confirm', patient.display_name), S(l, 'confirm_buttons')),
      ]});
      return;
    }
    if (intent === 'MORE') {
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'next_med') }]});
      return;
    }
    await handleMedEntry(replyToken, patientId, text, patient);
    return;
  }

  // ── confirming_meds ───────────────────────────────────────
  if (state === 'confirming_meds') {
    const intent = await classifyIntent(text, 'correct_or_edit');
    if (intent === 'CORRECT') {
      await setOnboardingState(patientId, 'complete');
      const countResult = await pool.query(`SELECT COUNT(*) FROM medications WHERE patient_id = $1 AND active = TRUE`, [patientId]);
      const count = parseInt(countResult.rows[0].count);
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'complete_solo', patient.display_name, count) }]});
      return;
    }
    if (intent === 'EDIT') {
      await setOnboardingState(patientId, 'asking_more_meds');
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'edit_meds') }]});
      return;
    }
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'confirm_unclear'), S(l, 'confirm_buttons'))]});
    return;
  }
}

async function guardianShowConfirmation(replyToken, patientId, l = 'th') {
  const patientData = await pool.query(`SELECT display_name, conditions FROM patients WHERE id=$1`, [patientId]);
  const p = patientData.rows[0];
  const card = await buildMedCard(patientId, l === 'en' ? `💊 ${p.display_name || 'Parent'}'s medications` : `💊 ยาของคุณ${p.display_name || 'ท่าน'}`);
  const condLabel = l === 'en' ? 'Conditions' : 'โรคประจำตัว';
  const noneLabel = l === 'en' ? 'None' : 'ไม่มี';
  await client.replyMessage({ replyToken, messages: [
    { type: 'text', text: `${l === 'en' ? `${p.display_name || 'Parent'}'s info` : `ข้อมูลคุณ${p.display_name || 'ท่าน'}`}:\n• ${condLabel}: ${p.conditions || noneLabel}` },
    card,
    buildQuickReply(S(l, 'ask_confirm', ''), S(l, 'confirm_buttons')),
  ]});
}

// Guardian med entry — same as patient but stays in guardian states
async function handleGuardianMedEntry(replyToken, patientId, text, patient) {
  const l = lang(patient);

  const { name, dosage, schedule } = parseMedication(text);
  if (!name || name.length < 2) {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'med_name_unclear') }]});
    return;
  }
  if (!hasTimeInfo(text)) {
    await pool.query(`UPDATE patients SET pending_med_name=$1, pending_med_dosage=$2, onboarding_state='guardian_asking_med_time' WHERE id=$3`, [name, dosage, patientId]);
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_med_time', name, dosage), l === 'en' ? TIME_BUTTONS_EN : TIME_BUTTONS)]});
    return;
  }
  const med = await saveMedicationToDB(patientId, name, dosage, schedule);
  await pool.query(`UPDATE patients SET pending_med_name=$1, onboarding_state='guardian_asking_pill_count' WHERE id=$2`, [med.name, patientId]);
  await client.replyMessage({ replyToken, messages: [buildQuickReply(
    S(l, 'med_saved', formatMed(med)) + S(l, 'ask_pill_count', med.name),
    S(l, 'pill_buttons')
  )]});
}

// Helper: handle med entry + ask for time if missing
async function handleMedEntry(replyToken, patientId, text, patient) {
  const l = lang(patient);
  const { name, dosage, schedule } = parseMedication(text);
  if (!name || name.length < 2) {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'med_name_unclear') }]});
    return;
  }
  if (!hasTimeInfo(text)) {
    await pool.query(`UPDATE patients SET pending_med_name = $1, pending_med_dosage = $2 WHERE id = $3`, [name, dosage, patientId]);
    await pool.query(`UPDATE patients SET onboarding_state = 'asking_med_time' WHERE id = $1`, [patientId]);
    await client.replyMessage({ replyToken, messages: [buildQuickReply(S(l, 'ask_med_time', name, dosage), l === 'en' ? TIME_BUTTONS_EN : TIME_BUTTONS)]});
    return;
  }
  const med = await saveMedicationToDB(patientId, name, dosage, schedule);
  await pool.query(`UPDATE patients SET pending_med_name=$1, onboarding_state='asking_pill_count' WHERE id=$2`, [med.name, patientId]);
  await client.replyMessage({ replyToken, messages: [buildQuickReply(
    S(l, 'med_saved', formatMed(med)) + S(l, 'ask_pill_count', med.name),
    S(l, 'pill_buttons')
  )]});
}

// ============================================================
// IMAGE DURING ONBOARDING (photo of medicine label)
// ============================================================

async function handleImageDuringOnboarding(event, patient) {
  const l = lang(patient);
  try {
    const stream = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imageBase64 = Buffer.concat(chunks).toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'นี่คือฉลากยา กรุณาอ่านชื่อยาและขนาดยา ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น: {"name":"ชื่อยา","dosage":"ขนาดยา"}' },
      ]}],
    });
    let name = null, dosage = null;
    try {
      const raw = response.content.find(b => b.type === 'text')?.text ?? '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) { const p = JSON.parse(jsonMatch[0]); name = p.name; dosage = p.dosage; }
    } catch (e) { /* fall through */ }
    if (!name || name.length < 2) {
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: S(l, 'photo_ask_retake') }]});
      return;
    }
    await pool.query(`UPDATE patients SET pending_med_name = $1, pending_med_dosage = $2, onboarding_state = 'asking_med_time' WHERE id = $3`, [name, dosage, patient.id]);
    await client.replyMessage({ replyToken: event.replyToken, messages: [buildQuickReply(
      S(l, 'photo_read', name, dosage),
      l === 'en' ? TIME_BUTTONS_EN : TIME_BUTTONS
    )]});
  } catch (err) {
    console.error('Image onboarding error:', err.message);
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: S(lang(patient), 'photo_ask_retake') }]});
  }
}

// ============================================================
// MEDICATION CONTEXT (inject into system prompt)
// ============================================================

const medCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function loadPatientContext(patientId) {
  const cached = medCache.get(patientId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL) return cached.context;

  const result = await pool.query(
    `SELECT name, dosage, schedule FROM medications WHERE patient_id = $1 AND active = TRUE ORDER BY created_at`,
    [patientId]
  );
  if (result.rows.length === 0) { medCache.set(patientId, { context: '', loadedAt: Date.now() }); return ''; }

  const list = result.rows.map(m => {
    const times = m.schedule.map(t => TIME_LABELS[t] || t).join(', ');
    return `- ${m.name}${m.dosage ? ` ${m.dosage}` : ''} (${times})`;
  }).join('\n');

  const context = `\n\nยาที่ผู้ใช้ทานประจำ:\n${list}`;
  medCache.set(patientId, { context, loadedAt: Date.now() });
  return context;
}

async function buildSystemPrompt(patientId) {
  const patResult = await pool.query(`SELECT language FROM patients WHERE id=$1`, [patientId]);
  const language = patResult.rows[0]?.language || 'th';
  const langInstruction = language === 'en'
    ? '\n\nIMPORTANT: This user speaks English. Always reply in English. Keep the same warm, concise style. End replies naturally in English.'
    : '';
  return SYSTEM_PROMPT + langInstruction + (await loadPatientContext(patientId));
}

// ============================================================
// HEALTH READING PARSER + CLASSIFIERS
// ============================================================

function parseHealthReading(text) {
  const bpMatch = text.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bpMatch) {
    const s = parseFloat(bpMatch[1]), d = parseFloat(bpMatch[2]);
    if (s >= 60 && s <= 250 && d >= 40 && d <= 150)
      return { type: 'bp', value_1: s, value_2: d, unit: 'mmHg', alert_level: classifyBP(s, d) };
  }
  const spo2Match = text.match(/(?:spo2|ออกซิเจน|o2)[^\d]*(\d{2,3})\s*%?/i) || text.match(/(\d{2,3})\s*%(?!\s*น้ำตาล)/i);
  if (spo2Match) { const v = parseFloat(spo2Match[1]); if (v >= 70 && v <= 100) return { type: 'spo2', value_1: v, value_2: null, unit: 'pct', alert_level: classifySpO2(v) }; }
  const tempMatch = text.match(/(?:อุณหภูมิ|ไข้|temp)[^\d]*(\d{2}(?:\.\d)?)/i) || text.match(/(\d{2}(?:\.\d)?)\s*(?:องศา|°c)/i);
  if (tempMatch) { const v = parseFloat(tempMatch[1]); if (v >= 35 && v <= 42) return { type: 'temp', value_1: v, value_2: null, unit: 'C', alert_level: classifyTemp(v) }; }
  const glucoseMatch = text.match(/(?:น้ำตาล|glucose|blood sugar)[^\d]*(\d+(?:\.\d+)?)/i) || text.match(/(\d+(?:\.\d+)?)\s*(?:mmol|mg\/dl)/i);
  if (glucoseMatch) { const g = parseFloat(glucoseMatch[1]); if (g >= 1 && g <= 600) { const mg = g <= 30 ? g * 18 : g; return { type: 'glucose', value_1: parseFloat(mg.toFixed(0)), value_2: null, unit: 'mgdl', alert_level: classifyGlucose(mg) }; } }
  const weightMatch = text.match(/(?:น้ำหนัก|weight)[^\d]*(\d+(?:\.\d+)?)/i) || text.match(/(\d+(?:\.\d+)?)\s*(?:กก|kg|กิโล)/i);
  if (weightMatch) { const v = parseFloat(weightMatch[1]); if (v >= 20 && v <= 300) return { type: 'weight', value_1: v, value_2: null, unit: 'kg', alert_level: 'pending' }; }
  return null;
}

function classifyBP(s, d) {
  if (s > 180 || d > 110) return 'urgent'; if (s > 140 || d > 90) return 'watch';
  if (s < 80 || d < 50) return 'urgent'; if (s < 90 || d < 60) return 'watch';
  return 'normal';
}
function classifySpO2(v) { return v < 92 ? 'urgent' : v < 95 ? 'watch' : 'normal'; }
function classifyTemp(v) { return v > 38 ? 'urgent' : v >= 37.5 ? 'watch' : v < 35.5 ? 'urgent' : v < 36 ? 'watch' : 'normal'; }
function classifyGlucose(v) { return v > 270 ? 'urgent' : v > 180 ? 'watch' : v < 54 ? 'urgent' : v < 70 ? 'watch' : 'normal'; }
function classifyWeightChange(c) { const a = Math.abs(c); return a >= 2 ? 'urgent' : a >= 1 ? 'watch' : 'normal'; }

// ============================================================
// HEALTH LOG SAVING + ALERTS
// ============================================================

async function saveHealthLog(patientId, reading, source = 'chat') {
  let weightChangeMsg = null;

  if (reading.type === 'weight') {
    const prev = await pool.query(
      `SELECT value_1, recorded_at FROM health_logs WHERE patient_id = $1 AND type = 'weight' AND confirmed = TRUE ORDER BY recorded_at DESC LIMIT 1`,
      [patientId]
    );

    if (prev.rows.length > 0) {
      const prevWeight = parseFloat(prev.rows[0].value_1);
      const change = reading.value_1 - prevWeight;
      const days = Math.round((Date.now() - new Date(prev.rows[0].recorded_at)) / 86400000);
      reading.alert_level = classifyWeightChange(change);
      reading.value_2 = parseFloat(change.toFixed(1));
      const dir = change > 0 ? '⬆️ เพิ่มขึ้น' : '⬇️ ลดลง';
      const dayLabel = days === 0 ? 'วันนี้' : days === 1 ? 'เมื่อวาน' : `${days} วันที่แล้ว`;
      weightChangeMsg = reading.alert_level === 'urgent'
        ? `${dir} ${Math.abs(change).toFixed(1)} กก จากครั้งก่อน (${dayLabel})\n⚠️ น้ำหนักเปลี่ยนแปลงมาก ควรพบแพทย์โดยเร็วนะครับ`
        : reading.alert_level === 'watch'
        ? `${dir} ${Math.abs(change).toFixed(1)} กก จากครั้งก่อน (${dayLabel})\nลุงจะคอยติดตามให้นะครับ`
        : `${dir} ${Math.abs(change).toFixed(1)} กก จากครั้งก่อน (${dayLabel}) — ปกติดีครับ`;
    } else {
      reading.alert_level = 'normal';
      weightChangeMsg = 'บันทึกน้ำหนักครั้งแรกแล้วครับ ลุงจะคอยติดตามให้ทุกวันนะครับ 📊';
    }

    // GLIM check
    const sixMoAgo = new Date(Date.now() - 180 * 86400000);
    const twelvesMoAgo = new Date(Date.now() - 365 * 86400000);
    const w6 = await pool.query(`SELECT value_1 FROM health_logs WHERE patient_id=$1 AND type='weight' AND confirmed=TRUE AND recorded_at>=$2 ORDER BY recorded_at ASC LIMIT 1`, [patientId, sixMoAgo]);
    if (w6.rows.length > 0) {
      const loss = ((parseFloat(w6.rows[0].value_1) - reading.value_1) / parseFloat(w6.rows[0].value_1)) * 100;
      if (loss >= 5) {
        weightChangeMsg += `\n\n📉 น้ำหนักลดลง ${loss.toFixed(1)}% ใน 6 เดือน\n⚠️ ควรพบแพทย์เพื่อตรวจประเมินนะครับ (GLIM criteria)`;
        if (reading.alert_level !== 'urgent') reading.alert_level = 'watch';
      }
    } else {
      const w12 = await pool.query(`SELECT value_1 FROM health_logs WHERE patient_id=$1 AND type='weight' AND confirmed=TRUE AND recorded_at>=$2 AND recorded_at<$3 ORDER BY recorded_at ASC LIMIT 1`, [patientId, twelvesMoAgo, sixMoAgo]);
      if (w12.rows.length > 0) {
        const loss = ((parseFloat(w12.rows[0].value_1) - reading.value_1) / parseFloat(w12.rows[0].value_1)) * 100;
        if (loss >= 10) {
          weightChangeMsg += `\n\n📉 น้ำหนักลดลง ${loss.toFixed(1)}% เกิน 6 เดือน\n⚠️ ควรพบแพทย์เพื่อตรวจประเมินนะครับ (GLIM criteria)`;
          if (reading.alert_level !== 'urgent') reading.alert_level = 'watch';
        }
      }
    }
  }

  const logResult = await pool.query(
    `INSERT INTO health_logs (patient_id, type, value_1, value_2, unit, alert_level, confirmed, source) VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7) RETURNING id`,
    [patientId, reading.type, reading.value_1, reading.value_2, reading.unit, reading.alert_level, source]
  );
  const logId = logResult.rows[0].id;
  console.log(`✅ Health log: ${reading.type} ${reading.value_1} [${reading.alert_level}]`);

  // Update real-time snapshot (non-blocking)
  updateSnapshot(patientId);

  if (reading.alert_level !== 'normal' && reading.alert_level !== 'pending') {
    const alertResult = await pool.query(
      `INSERT INTO alerts (health_log_id, patient_id, type, severity, guardian_notified) VALUES ($1,$2,$3,$4,FALSE) RETURNING id`,
      [logId, patientId, `${reading.alert_level}_${reading.type}`, reading.alert_level]
    );
    notifyGuardian(patientId, reading, alertResult.rows[0].id);
  }

  return { logId, alertLevel: reading.alert_level, weightChangeMsg };
}

// ============================================================
// GUARDIAN ALERT
// ============================================================

async function notifyGuardian(patientId, reading, alertId) {
  try {
    const result = await pool.query(
      `SELECT g.line_user_id, g.notification_level, p.display_name as patient_name
       FROM guardians g JOIN households h ON h.id=g.household_id JOIN patients p ON p.household_id=h.id
       WHERE p.id=$1 AND g.line_user_id IS NOT NULL`,
      [patientId]
    );
    if (result.rows.length === 0) return;
    const g = result.rows[0];
    if (g.notification_level === 'summary_only' || (g.notification_level === 'daily' && reading.alert_level === 'watch')) return;

    const patientLabel = g.patient_name ? `คุณ${g.patient_name}` : `ผู้ใช้ ...${patientId.slice(-6)}`;
    const emoji = reading.alert_level === 'urgent' ? '🚨' : '⚠️';
    const urgency = reading.alert_level === 'urgent' ? 'ค่าผิดปกติ — ควรพบแพทย์โดยเร็ว' : 'ค่าที่ควรติดตาม';

    let readingText = '';
    if (reading.type === 'bp') readingText = `ความดัน ${reading.value_1}/${reading.value_2} mmHg`;
    else if (reading.type === 'glucose') readingText = `น้ำตาล ${reading.value_1} mg/dL`;
    else if (reading.type === 'spo2') readingText = `ออกซิเจน ${reading.value_1}%`;
    else if (reading.type === 'temp') readingText = `อุณหภูมิ ${reading.value_1}°C`;
    else if (reading.type === 'weight') readingText = `น้ำหนัก ${reading.value_1} กก${reading.value_2 ? ` (${reading.value_2 > 0 ? '+' : ''}${reading.value_2} กก)` : ''}`;

    await client.pushMessage({ to: g.line_user_id, messages: [{ type: 'text',
      text: `${emoji} แจ้งเตือนจากลุงโน้ต\n${patientLabel}: ${readingText}\n${urgency}ครับ` }]});
    await pool.query(`UPDATE alerts SET guardian_notified=TRUE WHERE id=$1`, [alertId]);
    console.log(`📲 Guardian notified: ${reading.type} ${reading.alert_level}`);
  } catch (err) { console.error('Guardian notify failed:', err.message); }
}

// ============================================================
// PATIENT SNAPSHOT — real-time materialized view
// Called after every health log save and med log update.
// Dashboard reads this → always current, zero LLM cost, 1 DB query.
// ============================================================

async function updateSnapshot(patientId) {
  try {
    const bangkokDate = `(NOW() AT TIME ZONE 'Asia/Bangkok')::date`;

    // Run all 3 queries in parallel
    const [vitalsResult, medResult, alertResult] = await Promise.all([
      // Latest reading of each vital type today
      pool.query(
        `SELECT DISTINCT ON (type) type, value_1, value_2, unit, alert_level, recorded_at
         FROM health_logs
         WHERE patient_id=$1 AND confirmed=TRUE
         AND recorded_at::date = ${bangkokDate}
         ORDER BY type, recorded_at DESC`,
        [patientId]
      ),
      // Today's med adherence counts
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='taken')  AS taken,
           COUNT(*) FILTER (WHERE status='missed') AS missed,
           COUNT(*)                                 AS total
         FROM medication_logs
         WHERE patient_id=$1
         AND scheduled_at::date = ${bangkokDate}`,
        [patientId]
      ),
      // Urgent alert count today
      pool.query(
        `SELECT COUNT(*) AS count FROM alerts
         WHERE patient_id=$1 AND severity='urgent'
         AND fired_at::date = ${bangkokDate}`,
        [patientId]
      ),
    ]);

    // Build vitals JSONB keyed by type
    const vitals = {};
    for (const row of vitalsResult.rows) {
      vitals[row.type] = {
        v1: parseFloat(row.value_1),
        v2: row.value_2 ? parseFloat(row.value_2) : null,
        unit: row.unit,
        level: row.alert_level,
        at: row.recorded_at,
      };
    }

    const med = medResult.rows[0];
    const medsToday = {
      taken: parseInt(med.taken),
      missed: parseInt(med.missed),
      total: parseInt(med.total),
    };
    const urgentCount = parseInt(alertResult.rows[0].count);

    await pool.query(
      `INSERT INTO patient_snapshots
         (patient_id, vitals, meds_today, urgent_count, last_updated)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (patient_id) DO UPDATE SET
         vitals       = EXCLUDED.vitals,
         meds_today   = EXCLUDED.meds_today,
         urgent_count = EXCLUDED.urgent_count,
         last_updated = NOW()`,
      [patientId, JSON.stringify(vitals), JSON.stringify(medsToday), urgentCount]
    );

    console.log(`📸 Snapshot updated: patient ${patientId.slice(-6)}`);
  } catch (err) {
    // Non-blocking — snapshot failure must never break the main flow
    console.error('Snapshot update failed:', err.message);
  }
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function loadHistory(patientId) {
  const result = await pool.query(
    `SELECT role, content FROM conversation_history WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 10`,
    [patientId]
  );
  return result.rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function saveMessage(patientId, role, content, contentType = 'text') {
  await pool.query(
    `INSERT INTO conversation_history (patient_id, role, content_type, content) VALUES ($1,$2,$3,$4)`,
    [patientId, role, contentType, content]
  );
  await pool.query(
    `DELETE FROM conversation_history WHERE patient_id=$1 AND id NOT IN (SELECT id FROM conversation_history WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 20)`,
    [patientId]
  );
}

async function incrementQuota(patientId, type) {
  try { await pool.query(`SELECT increment_quota($1,$2)`, [patientId, type]); }
  catch (err) { console.error('Quota error:', err.message); }
}

// ============================================================
// MEDICATION SCHEDULER
// ============================================================

async function getMedicationsDue() {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 3600000);
  const hh = String(bkk.getUTCHours()).padStart(2, '0');
  const mm = String(bkk.getUTCMinutes()).padStart(2, '0');
  const result = await pool.query(
    `SELECT m.id as medication_id, m.name, m.dosage, p.id as patient_id, p.line_user_id, p.display_name
     FROM medications m JOIN patients p ON p.id=m.patient_id
     WHERE m.active=TRUE AND p.line_user_id IS NOT NULL AND $1=ANY(m.schedule)`,
    [`${hh}:${mm}`]
  );
  return result.rows;
}

cron.schedule('* * * * *', async () => {
  try {
    const meds = await getMedicationsDue();
    if (meds.length === 0) return;
    console.log(`⏰ ${meds.length} med(s) due`);
    for (const med of meds) {
      try {
        const name = med.display_name ? ` คุณ${med.display_name}` : '';
        await client.pushMessage({ to: med.line_user_id, messages: [{ type: 'text',
          text: `💊 ถึงเวลากินยาแล้ว${name}ครับ\nยา: ${med.name}${med.dosage ? ` ${med.dosage}` : ''}\nกินเสร็จแล้วตอบ "กินแล้ว" ให้ลุงทราบด้วยนะครับ 🙏` }]});
        await pool.query(`INSERT INTO medication_logs (medication_id, patient_id, status, scheduled_at) VALUES ($1,$2,'missed',$3)`, [med.medication_id, med.patient_id, new Date()]);
        console.log(`✅ Reminder: ${med.name} → ${med.line_user_id}`);
      } catch (err) { console.error(`❌ Reminder failed ${med.name}:`, err.message); }
    }
  } catch (err) { console.error('❌ Scheduler:', err.message); }
});
// ============================================================
// DAILY SUMMARY CRON — runs at 20:00 Bangkok (13:00 UTC)
// Pulls each patient's day, generates summary, saves to DB.
// Caregiver dashboard reads this → zero LLM cost per check.
// ============================================================

async function generateDailySummary(patientId, displayName) {
  const today = new Date();
  const bangkokToday = new Date(today.getTime() + 7 * 3600000);
  const dateStr = bangkokToday.toISOString().split('T')[0];

  // Already generated today?
  const existing = await pool.query(
    `SELECT id FROM daily_summaries WHERE patient_id=$1 AND summary_date=$2`,
    [patientId, dateStr]
  );
  if (existing.rows.length > 0) return;

  // Read directly from the real-time snapshot — no need to re-aggregate raw tables
  const snapResult = await pool.query(
    `SELECT vitals, meds_today, urgent_count FROM patient_snapshots WHERE patient_id=$1`,
    [patientId]
  );
  const snap = snapResult.rows[0];
  const vitals    = snap?.vitals    || {};
  const meds      = snap?.meds_today || { taken: 0, missed: 0, total: 0 };
  const urgentCount = snap?.urgent_count || 0;

  // Format vitals for the prompt
  const vitalsText = Object.entries(vitals).map(([type, v]) => {
    if (type === 'bp')      return `ความดัน ${v.v1}/${v.v2} mmHg [${v.level}]`;
    if (type === 'glucose') return `น้ำตาล ${v.v1} mg/dL [${v.level}]`;
    if (type === 'spo2')    return `ออกซิเจน ${v.v1}% [${v.level}]`;
    if (type === 'temp')    return `อุณหภูมิ ${v.v1}°C [${v.level}]`;
    if (type === 'weight')  return `น้ำหนัก ${v.v1} กก${v.v2 ? ` (${v.v2 > 0 ? '+' : ''}${v.v2} กก)` : ''} [${v.level}]`;
    return `${type} ${v.v1}`;
  }).join(', ') || 'ไม่มีการบันทึกค่าสุขภาพวันนี้';

  const medsText = meds.total > 0
    ? `กิน ${meds.taken}/${meds.total} ครั้ง${meds.missed > 0 ? ` (ลืม ${meds.missed} ครั้ง)` : ''}`
    : 'ไม่มีรายการยาวันนี้';

  const alertsText = urgentCount > 0
    ? `มีการแจ้งเตือนเร่งด่วน ${urgentCount} รายการ`
    : 'ไม่มีการแจ้งเตือน';

  const prompt = `สรุปสุขภาพประจำวันของ ${displayName || 'ผู้ป่วย'} วันที่ ${dateStr}:
ค่าสุขภาพ: ${vitalsText}
ยา: ${medsText}
การแจ้งเตือน: ${alertsText}

เขียนสรุปสั้น ๆ 2-3 ประโยค ภาษาไทย อบอุ่น ตรงประเด็น ไม่วินิจฉัยโรค ถ้ามีค่าผิดปกติให้แนะนำพบแพทย์`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  const summary = response.content.find(b => b.type === 'text')?.text
    ?? 'ไม่มีข้อมูลเพียงพอในการสรุปวันนี้ครับ';

  await pool.query(
    `INSERT INTO daily_summaries (patient_id, summary_date, summary_text)
     VALUES ($1, $2, $3)
     ON CONFLICT (patient_id, summary_date) DO UPDATE SET summary_text=$3, generated_at=NOW()`,
    [patientId, dateStr, summary]
  );

  console.log(`📋 Daily summary saved for patient ${patientId}`);
}

cron.schedule('0 13 * * *', async () => {
  // 13:00 UTC = 20:00 Bangkok
  console.log('📋 Running daily summary generation...');
  try {
    const patients = await pool.query(
      `SELECT id, display_name FROM patients WHERE line_user_id IS NOT NULL`
    );
    for (const p of patients.rows) {
      try { await generateDailySummary(p.id, p.display_name); }
      catch (err) { console.error(`❌ Summary failed for ${p.id}:`, err.message); }
    }
    console.log(`📋 Daily summaries done for ${patients.rows.length} patients`);
  } catch (err) { console.error('❌ Daily summary cron:', err.message); }
});

// ============================================================
// MISSED DOSE FOLLOW-UP
// Runs every 5 minutes. Checks for reminders that fired 30 min
// ago with no response → sends one follow-up push.
// At 60 min with no response → marks missed, notifies guardian.
// ============================================================

cron.schedule('*/5 * * * *', async () => {
  try {
    const now = new Date();

    // --- 30 min follow-up: still 'missed', no follow-up sent yet ---
    const needsFollowUp = await pool.query(
      `SELECT ml.id, ml.medication_id, ml.patient_id, ml.scheduled_at,
              m.name, m.dosage,
              p.line_user_id, p.display_name
       FROM medication_logs ml
       JOIN medications m ON m.id = ml.medication_id
       JOIN patients p ON p.id = ml.patient_id
       WHERE ml.status = 'missed'
       AND ml.followup_sent = FALSE
       AND ml.scheduled_at <= NOW() - INTERVAL '30 minutes'
       AND ml.scheduled_at >= NOW() - INTERVAL '55 minutes'
       AND p.line_user_id IS NOT NULL`,
      []
    );

    for (const row of needsFollowUp.rows) {
      try {
        const name = row.display_name ? ` คุณ${row.display_name}` : '';
        await client.pushMessage({
          to: row.line_user_id,
          messages: [{ type: 'text',
            text: `🔔 ลุงโน้ตเป็นห่วงนะครับ${name}\nยัง${row.name}${row.dosage ? ` ${row.dosage}` : ''} ยังไม่ได้กินใช่ไหมครับ?\nถ้ากินแล้วตอบ "กินแล้ว" ได้เลยครับ 💊` }],
        });
        await pool.query(
          `UPDATE medication_logs SET followup_sent=TRUE WHERE id=$1`,
          [row.id]
        );
        console.log(`🔔 Follow-up sent: ${row.name} → ${row.line_user_id}`);
      } catch (err) { console.error(`❌ Follow-up failed:`, err.message); }
    }

    // --- 60 min: still missed → notify guardian ---
    const confirmedMissed = await pool.query(
      `SELECT ml.id, ml.medication_id, ml.patient_id, ml.scheduled_at,
              m.name, m.dosage,
              p.line_user_id, p.display_name
       FROM medication_logs ml
       JOIN medications m ON m.id = ml.medication_id
       JOIN patients p ON p.id = ml.patient_id
       WHERE ml.status = 'missed'
       AND ml.followup_sent = TRUE
       AND ml.guardian_notified = FALSE
       AND ml.scheduled_at <= NOW() - INTERVAL '60 minutes'
       AND ml.scheduled_at >= NOW() - INTERVAL '23 hours'
       AND p.line_user_id IS NOT NULL`,
      []
    );

    for (const row of confirmedMissed.rows) {
      try {
        // Notify guardian if one exists
        const guardian = await pool.query(
          `SELECT g.line_user_id, g.notification_level
           FROM guardians g
           JOIN households h ON h.id = g.household_id
           JOIN patients p ON p.household_id = h.id
           WHERE p.id = $1 AND g.line_user_id IS NOT NULL`,
          [row.patient_id]
        );

        if (guardian.rows.length > 0 && guardian.rows[0].notification_level !== 'summary_only') {
          const patientLabel = row.display_name ? `คุณ${row.display_name}` : `ผู้ใช้ ...${row.patient_id.slice(-6)}`;
          await client.pushMessage({
            to: guardian.rows[0].line_user_id,
            messages: [{ type: 'text',
              text: `⚠️ แจ้งเตือนจากลุงโน้ต\n${patientLabel} ยังไม่ได้กิน${row.name}${row.dosage ? ` ${row.dosage}` : ''} ครับ\n(กำหนดเวลา ${new Date(new Date(row.scheduled_at).getTime() + 7*3600000).toLocaleTimeString('th-TH', {hour:'2-digit',minute:'2-digit'})} น.)` }],
          });
          console.log(`📲 Missed dose guardian notified: ${row.name}`);
        }

        await pool.query(
          `UPDATE medication_logs SET guardian_notified=TRUE WHERE id=$1`,
          [row.id]
        );
      } catch (err) { console.error(`❌ Missed dose notify failed:`, err.message); }
    }

  } catch (err) { console.error('❌ Follow-up cron:', err.message); }
});

console.log('🔔 Missed dose follow-up cron started (every 5 min)');

// ============================================================
// REFILL REMINDER CRON — runs daily at 09:00 Bangkok (02:00 UTC)
// Fires when pills_remaining <= refill_alert_at
// ============================================================

cron.schedule('0 2 * * *', async () => {
  // 02:00 UTC = 09:00 Bangkok
  console.log('💊 Checking refill reminders...');
  try {
    const lowMeds = await pool.query(
      `SELECT m.id, m.name, m.dosage, m.pills_remaining, m.refill_alert_at,
              p.id as patient_id, p.line_user_id, p.display_name,
              r.id as reminder_id
       FROM medications m
       JOIN patients p ON p.id = m.patient_id
       LEFT JOIN refill_reminders r
         ON r.medication_id = m.id AND r.sent = TRUE
         AND r.sent_at > NOW() - INTERVAL '7 days'
       WHERE m.active = TRUE
       AND m.pills_remaining IS NOT NULL
       AND m.pills_remaining <= m.refill_alert_at
       AND p.line_user_id IS NOT NULL
       AND r.id IS NULL`,
      []
    );

    console.log(`💊 ${lowMeds.rows.length} refill(s) needed`);

    for (const med of lowMeds.rows) {
      try {
        const name = med.display_name ? ` คุณ${med.display_name}` : '';
        const doseResult = await pool.query(
          `SELECT array_length(schedule,1) as doses FROM medications WHERE id=$1`, [med.id]
        );
        const dosesPerDay = doseResult.rows[0]?.doses || 1;
        const daysLeft = Math.floor(med.pills_remaining / dosesPerDay);

        await client.pushMessage({
          to: med.line_user_id,
          messages: [{ type: 'text',
            text: `⚠️ ยา${med.name}${med.dosage ? ` ${med.dosage}` : ''} ใกล้หมดแล้วครับ${name}\nเหลืออยู่ประมาณ ${daysLeft} วันครับ\nอย่าลืมขอยาเพิ่มจากแพทย์ด้วยนะครับ 🏥` }],
        });

        // Log reminder sent
        await pool.query(
          `INSERT INTO refill_reminders (medication_id, sent, sent_at) VALUES ($1, TRUE, NOW())`,
          [med.id]
        );

        // Also notify guardian
        const guardian = await pool.query(
          `SELECT g.line_user_id FROM guardians g
           JOIN households h ON h.id=g.household_id
           JOIN patients p ON p.household_id=h.id
           WHERE p.id=$1 AND g.line_user_id IS NOT NULL`,
          [med.patient_id]
        );
        if (guardian.rows.length > 0) {
          const patientLabel = med.display_name ? `คุณ${med.display_name}` : `ผู้ใช้ ...${med.patient_id.slice(-6)}`;
          await client.pushMessage({
            to: guardian.rows[0].line_user_id,
            messages: [{ type: 'text',
              text: `⚠️ แจ้งเตือนจากลุงโน้ต\nยา${med.name} ของ${patientLabel}ใกล้หมดแล้วครับ (เหลือ ~${daysLeft} วัน)\nช่วยพา${patientLabel}ไปขอยาเพิ่มด้วยนะครับ 🏥` }],
          });
        }

        console.log(`✅ Refill reminder sent: ${med.name} → ${med.line_user_id}`);
      } catch (err) { console.error(`❌ Refill reminder failed:`, err.message); }
    }
  } catch (err) { console.error('❌ Refill cron:', err.message); }
});

console.log('💊 Refill reminder cron scheduled (09:00 Bangkok)');

// ============================================================
// APPOINTMENT REMINDER CRON — runs every hour
// Checks for appointments in the next 48h and 24h
// Pushes to patient + guardian
// ============================================================

cron.schedule('0 * * * *', async () => {
  console.log('📅 Checking appointment reminders...');
  try {
    const now = new Date();
    const bangkokNow = new Date(now.getTime() + 7 * 3600000);

    // Find appointments needing 48h reminder
    const need48h = await pool.query(
      `SELECT a.id, a.title, a.appointment_at, a.patient_id,
              p.line_user_id, p.display_name
       FROM appointment_reminders a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.reminder_48h_sent = FALSE
       AND a.appointment_at > NOW()
       AND a.appointment_at <= NOW() + INTERVAL '49 hours'
       AND a.appointment_at > NOW() + INTERVAL '23 hours'
       AND p.line_user_id IS NOT NULL`,
      []
    );

    for (const appt of need48h.rows) {
      try {
        const apptTime = new Date(new Date(appt.appointment_at).getTime() + 7 * 3600000);
        const timeStr = apptTime.toLocaleString('th-TH', {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        const name = appt.display_name ? ` คุณ${appt.display_name}` : '';

        await client.pushMessage({
          to: appt.line_user_id,
          messages: [{ type: 'text',
            text: `📅 แจ้งเตือนนัดแพทย์${name}ครับ\n${appt.title}\n🕐 ${timeStr}\n\nอีก 2 วันแล้วนะครับ อย่าลืมเตรียมตัวด้วยนะครับ 😊` }],
        });

        await notifyGuardianAppt(appt, 48);
        await pool.query(
          `UPDATE appointment_reminders SET reminder_48h_sent=TRUE WHERE id=$1`,
          [appt.id]
        );
        console.log(`📅 48h reminder sent: ${appt.title}`);
      } catch (err) { console.error('❌ 48h reminder failed:', err.message); }
    }

    // Find appointments needing 24h reminder
    const need24h = await pool.query(
      `SELECT a.id, a.title, a.appointment_at, a.patient_id,
              p.line_user_id, p.display_name
       FROM appointment_reminders a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.reminder_24h_sent = FALSE
       AND a.appointment_at > NOW()
       AND a.appointment_at <= NOW() + INTERVAL '25 hours'
       AND a.appointment_at > NOW() + INTERVAL '1 hour'
       AND p.line_user_id IS NOT NULL`,
      []
    );

    for (const appt of need24h.rows) {
      try {
        const apptTime = new Date(new Date(appt.appointment_at).getTime() + 7 * 3600000);
        const timeStr = apptTime.toLocaleString('th-TH', {
          weekday: 'long', hour: '2-digit', minute: '2-digit',
        });
        const name = appt.display_name ? ` คุณ${appt.display_name}` : '';

        await client.pushMessage({
          to: appt.line_user_id,
          messages: [{ type: 'text',
            text: `📅 แจ้งเตือนนัดแพทย์${name}ครับ\n${appt.title}\n🕐 พรุ่งนี้ ${timeStr}\n\nอย่าลืมนะครับ 🏥 และอย่าลืมนำบัตรประชาชน + ประวัติยาไปด้วยครับ` }],
        });

        await notifyGuardianAppt(appt, 24);
        await pool.query(
          `UPDATE appointment_reminders SET reminder_24h_sent=TRUE WHERE id=$1`,
          [appt.id]
        );
        console.log(`📅 24h reminder sent: ${appt.title}`);
      } catch (err) { console.error('❌ 24h reminder failed:', err.message); }
    }

  } catch (err) { console.error('❌ Appointment cron:', err.message); }
});

async function notifyGuardianAppt(appt, hours) {
  try {
    const guardian = await pool.query(
      `SELECT g.line_user_id FROM guardians g
       JOIN households h ON h.id=g.household_id
       JOIN patients p ON p.household_id=h.id
       WHERE p.id=$1 AND g.line_user_id IS NOT NULL`,
      [appt.patient_id]
    );
    if (guardian.rows.length === 0) return;

    const apptTime = new Date(new Date(appt.appointment_at).getTime() + 7 * 3600000);
    const timeStr = apptTime.toLocaleString('th-TH', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const patientLabel = appt.display_name ? `คุณ${appt.display_name}` : 'ผู้ที่คุณดูแล';

    await client.pushMessage({
      to: guardian.rows[0].line_user_id,
      messages: [{ type: 'text',
        text: `📅 แจ้งเตือนจากลุงโน้ต\n${patientLabel} มีนัดแพทย์ใน ${hours} ชั่วโมงครับ\n${appt.title}\n🕐 ${timeStr}` }],
    });
  } catch (err) { console.error('❌ Guardian appt notify:', err.message); }
}

console.log('📅 Appointment reminder cron scheduled (every hour)');

// ============================================================
// CAREGIVER DASHBOARD — Flex Message card
// Served from DB → zero LLM cost per check
// ============================================================

async function buildDashboardCard(guardianLineUserId) {
  // Get all patients this guardian oversees
  const patients = await pool.query(
    `SELECT p.id, p.display_name
     FROM patients p
     JOIN households h ON h.id = p.household_id
     JOIN guardians g ON g.household_id = h.id
     WHERE g.line_user_id = $1`,
    [guardianLineUserId]
  );
  if (patients.rows.length === 0) return null;

  const bangkokToday = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
  const bubbles = [];

  for (const patient of patients.rows) {
    const name = patient.display_name || 'ผู้ป่วย';

    // ── Single query: snapshot + today's prose summary ──────
    const [snapResult, summaryResult] = await Promise.all([
      pool.query(
        `SELECT vitals, meds_today, urgent_count, last_updated
         FROM patient_snapshots WHERE patient_id=$1`,
        [patient.id]
      ),
      pool.query(
        `SELECT summary_text, generated_at FROM daily_summaries
         WHERE patient_id=$1 AND summary_date=$2`,
        [patient.id, bangkokToday]
      ),
    ]);

    const snap = snapResult.rows[0];
    const vitals = snap?.vitals || {};
    const meds   = snap?.meds_today || { taken: 0, missed: 0, total: 0 };
    const urgentCount = snap?.urgent_count || 0;
    const lastUpdated = snap?.last_updated
      ? new Date(new Date(snap.last_updated).getTime() + 7 * 3600000)
          .toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
      : null;

    const headerColor = urgentCount > 0 ? '#FF4444' : '#06C755';
    const headerText  = urgentCount > 0 ? `🚨 ${name} — มีการแจ้งเตือน` : `✅ ${name}`;

    // Build vital rows from snapshot JSONB
    const VITAL_LABELS = { bp: 'ความดัน', glucose: 'น้ำตาล', spo2: 'ออกซิเจน', temp: 'อุณหภูมิ', weight: 'น้ำหนัก' };
    const vitalRows = Object.entries(vitals).map(([type, v]) => {
      const alertIcon = v.level === 'urgent' ? ' 🚨' : v.level === 'watch' ? ' ⚠️' : '';
      let value = '';
      if (type === 'bp')      value = `${v.v1}/${v.v2} mmHg${alertIcon}`;
      else if (type === 'glucose') value = `${v.v1} mg/dL${alertIcon}`;
      else if (type === 'spo2')    value = `${v.v1}%${alertIcon}`;
      else if (type === 'temp')    value = `${v.v1}°C${alertIcon}`;
      else if (type === 'weight')  value = `${v.v1} กก${v.v2 ? ` (${v.v2 > 0 ? '+' : ''}${v.v2})` : ''}${alertIcon}`;
      return {
        type: 'box', layout: 'horizontal',
        contents: [
          { type: 'text', text: VITAL_LABELS[type] || type, size: 'sm', color: '#888888', flex: 2 },
          { type: 'text', text: value, size: 'sm', color: '#1a1a1a', flex: 3, align: 'end', wrap: true },
        ],
        paddingTop: '6px', paddingBottom: '6px',
      };
    });

    const medRow = {
      type: 'box', layout: 'horizontal',
      contents: [
        { type: 'text', text: 'ยา', size: 'sm', color: '#888888', flex: 2 },
        { type: 'text',
          text: meds.total > 0 ? `กิน ${meds.taken}/${meds.total} ครั้ง` : 'ไม่มียาวันนี้',
          size: 'sm', color: meds.missed > 0 ? '#FF6B35' : '#1a1a1a', flex: 3, align: 'end' },
      ],
      paddingTop: '6px', paddingBottom: '6px',
    };

    const summaryText = summaryResult.rows.length > 0
      ? summaryResult.rows[0].summary_text
      : 'ยังไม่มีสรุปวันนี้ครับ (จะสรุปเวลา 20:00 น.)';
    const summaryTime = summaryResult.rows.length > 0
      ? new Date(new Date(summaryResult.rows[0].generated_at).getTime() + 7 * 3600000)
          .toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
      : null;

    bubbles.push({
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: headerText, weight: 'bold', size: 'md', color: '#ffffff' }],
        backgroundColor: headerColor, paddingAll: '14px',
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'none',
        contents: [
          ...(vitalRows.length > 0 ? [
            { type: 'text', text: '📊 ค่าสุขภาพวันนี้', size: 'xs', color: '#888888', weight: 'bold', margin: 'none' },
            ...vitalRows,
            { type: 'separator', margin: 'md' },
          ] : [
            { type: 'text', text: 'ยังไม่มีค่าสุขภาพวันนี้', size: 'sm', color: '#999999' },
            { type: 'separator', margin: 'md' },
          ]),
          medRow,
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '💬 สรุปวันนี้', size: 'xs', color: '#888888', weight: 'bold', margin: 'md' },
          { type: 'text', text: summaryText, size: 'sm', color: '#333333', wrap: true, margin: 'sm' },
          ...(summaryTime ? [{ type: 'text', text: `สรุปเมื่อ ${summaryTime} น.`, size: 'xs', color: '#bbbbbb', margin: 'sm' }] : []),
          ...(lastUpdated ? [{ type: 'text', text: `ข้อมูลล่าสุด ${lastUpdated} น.`, size: 'xs', color: '#bbbbbb', margin: 'xs' }] : []),
        ],
        paddingAll: '12px',
      },
    });
  }

  if (bubbles.length === 1) {
    return { type: 'flex', altText: 'แดชบอร์ดสุขภาพ', contents: bubbles[0] };
  }
  return { type: 'flex', altText: 'แดชบอร์ดสุขภาพ', contents: { type: 'carousel', contents: bubbles } };
}

// ============================================================
// CAREGIVER DASHBOARD — Flex Message card

async function isGuardian(lineUserId) {
  const result = await pool.query(
    `SELECT id FROM guardians WHERE line_user_id=$1`, [lineUserId]
  );
  return result.rows.length > 0;
}

// ============================================================
// GUARDIAN INVITE LINK SYSTEM
// ============================================================

// Generate a cryptographically random token
function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let token = '';
  for (let i = 0; i < 24; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// Create invite for a guardian — one token per patient slot
async function createInviteLink(guardianLineUserId, patientName) {
  // Ensure guardian record exists
  const guardianResult = await pool.query(
    `SELECT g.id, g.household_id FROM guardians g WHERE g.line_user_id=$1`,
    [guardianLineUserId]
  );
  if (guardianResult.rows.length === 0) {
    throw new Error('Guardian record not found');
  }

  const { id: guardianId, household_id: householdId } = guardianResult.rows[0];

  // Create a new patient record (placeholder — filled when patient taps link)
  const patientResult = await pool.query(
    `INSERT INTO patients (household_id, display_name, care_mode, onboarding_state)
     VALUES ($1, $2, 'family', 'pending_invite')
     RETURNING id`,
    [householdId, patientName || null]
  );
  const patientId = patientResult.rows[0].id;

  // Generate one-time token valid for 24h
  const token = generateToken();
  await pool.query(
    `INSERT INTO invite_tokens (patient_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '24 hours')`,
    [patientId, token]
  );

  // LINE deep link — when tapped, opens LINE chat with bot
  // and auto-sends the token as a message
  const botId = process.env.LINE_BOT_ID || '';
  const deepLink = botId
    ? `https://line.me/R/oaMessage/${botId}/?INVITE_${token}`
    : `https://line.me/ti/p/@lungnote`; // fallback

  return { token, deepLink, patientId, patientName };
}

// Handle invite token sent by patient clicking the link
async function handleInviteToken(lineUserId, token) {
  // Look up the token
  const tokenResult = await pool.query(
    `SELECT it.patient_id, it.used, it.expires_at, p.display_name, p.household_id
     FROM invite_tokens it
     JOIN patients p ON p.id = it.patient_id
     WHERE it.token = $1`,
    [token]
  );

  if (tokenResult.rows.length === 0) {
    return { success: false, reason: 'not_found' };
  }

  const row = tokenResult.rows[0];

  if (row.used) return { success: false, reason: 'used' };
  if (new Date(row.expires_at) < new Date()) return { success: false, reason: 'expired' };

  // Check if this LINE user already has a patient record
  const existingPatient = await pool.query(
    `SELECT id FROM patients WHERE line_user_id=$1`, [lineUserId]
  );
  if (existingPatient.rows.length > 0) {
    return { success: false, reason: 'already_linked' };
  }

  // Link this LINE user to the placeholder patient record
  await pool.query(
    `UPDATE patients
     SET line_user_id=$1, onboarding_state='complete', consented=TRUE, consent_at=NOW()
     WHERE id=$2`,
    [lineUserId, row.patient_id]
  );

  // Mark token as used
  await pool.query(
    `UPDATE invite_tokens SET used=TRUE WHERE token=$1`, [token]
  );

  // Create a trial subscription for this patient
  await pool.query(
    `INSERT INTO patient_trials (patient_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [row.patient_id]
  );

  // Notify the guardian
  const guardianResult = await pool.query(
    `SELECT g.line_user_id, g.display_name FROM guardians g
     WHERE g.household_id=$1`, [row.household_id]
  );

  if (guardianResult.rows.length > 0) {
    const guardianName = guardianResult.rows[0].display_name || '';
    const patientLabel = row.display_name || 'ท่าน';
    await client.pushMessage({
      to: guardianResult.rows[0].line_user_id,
      messages: [{ type: 'text',
        text: `✅ คุณ${patientLabel}เชื่อมต่อกับลุงโน้ตแล้วครับ!\nลุงพร้อมดูแลและส่งรายงานให้คุณ${guardianName}แล้วนะครับ 😊` }],
    });
  }

  return {
    success: true,
    patientName: row.display_name,
    householdId: row.household_id,
  };
}

// Build invite Flex Message card for guardian
function buildInviteCard(deepLink, patientName, expiresIn = '24 ชั่วโมง') {
  return {
    type: 'flex',
    altText: `ลิงก์เชิญสำหรับ${patientName || 'ผู้ที่คุณดูแล'}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'text', text: '🔗 ลิงก์เชิญลุงโน้ต', weight: 'bold', size: 'md', color: '#ffffff' }],
        backgroundColor: '#06C755', paddingAll: '14px',
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: `สำหรับ: ${patientName || 'ผู้ที่คุณดูแล'}`, size: 'sm', color: '#333333', weight: 'bold' },
          { type: 'text', text: 'ส่งลิงก์นี้ให้ท่านกดเพื่อเชื่อมต่อกับลุงโน้ตครับ', size: 'sm', color: '#666666', wrap: true },
          { type: 'text', text: `⏰ หมดอายุใน ${expiresIn}`, size: 'xs', color: '#ff6b35' },
          { type: 'text', text: '🔒 ใช้ได้ครั้งเดียว — ปลอดภัยครับ', size: 'xs', color: '#999999' },
        ],
        paddingAll: '14px',
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button',
          action: { type: 'uri', label: '📤 ส่งให้ท่านทาง LINE', uri: deepLink },
          style: 'primary', color: '#06C755',
        }],
        paddingAll: '12px',
      },
    },
  };
}


// ============================================================
// FOLLOW EVENT — fires when user adds the bot
// ============================================================

async function handleFollow(event) {
  const lineUserId = event.source.userId;
  // Create patient record in 'new' state if not exists
  const patient = await getOrCreatePatient(lineUserId);
  // Send bilingual welcome + language picker via push
  // (follow events don't have a replyToken in all LINE environments,
  //  so we use pushMessage to be safe)
  await client.pushMessage({
    to: lineUserId,
    messages: [buildQuickReply(
      S('th', 'welcome_ask_lang'),
      [{ label: '🇹🇭 ภาษาไทย', text: 'ภาษาไทย' }, { label: '🇬🇧 English', text: 'English' }]
    )],
  });
  // Advance state so the next message (language choice) is handled correctly
  if (patient.onboarding_state === 'new') {
    await setOnboardingState(patient.id, 'asking_language');
  }
  console.log(`👋 Follow event: ${lineUserId}`);
}

// ============================================================
// WEBHOOK + EVENT ROUTING
// ============================================================

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try { await handleEvent(event); }
    catch (err) { console.error('Event error:', err); }
  }
});

async function handleEvent(event) {
  // ── Follow event: user adds the bot ───────────────────────
  if (event.type === 'follow') {
    await handleFollow(event);
    return;
  }

  if (event.type !== 'message') return;
  const lineUserId = event.source.userId;
  const patient = await getOrCreatePatient(lineUserId);
  const patientId = patient.id;

  // Reset command works at any point — check before onboarding routing
  if (event.message.type === 'text' && event.message.text?.trim() === 'RESET_LUNGNOTE_DEV') {
    await handleTextMessage(event, patientId);
    return;
  }

  // Onboarding routing
  if (needsOnboarding(patient)) {
    if (event.message.type === 'image' && (patient.onboarding_state === 'asking_more_meds' || patient.onboarding_state === 'guardian_asking_more_meds')) {
      await handleImageDuringOnboarding(event, patient);
    } else if (event.message.type === 'text') {
      await handleOnboarding(event, patient);
    }
    return;
  }

  if (event.message.type === 'text') await handleTextMessage(event, patientId);
  else if (event.message.type === 'image') await handleImageMessage(event, patientId);
  else {
    const l = lang(patient);
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: S(l, 'unsupported_msg') }]});
  }
}

// ============================================================
// APPOINTMENT SLIP PHOTO HANDLER
// Called when image arrives and context suggests appointment
// ============================================================

async function handleAppointmentSlipPhoto(imageBase64, patientId, replyToken) {
  const today = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
      { type: 'text', text:
        `Today is ${today} (Bangkok). This is a hospital/clinic appointment slip. Extract the appointment info.\nReply ONLY valid JSON: {"title":"hospital or department name","datetime":"YYYY-MM-DDTHH:MM:00","notes":"any other info"}\nIf date/time not found use null.` },
    ]}],
  });

  const raw = response.content.find(b => b.type === 'text')?.text ?? '';
  try {
    const jm = raw.match(/\{[\s\S]*\}/);
    if (!jm) return null;
    const parsed = JSON.parse(jm[0]);
    if (!parsed.title || !parsed.datetime) return null;

    const apptDate = new Date(new Date(parsed.datetime).getTime() - 7 * 3600000);
    if (isNaN(apptDate.getTime()) || apptDate < new Date()) return null;

    const title = parsed.notes ? `${parsed.title} (${parsed.notes})` : parsed.title;
    await pool.query(
      `INSERT INTO appointment_reminders (patient_id, title, appointment_at) VALUES ($1,$2,$3)`,
      [patientId, title, apptDate]
    );
    return { title, datetime: new Date(parsed.datetime) };
  } catch (e) { return null; }
}

// ============================================================
// TEXT MESSAGE HANDLER
// ============================================================

// APPT_TRIGGERS kept for image context detection in handleImageMessage
const APPT_TRIGGERS = ['นัดหมอ','นัดแพทย์','นัด รพ','นัดโรงพยาบาล','นัดคลินิก','จำนัด','บันทึกนัด'];

// Parse appointment date/time from Thai natural language
async function parseAndSaveAppointment(patientId, text) {
  // Ask Haiku to extract date + title from the message
  const today = new Date(Date.now() + 7 * 3600000).toISOString().split('T')[0];
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{ role: 'user', content:
      `Today is ${today} (Bangkok time). User said: "${text}"\nExtract appointment info. Reply ONLY valid JSON, no other text:\n{"title":"appointment name/place","datetime":"YYYY-MM-DDTHH:MM:00"}\nIf date/time unclear, use null for datetime.`,
    }],
  });

  const raw = response.content.find(b => b.type === 'text')?.text ?? '';
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.datetime) return null;

    // Convert Bangkok time to UTC for storage
    const apptDate = new Date(new Date(parsed.datetime).getTime() - 7 * 3600000);
    if (isNaN(apptDate.getTime()) || apptDate < new Date()) return null;

    await pool.query(
      `INSERT INTO appointment_reminders (patient_id, title, appointment_at)
       VALUES ($1, $2, $3)`,
      [patientId, parsed.title, apptDate]
    );

    return {
      title: parsed.title,
      datetime: new Date(parsed.datetime),
    };
  } catch (e) { return null; }
}

async function handleTextMessage(event, patientId) {
  const userMessage = event.message.text;
  const lineUserId = event.source.userId;

  // ── Dev reset (always check first, no LLM cost) ───────────
  if (userMessage === 'RESET_LUNGNOTE_DEV') {
    try {
      const hResult = await pool.query(`SELECT household_id FROM patients WHERE id=$1`, [patientId]);
      const hid = hResult.rows[0]?.household_id;
      await pool.query(`DELETE FROM medications WHERE patient_id=$1`, [patientId]);
      await pool.query(`DELETE FROM conversation_history WHERE patient_id=$1`, [patientId]);
      await pool.query(`DELETE FROM medication_logs WHERE patient_id=$1`, [patientId]);
      await pool.query(`DELETE FROM health_logs WHERE patient_id=$1`, [patientId]);
      await pool.query(`DELETE FROM alerts WHERE patient_id=$1`, [patientId]);
      await pool.query(`DELETE FROM appointment_reminders WHERE patient_id=$1`, [patientId]);
      await pool.query(`DELETE FROM invite_tokens WHERE patient_id=$1`, [patientId]);
      if (hid) await pool.query(`DELETE FROM guardians WHERE household_id=$1`, [hid]);
      await pool.query(
        `UPDATE patients SET onboarding_state='new', display_name=NULL, conditions=NULL,
         pending_med_name=NULL, pending_med_dosage=NULL WHERE id=$1`, [patientId]
      );
      medCache.delete(patientId);
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
        text: '🔄 รีเซ็ตบัญชีเรียบร้อยแล้วครับ ส่งข้อความใดก็ได้เพื่อเริ่ม onboarding ใหม่ครับ' }]});
    } catch (err) {
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
        text: `❌ Reset failed: ${err.message}` }]});
    }
    return;
  }

  // ── Invite token (always check before LLM — exact prefix match) ──
  if (userMessage.startsWith('INVITE_')) {
    const token = userMessage.replace('INVITE_', '').trim();
    const result = await handleInviteToken(lineUserId, token);
    // Language unknown at this point — use 'th' default, patient will set it in onboarding
    const inviteLang = 'th';
    let msg;
    if (result.success)                msg = S(inviteLang, 'invite_welcome', result.patientName);
    else if (result.reason === 'used') msg = S(inviteLang, 'invite_used');
    else if (result.reason === 'expired') msg = S(inviteLang, 'invite_expired');
    else if (result.reason === 'already_linked') msg = S(inviteLang, 'invite_linked');
    else msg = S(inviteLang, 'invite_invalid');
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: msg }]});
    return;
  }

  // ── Master intent router — one Haiku call routes everything ──
  const guardianUser = await isGuardian(lineUserId);
  const { intent, entities } = await routeIntent(userMessage, guardianUser);

  // ── send_invite ────────────────────────────────────────────
  if (intent === 'send_invite' && guardianUser) {
    const nameMatch = userMessage.match(/(?:เชิญ|เพิ่ม)(?:คุณพ่อ|คุณแม่|พ่อ|แม่|ผู้ป่วย|สมาชิก)?\s*(.{1,20})?/);
    const patientName = nameMatch?.[1]?.trim() || null;
    try {
      const { deepLink } = await createInviteLink(lineUserId, patientName);
      const card = buildInviteCard(deepLink, patientName);
      await client.replyMessage({ replyToken: event.replyToken, messages: [
        card,
        { type: 'text', text: 'กดปุ่มด้านบนเพื่อส่งลิงก์ให้ท่านทาง LINE ได้เลยครับ\nเมื่อท่านกดลิงก์และเปิด LINE ลุงจะแจ้งให้คุณทราบทันทีครับ 😊' },
      ]});
    } catch (err) {
      console.error('Invite creation failed:', err.message);
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
        text: 'ขอโทษครับ เกิดข้อผิดพลาด ลองใหม่อีกครั้งได้ไหมครับ?' }]});
    }
    return;
  }

  // ── check_patient (guardian dashboard) ────────────────────
  if (intent === 'check_patient' && guardianUser) {
    const card = await buildDashboardCard(lineUserId);
    if (card) {
      await client.replyMessage({ replyToken: event.replyToken, messages: [card] });
      return;
    }
    // No data yet — fall through to Claude for a natural reply
  }

  // ── check_med_list ─────────────────────────────────────────
  if (intent === 'check_med_list') {
    const card = await buildMedCard(patientId, '💊 รายการยาของคุณ');
    await client.replyMessage({ replyToken: event.replyToken, messages: [card] });
    await incrementQuota(patientId, 'message');
    return;
  }

  // ── book_appointment ───────────────────────────────────────
  if (intent === 'book_appointment') {
    const appt = await parseAndSaveAppointment(patientId, userMessage);
    if (appt) {
      const timeStr = appt.datetime.toLocaleString('th-TH', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
        text: `📅 จดนัดไว้แล้วครับ\n${appt.title}\n🕐 ${timeStr}\n\nลุงจะเตือน 48 ชั่วโมงและ 24 ชั่วโมงก่อนถึงนัดนะครับ 😊` }]});
      await incrementQuota(patientId, 'message');
      return;
    }
    // Haiku couldn't extract date — fall through to Claude for natural handling
  }

  // ── med_taken ──────────────────────────────────────────────
  if (intent === 'med_taken') {
    const takenResult = await pool.query(
      `UPDATE medication_logs SET status='taken', responded_at=NOW()
       WHERE patient_id=$1 AND status='missed'
       AND scheduled_at > NOW() - INTERVAL '2 hours'
       RETURNING medication_id`,
      [patientId]
    );
    for (const row of takenResult.rows) {
      await pool.query(
        `UPDATE medications SET pills_remaining = GREATEST(pills_remaining - 1, 0)
         WHERE id=$1 AND pills_remaining IS NOT NULL`,
        [row.medication_id]
      );
    }
    medCache.delete(patientId);
    // Update snapshot so dashboard reflects taken status immediately (non-blocking)
    updateSnapshot(patientId);
    // Fall through to Claude for the warm acknowledgement reply
  }

  // ── med_snooze ─────────────────────────────────────────────
  if (intent === 'med_snooze') {
    // Just acknowledge — Claude handles the warm reply below
    // No DB write needed; log stays 'missed' until confirmed
  }

  // ── log_reading — use entities if Haiku extracted values ──
  // Otherwise fall back to regex parser
  let reading = null;
  if (intent === 'log_reading' && entities?.type && entities?.value_1) {
    // Convert mmol glucose to mg/dL if needed
    const v1 = parseFloat(entities.value_1);
    const v2 = entities.value_2 ? parseFloat(entities.value_2) : null;
    let mgVal = v1;
    if (entities.type === 'glucose' && v1 <= 30) mgVal = parseFloat((v1 * 18).toFixed(0));

    reading = {
      type: entities.type,
      value_1: entities.type === 'glucose' ? mgVal : v1,
      value_2: v2,
      unit: entities.unit || '',
      alert_level: entities.type === 'bp' ? classifyBP(v1, v2 || 0)
        : entities.type === 'spo2'    ? classifySpO2(v1)
        : entities.type === 'temp'    ? classifyTemp(v1)
        : entities.type === 'glucose' ? classifyGlucose(mgVal)
        : 'pending',
    };
  } else {
    // Fallback regex for any reading-like text the router might have missed
    reading = parseHealthReading(userMessage);
  }

  // ── All non-shortcut intents hit Claude for the reply ─────
  const history = await loadHistory(patientId);
  history.push({ role: 'user', content: userMessage });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: await buildSystemPrompt(patientId),
    messages: history,
  });

  const reply = response.content.find(b => b.type === 'text')?.text
    ?? 'ขอโทษครับ ลุงไม่เข้าใจ ลองพิมพ์ใหม่อีกครั้งนะครับ';

  let weightChangeMsg = null;
  if (reading) {
    const result = await saveHealthLog(patientId, reading, 'chat');
    weightChangeMsg = result.weightChangeMsg;
  }

  const finalReply = weightChangeMsg ? `${reply}\n\n📊 ${weightChangeMsg}` : reply;

  await saveMessage(patientId, 'user', userMessage, 'text');
  await saveMessage(patientId, 'assistant', finalReply, 'text');
  await incrementQuota(patientId, 'message');

  await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: finalReply }] });
}

// ============================================================
// IMAGE MESSAGE HANDLER
// ============================================================

async function handleImageMessage(event, patientId) {
  try {
    const stream = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imageBase64 = Buffer.concat(chunks).toString('base64');

    // Check if the previous message was about appointments
    // If so, try reading as appointment slip first
    const recentMsg = await pool.query(
      `SELECT content FROM conversation_history
       WHERE patient_id=$1 AND role='user'
       ORDER BY created_at DESC LIMIT 1`,
      [patientId]
    );
    const lastMsg = recentMsg.rows[0]?.content?.toLowerCase() || '';
    const isApptContext = APPT_TRIGGERS.some(t => lastMsg.includes(t)) ||
      lastMsg.includes('นัด') || lastMsg.includes('slip') || lastMsg.includes('ใบนัด');

    if (isApptContext) {
      const appt = await handleAppointmentSlipPhoto(imageBase64, patientId, event.replyToken);
      if (appt) {
        const timeStr = appt.datetime.toLocaleString('th-TH', {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
          text: `📅 อ่านใบนัดได้แล้วครับ\n${appt.title}\n🕐 ${timeStr}\nลุงจะเตือน 48 และ 24 ชั่วโมงก่อนถึงนัดนะครับ 😊` }]});
        await saveMessage(patientId, 'user', '[ส่งรูปใบนัดแพทย์]', 'image_summary');
        await saveMessage(patientId, 'assistant', `จดนัด ${appt.title} ${timeStr}`, 'text');
        await incrementQuota(patientId, 'photo');
        return;
      }
      // If appointment parsing failed, fall through to normal image handling
    }


    const history = await loadHistory(patientId);
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: await buildSystemPrompt(patientId),
      messages: [...history, { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'ผู้สูงอายุส่งรูปนี้มา อาจเป็นเครื่องวัดความดัน เครื่องวัดน้ำตาล เครื่องวัดออกซิเจน หรือฉลากยา ช่วยอ่านค่าอย่างระมัดระวัง แล้วทวนสิ่งที่อ่านได้ให้ผู้ใช้ยืนยันก่อนเสมอครับ — ตอบในรูปแบบ JSON ด้วย: {"type":"bp|glucose|spo2|temp|weight","value_1":0,"value_2":null,"unit":"","reply":"ข้อความตอบกลับ"}' },
      ]}],
    });

    const raw = response.content.find(b => b.type === 'text')?.text ?? '';
    let replyText = raw, photoReading = null;

    try {
      const jm = raw.match(/\{[\s\S]*\}/);
      if (jm) {
        const p = JSON.parse(jm[0]);
        replyText = p.reply || raw;
        if (p.type && p.value_1) {
          const mg = p.type === 'glucose' ? (p.value_1 <= 30 ? p.value_1 * 18 : p.value_1) : p.value_1;
          photoReading = {
            type: p.type, value_1: parseFloat(p.value_1), value_2: p.value_2 ? parseFloat(p.value_2) : null, unit: p.unit,
            alert_level: p.type === 'bp' ? classifyBP(p.value_1, p.value_2||0) : p.type === 'spo2' ? classifySpO2(p.value_1) : p.type === 'temp' ? classifyTemp(p.value_1) : p.type === 'glucose' ? classifyGlucose(mg) : 'normal',
          };
        }
      }
    } catch (e) { /* plain text reply */ }

    if (photoReading) await saveHealthLog(patientId, photoReading, 'photo');

    await saveMessage(patientId, 'user', '[ผู้ใช้ส่งรูปภาพมาให้ลุงอ่าน]', 'image_summary');
    await saveMessage(patientId, 'assistant', replyText, 'text');
    await incrementQuota(patientId, 'photo');
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] });

  } catch (err) {
    console.error('Image error:', err);
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
      text: 'ขอโทษครับ ลุงอ่านรูปไม่ค่อยออก ช่วยถ่ายใหม่ให้ชัด ๆ อีกครั้งได้ไหมครับ?' }]});
  }
}

// ============================================================
// START
// ============================================================

app.listen(3000, () => console.log('✅ ลุงโน้ต is awake on port 3000!'));