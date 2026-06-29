import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import cron from 'node-cron';
import crypto from 'crypto';

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
// MASTER INTENT ROUTER — runs on every post-onboarding message
// Single Haiku call replaces all keyword matching in handleTextMessage.
// Returns { intent, entities } where intent is one of:
//   med_taken | med_snooze | log_reading | add_med | update_med |
//   change_times | book_appointment | check_patient | check_med_list |
//   check_history | send_invite | other
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
- "update_med": User wants to change a SPECIFIC medication's schedule or dose. Examples: "เปลี่ยนเวลายาความดัน", "ลดโดส", "หยุดยา", "แก้ยา"
- "change_times": User wants to change their daily reminder time SLOTS (morning/midday/evening/bedtime) — the times reminders fire, not a specific drug. Examples: "เปลี่ยนเวลาเตือน", "แก้เวลาทานข้าว", "ตั้งเวลากินยาใหม่", "เปลี่ยนเวลาแจ้งเตือน", "change my reminder times", "edit meal times"
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
// MEAL TIME PARSER — Haiku extracts 4 meal times from free text
// Returns { morning, midday, evening, bedtime } as 'HH:MM' strings
// Falls back to defaults for any time it can't extract
// ============================================================

const MEAL_DEFAULTS = { morning: '08:00', midday: '12:00', evening: '18:00', bedtime: '21:00' };

function formatTime(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(h).padStart(2,'0')}:${String(m || 0).padStart(2,'0')}`;
}

async function parseMealTimes(text) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{ role: 'user', content:
        `Extract meal/medication times from this message. Reply ONLY valid JSON, no other text:
{"morning":"HH:MM","midday":"HH:MM","evening":"HH:MM","bedtime":"HH:MM"}
Use null for any time not mentioned. 24-hour format only.
Thai time words: โมงเช้า=morning, เที่ยง=12:00, โมงเย็น/บ่าย=evening, ทุ่ม=evening/bedtime (1ทุ่ม=19:00, 2ทุ่ม=20:00, 3ทุ่ม=21:00, 4ทุ่ม=22:00)
Message: "${text}"` }],
    });
    const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return MEAL_DEFAULTS;
    const parsed = JSON.parse(json[0]);
    return {
      morning: formatTime(parsed.morning) || MEAL_DEFAULTS.morning,
      midday:  formatTime(parsed.midday)  || MEAL_DEFAULTS.midday,
      evening: formatTime(parsed.evening) || MEAL_DEFAULTS.evening,
      bedtime: formatTime(parsed.bedtime) || MEAL_DEFAULTS.bedtime,
    };
  } catch (err) {
    console.error('parseMealTimes failed:', err.message);
    return MEAL_DEFAULTS;
  }
}

// Normalize a meal_times object returned inline by the onboarding extractor
// (same output shape as parseMealTimes). Fills any missing/invalid slot with the
// default so the rest of the flow always sees four valid times. Returns null for
// a non-object so callers can fall back to the dedicated parseMealTimes() call.
function normalizeMealTimes(mt) {
  if (!mt || typeof mt !== 'object') return null;
  return {
    morning: formatTime(mt.morning) || MEAL_DEFAULTS.morning,
    midday:  formatTime(mt.midday)  || MEAL_DEFAULTS.midday,
    evening: formatTime(mt.evening) || MEAL_DEFAULTS.evening,
    bedtime: formatTime(mt.bedtime) || MEAL_DEFAULTS.bedtime,
  };
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

// Default meal/medication times used when a slot is missing.
const DEFAULT_MEAL_TIMES = { morning: '08:00', midday: '12:00', evening: '18:00', bedtime: '21:00' };

// Build the minimal { care_mode, names, meal_times } shape buildMealTimeCard
// needs, from an already-onboarded patient row (post-onboarding edits).
function mealProfileFromPatient(patient) {
  return {
    care_mode: patient.care_mode,
    patient_name: patient.care_mode === 'family' ? patient.display_name : null,
    self_name: patient.care_mode === 'family' ? null : patient.display_name,
    meal_times: {
      morning: String(patient.meal_morning || DEFAULT_MEAL_TIMES.morning).slice(0, 5),
      midday:  String(patient.meal_midday  || DEFAULT_MEAL_TIMES.midday).slice(0, 5),
      evening: String(patient.meal_evening || DEFAULT_MEAL_TIMES.evening).slice(0, 5),
      bedtime: String(patient.meal_bedtime || DEFAULT_MEAL_TIMES.bedtime).slice(0, 5),
    },
  };
}

// buildMealTimeCard: interactive Flex card shown during the meal_times
// onboarding step. Each row has a datetimepicker edit button; the footer
// confirm button posts back 'meal_times_confirmed'. Mirrors buildMedCard.
function buildMealTimeCard(profile, l) {
  const t = { ...DEFAULT_MEAL_TIMES, ...(profile.meal_times || {}) };
  const name = profile.care_mode === 'family' ? profile.patient_name : profile.self_name;
  const title = S(l, 'meal_card_title', name || '');

  const SLOTS = [
    { slot: 'morning', icon: '🌅' },
    { slot: 'midday',  icon: '☀️' },
    { slot: 'evening', icon: '🌆' },
    { slot: 'bedtime', icon: '🌙' },
  ];

  const rows = SLOTS.map(({ slot, icon }) => ({
    type: 'box', layout: 'horizontal', alignItems: 'center',
    contents: [
      { type: 'text', text: icon, size: 'sm', flex: 0 },
      { type: 'text', text: S(l, 'meal_slot_' + slot), size: 'sm', color: '#1a1a1a', flex: 3, margin: 'sm', gravity: 'center' },
      { type: 'text', text: t[slot], size: 'sm', weight: 'bold', color: '#1a1a1a', flex: 2, align: 'end', gravity: 'center' },
      {
        type: 'button', flex: 2, height: 'sm', style: 'link', gravity: 'center',
        action: {
          type: 'datetimepicker',
          label: S(l, 'meal_edit_btn'),
          data: 'edit_meal=' + slot,
          mode: 'time',
          initial: t[slot],
          max: '23:59', min: '00:00',
        },
      },
    ],
    paddingTop: '2px', paddingBottom: '2px',
  }));

  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', spacing: 'none',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'sm', color: '#ffffff' },
          { type: 'text', text: S(l, 'meal_card_subtitle'), size: 'xxs', color: '#e8f7ee' },
        ],
        backgroundColor: '#06C755', paddingAll: '10px',
      },
      body: {
        type: 'box', layout: 'vertical',
        contents: rows,
        paddingAll: '8px', spacing: 'none',
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#06C755', height: 'sm',
          action: { type: 'postback', label: S(l, 'meal_confirm_btn'), data: 'meal_times_confirmed' },
        }],
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
      items: buttons.map(b => {
        // A button may request a native LINE action ('camera' opens the camera,
        // 'cameraRoll' the gallery) instead of sending text. The label still
        // shows on the chip; tapping it triggers the device action directly.
        if (b.action === 'camera' || b.action === 'cameraRoll') {
          return { type: 'action', action: { type: b.action, label: b.label } };
        }
        return {
          type: 'action',
          action: { type: 'message', label: b.label, text: b.text || b.label },
        };
      }),
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
  const strings = {
    // Onboarding
    welcome_ask_lang: {
      th: '🇹🇭 / 🇬🇧\n\nสวัสดีครับ! ผมลุงโน้ต ผู้ช่วยดูแลสุขภาพบน LINE ครับ 😊\nHi! I\'m Uncle Note, your personal health assistant on LINE.\n\nกรุณาเลือกภาษา / Please choose your language:',
      en: '🇹🇭 / 🇬🇧\n\nสวัสดีครับ! ผมลุงโน้ต ผู้ช่วยดูแลสุขภาพบน LINE ครับ 😊\nHi! I\'m Uncle Note, your personal health assistant on LINE.\n\nกรุณาเลือกภาษา / Please choose your language:',
    },
    ask_name: {
      th: 'ยินดีที่ได้ดูแลครับ 😊 ลุงช่วยได้ 3 อย่างนี้ครับ\n⏰ เตือนเวลาทานยา\n📊 บันทึกค่าความดัน/น้ำตาล\n👨‍👩‍👧 แจ้งลูกหลานเมื่อมีเรื่องสำคัญ\n\nก่อนอื่น ขอทราบชื่อของคุณหน่อยได้ไหมครับ?',
      en: 'Glad to be looking after you! 😊 I can help with 3 things:\n⏰ Medication reminders\n📊 Logging your blood pressure / sugar\n👨‍👩‍👧 Notifying your family when something matters\n\nFirst, may I have your name?',
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
    ask_meal_times: {
      th: (name) => `ขอถามเรื่องเวลาทานยาด้วยนะครับ${name ? ` คุณ${name}` : ''} 💊\nปกติทานยาและอาหารตอนไหนครับ? พิมพ์บอกลุงได้เลยครับ\nเช่น "เช้า 7 โมงครึ่ง กลางวันเที่ยง เย็น 6 โมง ก่อนนอน 4 ทุ่ม"`,
      en: (name) => `Quick question about your medication schedule${name ? `, ${name}` : ''} 💊\nWhat times do you usually take your meals and medication? Just type naturally, e.g.\n"breakfast 7:30am, lunch 12pm, dinner 6pm, bedtime 9pm"`,
    },
    ask_meal_times_for: {
      th: (name) => `ขอถามเรื่องเวลาทานยาของคุณ${name || 'ท่าน'}ด้วยนะครับ 💊\nปกติท่านทานยาและอาหารตอนไหนครับ? พิมพ์บอกลุงได้เลยครับ\nเช่น "เช้า 7 โมงครึ่ง กลางวันเที่ยง เย็น 6 โมง ก่อนนอน 4 ทุ่ม"`,
      en: (name) => `What times does ${name || 'your parent'} usually take their meals and medication? 💊\nJust type naturally, e.g.\n"breakfast 7:30am, lunch 12pm, dinner 6pm, bedtime 9pm"`,
    },
    meal_times_saved: {
      th: (m, d, e, b) => `รับทราบครับ 😊\n🌅 เช้า — ${m}\n☀️ กลางวัน — ${d}\n🌆 เย็น — ${e}\n🌙 ก่อนนอน — ${b}\nลุงจะเตือนยาตามเวลานี้นะครับ`,
      en: (m, d, e, b) => `Got it! 😊\n🌅 Morning — ${m}\n☀️ Midday — ${d}\n🌆 Evening — ${e}\n🌙 Bedtime — ${b}\nI'll send reminders at these times.`,
    },
    meal_times_retry: {
      th: 'ขอโทษครับ ลุงยังไม่เข้าใจ ช่วยพิมพ์เวลาอีกครั้งได้ไหมครับ\nเช่น "เช้า 7 โมงครึ่ง กลางวันเที่ยง เย็น 6 โมง ก่อนนอน 4 ทุ่ม"',
      en: 'Sorry, I didn\'t quite catch that. Could you type the times again? e.g.\n"breakfast 7:30am, lunch 12pm, dinner 6pm, bedtime 9pm"',
    },
    // Meal-time Flex card
    meal_card_intro: {
      th: 'ปกติทานข้าวและทานยากี่โมงครับ? ลุงตั้งเวลาให้ก่อน ถ้าไม่ตรงกดแก้ไขได้เลยครับ 😊',
      en: 'What time do you usually eat and take medicine? I\'ve set some default times — tap edit to change any of them 😊',
    },
    meal_card_title: {
      th: (name) => `🕐 เวลาทานยา${name ? 'ของคุณ' + name : ''}`,
      en: (name) => `🕐 Medication times${name ? ' for ' + name : ''}`,
    },
    meal_card_subtitle: {
      th: 'ลุงจะเตือนทานยาตามเวลานี้',
      en: 'I\'ll remind based on these times',
    },
    meal_slot_morning: { th: 'เช้า', en: 'Morning' },
    meal_slot_midday:  { th: 'กลางวัน', en: 'Midday' },
    meal_slot_evening: { th: 'เย็น', en: 'Evening' },
    meal_slot_bedtime: { th: 'ก่อนนอน', en: 'Bedtime' },
    meal_edit_btn: { th: 'แก้ไข', en: 'Edit' },
    meal_confirm_btn: { th: '✓ ใช้เวลานี้เลย', en: '✓ Use these times' },
    meal_edited: {
      th: (slotLabel, time) => `แก้ให้แล้วครับ ${slotLabel} เปลี่ยนเป็น ${time} ครับ`,
      en: (slotLabel, time) => `Updated — ${slotLabel} changed to ${time}`,
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
        { label: '📷 ถ่ายรูปฉลากยา',      action: 'camera' },
        { label: '🚫 ไม่มียา',             text: 'ไม่มียา' },
      ],
      en: [
        { label: '💊 Yes — type med name', text: 'yes medications' },
        { label: '📷 Photo of label',       action: 'camera' },
        { label: '🚫 No medications',       text: 'no medications' },
      ],
    },
    ask_med_name: {
      th: 'พิมพ์ชื่อยามาได้เลยครับ เช่น "Amlodipine 5mg"\nลุงจะถามเวลากินให้ครับ 💊',
      en: 'Type the medication name, e.g. "Amlodipine 5mg"\nI\'ll ask when you take it 💊',
    },
    ask_med_dose: {
      th: (name) => `${name} — ทานครั้งละกี่เม็ดครับ?\nกดเลือกด้านล่าง หรือพิมพ์จำนวนเม็ดมาได้เลยครับ`,
      en: (name) => `${name} — how many do you take each time?\nTap a button below, or just type the number of tablets`,
    },
    dose_buttons: {
      th: [
        { label: '½ เม็ด', text: 'ครึ่งเม็ด' },
        { label: '1 เม็ด', text: '1 เม็ด' },
        { label: '2 เม็ด', text: '2 เม็ด' },
        { label: '🤔 ไม่แน่ใจ', text: 'ไม่แน่ใจ' },
      ],
      en: [
        { label: '½ tablet', text: 'half tablet' },
        { label: '1 tablet', text: '1 tablet' },
        { label: '2 tablets', text: '2 tablets' },
        { label: '🤔 Not sure', text: 'not sure' },
      ],
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
      th: (name, count) => `เยี่ยมเลยครับ คุณ${name || ''} 🎉\nจดยาไว้ ${count} ตัวแล้ว ลุงจะเตือนทานยาตรงเวลาให้นะครับ ⏰\nดูสรุปสุขภาพและดาวน์โหลดรายงาน (PDF) ไปให้คุณหมอได้จากเมนูแดชบอร์ดด้านล่างเลยครับ 📊`,
      en: (name, count) => `All set, ${name || ''}! 🎉\nI've saved ${count} medication(s) and will remind you on time ⏰\nYou can view your health summary and export a report (PDF) for your doctor from the dashboard menu below 📊`,
    },
    complete_no_meds: {
      th: (name) => `เรียบร้อยครับ คุณ${name || ''} 🎉\nลุงพร้อมดูแลแล้วครับ ดูสรุปสุขภาพและดาวน์โหลดรายงาน (PDF) ไปให้คุณหมอได้จากเมนูแดชบอร์ดด้านล่างเลยครับ 📊`,
      en: (name) => `All set, ${name || ''}! 🎉\nUncle Note is ready. You can view your health summary and export a report (PDF) for your doctor from the dashboard menu below 📊`,
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

    // Guardian alert pushes
    guardian_alert: {
      th: (emoji, label, reading, urgency) => `${emoji} แจ้งเตือนจากลุงโน้ต\n${label}: ${reading}\n${urgency}ครับ`,
      en: (emoji, label, reading, urgency) => `${emoji} Uncle Note Alert\n${label}: ${reading}\n${urgency}`,
    },
    guardian_alert_urgency_urgent: { th: 'ค่าผิดปกติ — ควรพบแพทย์โดยเร็ว', en: 'Abnormal reading — please see a doctor soon' },
    guardian_alert_urgency_watch:  { th: 'ค่าที่ควรติดตาม', en: 'Value to keep an eye on' },
    guardian_missed_dose: {
      th: (label, med, dosage, time) => `⚠️ แจ้งเตือนจากลุงโน้ต\n${label} ยังไม่ได้กิน${med}${dosage ? ` ${dosage}` : ''} ครับ\n(กำหนดเวลา ${time} น.)`,
      en: (label, med, dosage, time) => `⚠️ Uncle Note Alert\n${label} hasn't taken ${med}${dosage ? ` ${dosage}` : ''}\n(Scheduled at ${time})`,
    },
    guardian_refill: {
      th: (label, med, days) => `⚠️ แจ้งเตือนจากลุงโน้ต\nยา${med} ของ${label}ใกล้หมดแล้วครับ (เหลือ ~${days} วัน)\nช่วยพา${label}ไปขอยาเพิ่มด้วยนะครับ 🏥`,
      en: (label, med, days) => `⚠️ Uncle Note Alert\n${label}'s ${med} is running low (~${days} days left)\nPlease help them get a refill 🏥`,
    },
    guardian_appt: {
      th: (label, hours, title, time) => `📅 แจ้งเตือนจากลุงโน้ต\n${label} มีนัดแพทย์ใน ${hours} ชั่วโมงครับ\n${title}\n🕐 ${time}`,
      en: (label, hours, title, time) => `📅 Uncle Note Reminder\n${label} has an appointment in ${hours} hours\n${title}\n🕐 ${time}`,
    },
    guardian_invite_accepted: {
      th: (patientName, guardianName) => `✅ คุณ${patientName}เชื่อมต่อกับลุงโน้ตแล้วครับ!\nลุงพร้อมดูแลและส่งรายงานให้คุณ${guardianName}แล้วนะครับ 😊`,
      en: (patientName, guardianName) => `✅ ${patientName} is now connected to Uncle Note!\nI'll look after them and keep you${guardianName ? `, ${guardianName},` : ''} updated 😊`,
    },
  };

  const entry = strings[key];
  if (!entry) return `[missing: ${key}]`;
  const val = entry[lang] ?? entry['th'];
  // Forward ALL args — some templates take 4+ (e.g. meal_times_saved's bedtime,
  // refill_push's days). Capping at (a,b,c) left the 4th arg undefined.
  return typeof val === 'function' ? val(...args) : val;
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

// ============================================================
// NATURAL-LANGUAGE ONBOARDING (slot-filling)
// ------------------------------------------------------------
// Instead of a rigid question-per-state machine, we keep a small
// "profile" of what we still need and, on every message, ask Claude
// to extract whatever it can from the user's free text into that
// profile. A deterministic nextStep() then decides what to ask next
// based only on which slots are still empty — not on a fixed script.
//
// This makes the flow tolerant of:
//   • out-of-order info ("I'm John and I take amlodipine each morning")
//   • misspellings / unexpected phrasing (Claude reads intent, not keywords)
//   • the user volunteering several meds at once
//
// Clinical writes (medication name/dose/schedule) are extracted by the LLM
// (extractOnboardingInfo), validated by normalizeSchedule/medFromExtraction,
// saved via saveMedicationToDB, and are ALWAYS shown back as a list for
// confirmation before we finish.
// ============================================================

// In-memory working profile for an in-progress onboarding.
// Keyed by patientId. Short-lived (one onboarding session).
// The authoritative copy of saved meds always lives in the DB; this map
// only holds the conversational scratch state. If the process restarts
// mid-onboarding, we rebuild what we can from the patients row + meds table.
const onboardingProfiles = new Map();

function freshProfile() {
  return {
    language: null,        // 'th' | 'en'
    care_mode: null,       // 'self' | 'family'
    self_name: null,       // name of the guardian (family mode) or the user (self mode)
    patient_name: null,    // name of the person being cared for
    conditions: null,      // string | 'none'
    meal_raw: null,        // raw text the user gave about meal/med times
    meal_times: null,      // { morning, midday, evening, bedtime }
    meds_done: false,      // user has indicated they finished listing meds
    confirmed: null,       // true once they confirm the med list is correct
    // pending single med awaiting a time (when they gave a name but no time)
    pending_med: null,     // { name, dosage }
  };
}

async function getProfile(patient) {
  let p = onboardingProfiles.get(patient.id);
  if (p) return p;

  p = freshProfile();

  // Only rebuild from the DB row if onboarding was genuinely in progress
  // (e.g. the process restarted mid-flow). For brand-new patients the
  // patients row still holds the INSERT defaults (language='th',
  // care_mode='self'), which must NOT be mistaken for real answers — we
  // still want to ask language and who-it's-for.
  const midFlow = patient.onboarding_state === 'in_progress';
  if (midFlow) {
    p.language = patient.language || null;
    p.care_mode = patient.care_mode === 'family' ? 'family'
      : patient.care_mode === 'self' ? 'self' : null;
    if (patient.display_name) {
      if (p.care_mode === 'family') p.patient_name = patient.display_name;
      else p.self_name = patient.display_name;
    }
    if (patient.conditions) p.conditions = patient.conditions;
    if (patient.meal_morning) {
      p.meal_times = {
        morning: String(patient.meal_morning).slice(0,5),
        midday:  String(patient.meal_midday  || '12:00').slice(0,5),
        evening: String(patient.meal_evening || '18:00').slice(0,5),
        bedtime: String(patient.meal_bedtime || '21:00').slice(0,5),
      };
    }
    if (patient.pending_med_name) {
      // We can't recover which sub-stage we were in across a restart; resume at
      // the time question (skip re-asking the dose) since dosage is already saved.
      p.pending_med = {
        name: patient.pending_med_name,
        dosageMg: patient.pending_med_dosage || null,
        dosage: patient.pending_med_dosage || null,
        schedule: [],
        timeGiven: false,
        stage: 'time',
      };
    }
  }

  p._lineUserId = patient.line_user_id;
  onboardingProfiles.set(patient.id, p);
  return p;
}

function clearProfile(patientId) {
  onboardingProfiles.delete(patientId);
}

// ------------------------------------------------------------
// Extractor: one Claude call that reads the message + current profile
// and returns any new facts as strict JSON, including structured
// medication data (name/dose/schedule), validated downstream by
// normalizeSchedule/medFromExtraction before anything is saved.
// ------------------------------------------------------------
// Static instruction block for the onboarding extractor. Kept at module scope and
// sent as a CACHED system prompt (cache_control below) so the large rule-set isn't
// re-processed on every onboarding turn — only the small per-message context varies.
// NOTE: prompt caching has a per-model minimum cacheable size (~2048 tokens for
// Haiku); if this block is under that floor the cache is silently skipped, but the
// static/dynamic split is still correct and engages automatically if it grows.
const ONBOARDING_EXTRACTOR_SYSTEM = `You are the onboarding extractor for a Thai elderly-health LINE assistant ("ลุงโน้ต").
A user is being onboarded. Read their latest message and pull out any information relevant to the fields below.
Do NOT guess or invent. Only fill a field if the message clearly provides it. Leave everything else null.

The user's message and the context of what we already know will be provided in the next message.

Reply with ONLY this JSON (no prose, no markdown):
{
  "language": "th" | "en" | null,            // only if they clearly pick a language
  "care_mode": "self" | "family" | null,      // self = for themselves; family = caring for a parent/relative
  "self_name": string | null,                 // the speaker's own name
  "patient_name": string | null,              // name of the person they care for (family mode)
  "conditions": string | null,                // medical conditions, or "none" if they say they have none
  "mentions_meal_times": boolean,             // true if message describes meal/medication times of day
  "meal_times": {                              // present ONLY when mentions_meal_times is true; exact clock times
    "morning": "HH:MM" | null,
    "midday":  "HH:MM" | null,
    "evening": "HH:MM" | null,
    "bedtime": "HH:MM" | null
  } | null,
  "wants_photo": boolean,                      // true if they want to send a photo of a medicine label
  "no_medications": boolean,                   // true if they clearly have NO regular medications
  "done_listing_meds": boolean,                // true if they signal they've finished listing medications
  "confirms_correct": boolean,                 // true if confirming shown info is correct
  "wants_edit": boolean,                       // true if they say shown info is wrong / want to change it
  "looks_like_medication": boolean,           // true if the message names a medication to add
  "medication": {                              // present ONLY when looks_like_medication is true
    "name": string,                            // drug name, no dose or time words in it
    "dosage": string | null,                   // e.g. "5mg", "500mg", "1 เม็ด", or null if not stated
    "schedule": string[],                      // anchor times the drug is taken (see ANCHOR TIMES below); [] if no time was given
    "time_given": boolean                      // true if the message stated WHEN to take it
  } | null,
  "schedule_reply": string[] | null            // when we're waiting for a time and the user replies ONLY with a time
                                               // (e.g. "morning and evening", "เช้าเย็น"), the anchor times; else null
}

ANCHOR TIMES — schedule and schedule_reply MUST use only these exact strings:
  "08:00" = morning / เช้า / after breakfast
  "12:00" = midday / noon / lunch / เที่ยง / กลางวัน
  "14:00" = afternoon / บ่าย
  "18:00" = evening / dinner / เย็น / โมงเย็น
  "21:00" = bedtime / night / ก่อนนอน / 3 ทุ่ม
  "22:00" = late night / ดึก / 4 ทุ่ม
Map natural phrases to the nearest anchor. Examples:
  "twice a day, morning and night" => ["08:00","21:00"]
  "three times a day" / "เช้ากลางวันเย็น" / "3 มื้อ" => ["08:00","12:00","18:00"]
  "once daily" / "วันละครั้ง" => ["08:00"]
  "เช้าเย็น" => ["08:00","18:00"]
  "after every meal" => ["08:00","12:00","18:00"]
  "8am and 8pm" => ["08:00","20:00"]   // if an exact non-anchor time is given, use that exact "HH:MM"

MEAL TIMES — for the "meal_times" object, extract the actual clock time stated for each meal as
"HH:MM" (24-hour), or null if that meal isn't mentioned. These are exact times, NOT anchor slots.
Thai time words: โมงเช้า=morning, เที่ยง=12:00, บ่าย=afternoon, โมงเย็น=evening,
ทุ่ม=evening/night (1ทุ่ม=19:00, 2ทุ่ม=20:00, 3ทุ่ม=21:00, 4ทุ่ม=22:00). e.g.
  "เช้า 7 โมงครึ่ง กลางวันเที่ยง เย็น 6 โมง ก่อนนอน 4 ทุ่ม" => {"morning":"07:30","midday":"12:00","evening":"18:00","bedtime":"22:00"}

Guidance:
- Thai "ตัวเอง/ดูแลตัวเอง/เอง" => care_mode "self"; "พ่อ/แม่/ดูแลพ่อแม่/คนอื่น/ให้ท่าน" => "family".
- "ไม่มี/ไม่เป็นอะไร/สบายดี" for conditions => conditions "none".
- "ไม่มียา/ไม่ได้กินยา" => no_medications true.
- "หมดแล้ว/เท่านี้/พอแล้ว/ครบแล้ว/แค่นี้/all done/done/that's all" when listing meds => done_listing_meds true.
- "ถูก/ใช่/โอเค/ถูกต้องแล้ว/correct/ok" when confirming => confirms_correct true.
- "ผิด/แก้/เปลี่ยน/ไม่ถูก/edit/wrong" => wants_edit true.
- A drug name (Thai or English), possibly with a dose and/or a time => looks_like_medication true AND fill "medication".
- If the drug message also says when to take it (e.g. "Metformin 500mg morning"), set medication.time_given=true and fill medication.schedule. If only a name/dose with no time, time_given=false and schedule=[].
- IMPORTANT: never put dose or time words inside medication.name. "Metformin 500mg morning" => name "Metformin", dosage "500mg", schedule ["08:00"], time_given true.
- A single message can fill several fields at once. Fill all that clearly apply.`;

// Fast, deterministic mapping for the FIXED quick-reply button strings. The
// onboarding buttons send exact, known text — there's no need to spend an LLM
// round-trip to interpret them. Returns the same shape extractOnboardingInfo
// would for these exact inputs, or null when the text isn't a known button
// (caller then falls back to the LLM extractor for free-form input).
const COND_BUTTON_TEXTS = new Set([
  'ความดัน', 'เบาหวาน', 'ความดันและเบาหวาน',
  'hypertension', 'diabetes', 'hypertension and diabetes',
]);
const TIME_BUTTON_SCHEDULES = {
  'เช้า': ['08:00'],            'morning': ['08:00'],
  'กลางวัน': ['12:00'],         'midday': ['12:00'],
  'เย็น': ['18:00'],            'evening': ['18:00'],
  'ก่อนนอน': ['21:00'],         'bedtime': ['21:00'],
  'เช้าเย็น': ['08:00', '18:00'],            'morning and evening': ['08:00', '18:00'],
  'เช้ากลางวันเย็น': ['08:00', '12:00', '18:00'], 'morning midday evening': ['08:00', '12:00', '18:00'],
};
function deterministicOnboardingInfo(text, step) {
  const t = (text || '').trim();
  if (!t) return null;

  if (step === 'care_mode') {
    if (t === 'ดูแลตัวเอง' || t === 'myself') return { care_mode: 'self' };
    if (t === 'ดูแลพ่อแม่' || t === 'my parent') return { care_mode: 'family' };
  }

  if (step === 'conditions') {
    if (t === 'ไม่มี' || t === 'none') return { conditions: 'none' };
    if (COND_BUTTON_TEXTS.has(t)) return { conditions: t };
  }

  if (step === 'medications') {
    if (t === 'ไม่มียา' || t === 'no medications') return { no_medications: true };
    if (t === 'ถ่ายรูปยา' || t === 'photo') return { wants_photo: true };
    if (t === 'มียา' || t === 'yes medications') return { wants_to_add_meds: true };
    if (t === 'มียาอีก' || t === 'add another') return { wants_to_add_meds: true };
    if (t === 'หมดแล้ว' || t === 'all done') return { done_listing_meds: true };
  }

  if (step === 'med_dose') {
    if (t === 'ไม่แน่ใจ' || t === 'ไม่ทราบ' || t === 'not sure') return { dose_answered: true };
    const DOSE_TEXTS = new Set(['ครึ่งเม็ด', '1 เม็ด', '2 เม็ด', 'half tablet', '1 tablet', '2 tablets']);
    if (DOSE_TEXTS.has(t)) return { dose_count: t };
    // Free-typed tablet count, e.g. "3", "3 เม็ด", "1.5 เม็ด", "2 tablets".
    if (/^\d+(\.\d+)?\s*(เม็ด|tablets?|tabs?|pills?)?$/i.test(t)) return { dose_count: t };
  }

  if (step === 'med_time' && TIME_BUTTON_SCHEDULES[t]) {
    return { schedule_reply: TIME_BUTTON_SCHEDULES[t] };
  }

  if (step === 'confirm') {
    if (t === 'ถูกต้องแล้ว' || t === 'correct') return { confirms_correct: true };
    if (t === 'อยากแก้ไข' || t === 'edit') return { wants_edit: true };
  }

  return null;
}

async function extractOnboardingInfo(text, profile, step) {
  const known = {
    language: profile.language,
    care_mode: profile.care_mode,
    self_name: profile.self_name,
    patient_name: profile.patient_name,
    conditions: profile.conditions,
    meal_times_known: !!profile.meal_times,
    waiting_for: step,
  };

  const context = `What we already know (for context — do not repeat unless the user is changing it):
${JSON.stringify(known, null, 2)}

We are currently waiting for: "${step}"

User's latest message: "${text}"`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: [{ type: 'text', text: ONBOARDING_EXTRACTOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: context }],
    });
    const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return {};
    return JSON.parse(m[0]);
  } catch (err) {
    console.error('Onboarding extractor failed:', err.message);
    return {};
  }
}

// Determine which slot we still need. Returns a step string used both
// Validate/normalize a schedule the LLM returned. Keeps only sane values:
// known anchor slots, or any explicit "HH:MM". Falls back to ['08:00'] when
// a schedule is required but empty/garbage — never saves an invalid time.
const ANCHOR_SLOTS = new Set(['08:00','12:00','14:00','18:00','21:00','22:00']);
function normalizeSchedule(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let t of arr) {
    if (typeof t !== 'string') continue;
    t = t.trim();
    // accept anchor slots and any valid HH:MM (00:00–23:59)
    if (ANCHOR_SLOTS.has(t)) { if (!out.includes(t)) out.push(t); continue; }
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = parseInt(m[1]), min = parseInt(m[2]);
      if (h < 0 || h > 23 || min < 0 || min > 59) continue; // reject invalid times
      const v = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
      if (!out.includes(v)) out.push(v);
    }
  }
  out.sort();
  return out;
}

// Build a clean med object from the extractor's `medication` field.
// Returns { name, dosage, schedule, timeGiven } or null if unusable.
function medFromExtraction(info) {
  const m = info?.medication;
  if (!m || typeof m.name !== 'string' || m.name.trim().length < 2) return null;
  const schedule = normalizeSchedule(m.schedule);
  return {
    name: m.name.trim(),
    dosage: (m.dosage && String(m.dosage).trim()) || null,
    schedule,
    timeGiven: !!m.time_given && schedule.length > 0,
  };
}

// Determine which slot we still need. Returns a step string used both
// to drive the next question and to give the extractor context.
// `medCount` (optional) lets us skip the confirm card when there are no meds.
function nextStep(profile, medCount = null) {
  if (!profile.language) return 'language';
  if (!profile.self_name) return 'self_name';
  if (!profile.care_mode) return 'care_mode';
  if (profile.care_mode === 'family' && !profile.patient_name) return 'patient_name';
  if (profile.conditions === null) return 'conditions';
  if (!profile.meal_times) return 'meal_times';
  // A named med is waiting: first for its dose (tablets), then for its time.
  if (profile.pending_med) return profile.pending_med.stage === 'dosage' ? 'med_dose' : 'med_time';
  if (!profile.meds_done) return 'medications';
  // If they finished with zero meds, there's nothing to confirm → complete.
  if (medCount === 0) return 'complete';
  if (profile.confirmed !== true) return 'confirm';
  return 'complete';
}

// Persist whatever slots are now known to the patients row, so the rest
// of the app (crons, dashboard, system prompt) sees them immediately.
async function persistProfile(patientId, profile, lineUserId) {
  // care_mode + name
  if (profile.care_mode === 'self' && profile.self_name) {
    await pool.query(`UPDATE patients SET care_mode='self', display_name=$1 WHERE id=$2`, [profile.self_name, patientId]);
  } else if (profile.care_mode === 'family' && profile.patient_name) {
    await pool.query(`UPDATE patients SET care_mode='family', display_name=$1 WHERE id=$2`, [profile.patient_name, patientId]);
  }
  if (profile.language) {
    await pool.query(`UPDATE patients SET language=$1 WHERE id=$2`, [profile.language, patientId]);
  }
  if (profile.conditions !== null) {
    const cond = profile.conditions === 'none' ? null : profile.conditions;
    await pool.query(`UPDATE patients SET conditions=$1 WHERE id=$2`, [cond, patientId]);
  }
  if (profile.meal_times) {
    const t = profile.meal_times;
    await pool.query(
      `UPDATE patients SET meal_morning=$1, meal_midday=$2, meal_evening=$3, meal_bedtime=$4 WHERE id=$5`,
      [t.morning, t.midday, t.evening, t.bedtime, patientId]
    );
  }
}

// When the user switches into family mode, make sure a household + guardian
// record exists (mirrors the old asking_mode FAMILY branch).
async function ensureGuardianRecord(patientId, lineUserId, profile) {
  const hhResult = await pool.query(`SELECT household_id FROM patients WHERE id=$1`, [patientId]);
  const householdId = hhResult.rows[0].household_id;
  await pool.query(`UPDATE households SET mode='guardian' WHERE id=$1`, [householdId]);
  await pool.query(
    `INSERT INTO guardians (household_id, line_user_id, display_name, notification_level, language)
     VALUES ($1, $2, $3, 'realtime', $4)
     ON CONFLICT (household_id) DO UPDATE SET line_user_id=$2, display_name=$3, language=$4`,
    [householdId, lineUserId, profile.self_name || null, profile.language || 'th']
  );
}

// ------------------------------------------------------------
// MAIN ENTRY — replaces the old state-machine handleOnboarding.
// Same signature & call site: handleOnboarding(event, patient).
// ------------------------------------------------------------
async function handleOnboarding(event, patient) {
  const { replyToken } = event;
  const text = event.message?.text?.trim() || '';
  const patientId = patient.id;
  const lineUserId = event.source.userId;

  const profile = await getProfile(patient);

  // Very first contact (no language yet, empty message or follow): ask language.
  if (!profile.language && !text) {
    await client.replyMessage({ replyToken, messages: [buildQuickReply(
      S('th', 'welcome_ask_lang'),
      [{ label: '🇹🇭 ภาษาไทย', text: 'ภาษาไทย' }, { label: '🇬🇧 English', text: 'English' }]
    )]});
    return;
  }

  // Language is special-cased with a cheap deterministic check first
  // (the buttons send exact strings), falling back to the extractor.
  let justPickedLanguage = false;
  if (!profile.language) {
    const isEn = /english|^en$/i.test(text) || text === 'English';
    const isTh = /ไทย|thai/i.test(text) || text === 'ภาษาไทย';
    if (isEn || isTh) {
      profile.language = isEn ? 'en' : 'th';
      justPickedLanguage = true;
    }
  }

  const step = nextStep(profile);

  // Run the extractor for everything except the pure language pick. When the user
  // JUST picked the language this turn, the whole message was that pick — there's
  // nothing else to extract, so skip the LLM entirely and reply instantly with the
  // next question. Quick-reply buttons elsewhere send fixed, known strings — resolve
  // those deterministically; only free-form text falls through to the (slower) extractor.
  let info = {};
  if (profile.language && step !== 'language' && !justPickedLanguage) {
    info = deterministicOnboardingInfo(text, step) || await extractOnboardingInfo(text, profile, step);
  }

  // ---- Merge extracted info into the profile ----
  if (info.language && !profile.language) profile.language = info.language;
  if (info.self_name && !profile.self_name) profile.self_name = info.self_name;
  if (info.care_mode && !profile.care_mode) profile.care_mode = info.care_mode;
  if (info.patient_name && profile.care_mode === 'family' && !profile.patient_name) {
    profile.patient_name = info.patient_name;
  }
  if (info.conditions && profile.conditions === null) {
    profile.conditions = info.conditions;
  }

  const l = profile.language || 'th';

  // ===== Step-specific handling that needs deterministic helpers =====

  // (A) Meal times — use the existing parseMealTimes() helper on the raw text.
  if (step === 'meal_times' && info.mentions_meal_times) {
    if (text.trim().length >= 3) {
      profile.meal_raw = text;
      // Prefer the times the extractor already parsed in the same call; only fall
      // back to the dedicated parseMealTimes() round-trip if it didn't return them.
      profile.meal_times = normalizeMealTimes(info.meal_times) || await parseMealTimes(text);
      profile._showMealSaved = true; // show the saved-times summary once, next turn
      await persistProfile(patientId, profile, lineUserId);
    }
  }

  // (B0) We asked how many tablets per dose for the pending med — this reply is it.
  if (step === 'med_dose' && profile.pending_med) {
    if (info.done_listing_meds || info.no_medications || info.wants_edit || info.confirms_correct) {
      // User bailed on this med before giving a dose — drop it, fall through.
      profile.pending_med = null;
      await pool.query(`UPDATE patients SET pending_med_name=NULL, pending_med_dosage=NULL WHERE id=$1`, [patientId]);
    } else {
      // Resolve tablets-per-dose: button → info.dose_count; "not sure" → none;
      // otherwise a short free-typed answer ("2", "ครึ่งเม็ด"). Ignore anything that
      // looks like a new drug name so we don't store it as a dose.
      let tablets = null;
      if (typeof info.dose_count === 'string') tablets = info.dose_count;
      else if (!info.dose_answered && !info.looks_like_medication &&
               text.trim().length > 0 && text.trim().length <= 20) tablets = text.trim();
      const pm = profile.pending_med;
      pm.dosage = [pm.dosageMg, tablets].filter(Boolean).join(' · ') || null;
      pm.stage = 'time';
      await pool.query(`UPDATE patients SET pending_med_dosage=$1 WHERE id=$2`, [pm.dosage, patientId]);
      if (pm.timeGiven && pm.schedule.length > 0) {
        // Time was already given with the name → nothing left to ask, save now.
        const med = await saveMedicationToDB(patientId, pm.name, pm.dosage, pm.schedule);
        profile.pending_med = null;
        await pool.query(`UPDATE patients SET pending_med_name=NULL, pending_med_dosage=NULL WHERE id=$1`, [patientId]);
        await client.replyMessage({ replyToken, messages: [buildQuickReply(
          S(l, 'med_saved', formatMed(med)) + (l === 'en' ? 'Any others?' : 'มียาอีกไหมครับ?'),
          S(l, 'more_med_buttons'))]});
        return;
      }
      await client.replyMessage({ replyToken, messages: [buildQuickReply(
        S(l, 'ask_med_time', pm.name, pm.dosage),
        l === 'en' ? TIME_BUTTONS_EN : TIME_BUTTONS
      )]});
      return;
    }
  }

  // (B1) User said they have meds and want to type them ("มียา" button) → prompt
  //      for the name. Without this, tapping it produced no state change and the
  //      bot re-asked the same yes/no question on a loop.
  if (step === 'medications' && info.wants_to_add_meds &&
      !info.looks_like_medication && !profile.meds_done) {
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'ask_med_name') }]});
    return;
  }

  // (B) A medication name (new) or a time reply (for a pending med).
  //     Medication parsing comes from the LLM extractor (info.medication and
  //     info.schedule_reply), so it works the same in Thai and English.
  if ((step === 'medications' || step === 'med_time') &&
      (info.looks_like_medication || step === 'med_time')) {
    // If we were waiting for a TIME for a pending med, this message is the time —
    // UNLESS the user is signalling done/edit, in which case drop the pending med
    // (never given a time) and fall through to the done/edit handling.
    if (step === 'med_time' && profile.pending_med) {
      if (info.done_listing_meds || info.no_medications || info.wants_edit || info.confirms_correct) {
        profile.pending_med = null;
        await pool.query(`UPDATE patients SET pending_med_name=NULL, pending_med_dosage=NULL WHERE id=$1`, [patientId]);
        // do not return — let the done/edit logic below run this same turn
      } else {
        // The reply is the time. Prefer schedule_reply; if the user instead
        // restated the whole med, take that med's schedule.
        let schedule = normalizeSchedule(info.schedule_reply);
        if (schedule.length === 0) {
          const restated = medFromExtraction(info);
          if (restated && restated.schedule.length > 0) schedule = restated.schedule;
        }
        const finalSchedule = schedule.length > 0 ? schedule : ['08:00'];
        const med = await saveMedicationToDB(patientId, profile.pending_med.name, profile.pending_med.dosage, finalSchedule);
        profile.pending_med = null;
        await pool.query(`UPDATE patients SET pending_med_name=NULL, pending_med_dosage=NULL WHERE id=$1`, [patientId]);
        await persistProfile(patientId, profile, lineUserId);
        await client.replyMessage({ replyToken, messages: [buildQuickReply(
          S(l, 'med_saved', formatMed(med)) + (l === 'en' ? 'Any other medications?' : 'มียาตัวอื่นอีกไหมครับ?'),
          S(l, 'more_med_buttons'))]});
        return;
      }
    }
    // Otherwise this is a new med name in the listing phase → ask its dose first.
    if (info.looks_like_medication) {
      const med0 = medFromExtraction(info);
      if (!med0) {
        await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'med_name_unclear') }]});
        return;
      }
      await startPendingMed(replyToken, patientId, profile, l, med0);
      return;
    }
  }

  // From here on, treat 'medications', 'med_dose' and 'med_time' as the same
  // "meds area": a done/no-meds/photo signal can arrive even while a med was
  // pending its dose or time (we dropped that pending med just above), so all
  // three steps should honour them.
  const inMedsArea = (step === 'medications' || step === 'med_dose' || step === 'med_time');

  // (C) No-medications declaration during the meds phase.
  if (inMedsArea && info.no_medications) {
    profile.meds_done = true;
  }

  // (C2) User wants to photograph a label — prompt them to send it.
  if (inMedsArea && info.wants_photo && !info.looks_like_medication && !profile.meds_done) {
    await client.replyMessage({ replyToken, messages: [{ type: 'text',
      text: l === 'en' ? 'Send a photo of the medicine label 📷' : 'ถ่ายรูปฉลากยามาได้เลยครับ ลุงจะอ่านและจดไว้ให้ครับ 📷' }]});
    return;
  }

  // (D) Done listing meds.
  if (inMedsArea && info.done_listing_meds) {
    profile.meds_done = true;
  }

  // (E) Confirmation / edit handling while showing the list.
  if (step === 'confirm') {
    if (info.confirms_correct) {
      profile.confirmed = true;
    } else if (info.wants_edit) {
      // Reopen the meds phase so they can add/correct, then we'll re-confirm.
      profile.meds_done = false;
      profile.confirmed = null;
      await client.replyMessage({ replyToken, messages: [{ type: 'text', text: S(l, 'edit_meds') }]});
      return;
    } else if (info.looks_like_medication) {
      // They typed another med at the confirm screen — treat as an addition,
      // routed through the same dose-then-time flow as the listing phase.
      profile.meds_done = false;
      profile.confirmed = null;
      const med0 = medFromExtraction(info);
      if (med0) {
        await startPendingMed(replyToken, patientId, profile, l, med0);
        return;
      }
    }
  }

  // Persist any newly-learned simple slots before deciding what to ask next.
  await persistProfile(patientId, profile, lineUserId);

  // If the user just switched into family mode, make sure guardian record exists.
  if (profile.care_mode === 'family') {
    await ensureGuardianRecord(patientId, lineUserId, profile);
  }

  // ===== Decide & ask the next thing =====
  await advanceOnboarding(replyToken, patient, profile);
}

// Stash a freshly-named medication as pending and ask how many tablets per dose.
// Shared by the meds-listing flow, the confirm-screen "add another" path, and the
// photo-label path so all three collect a dose (tablets) before asking the time.
async function startPendingMed(replyToken, patientId, profile, l, med0) {
  profile.pending_med = {
    name: med0.name,
    dosageMg: med0.dosage || null,   // strength from the name, e.g. "5mg" (may be null)
    dosage: med0.dosage || null,     // running display value; tablets get appended next turn
    schedule: med0.schedule || [],
    timeGiven: !!med0.timeGiven,
    stage: 'dosage',
  };
  await pool.query(`UPDATE patients SET pending_med_name=$1, pending_med_dosage=$2 WHERE id=$3`,
    [med0.name, med0.dosage || null, patientId]);
  await client.replyMessage({ replyToken, messages: [buildQuickReply(
    S(l, 'ask_med_dose', med0.name),
    S(l, 'dose_buttons')
  )]});
}

// ------------------------------------------------------------
// advanceOnboarding: look at the profile, ask for the next empty slot,
// or finish. Centralises the "what do we say now" logic so both text and
// photo handlers can call it.
// ------------------------------------------------------------
async function advanceOnboarding(target, patient, profile) {
  const patientId = patient.id;
  const lineUserId = patient.line_user_id || (profile._lineUserId);
  const l = profile.language || 'th';

  // `target` is normally a replyToken string (webhook reply); { to: lineUserId }
  // is also accepted to push instead, for any server-initiated continuation.
  const respond = (messages) => typeof target === 'string'
    ? client.replyMessage({ replyToken: target, messages })
    : client.pushMessage({ to: target.to, messages });

  // If meds are done, we need the count to decide confirm vs. complete.
  let medCount = null;
  if (profile.meds_done && !profile.pending_med) {
    const c = await pool.query(`SELECT COUNT(*) FROM medications WHERE patient_id=$1 AND active=TRUE`, [patientId]);
    medCount = parseInt(c.rows[0].count);
  }
  const step = nextStep(profile, medCount);

  // Mirror completion into the DB column so needsOnboarding() works.
  // While in progress we store a single 'in_progress' sentinel — the
  // detailed step lives in the in-memory profile, not the column.
  if (step !== 'complete') {
    await setOnboardingState(patientId, 'in_progress').catch(() => {});
  }

  switch (step) {
    case 'language':
      await respond([buildQuickReply(
        S('th', 'welcome_ask_lang'),
        [{ label: '🇹🇭 ภาษาไทย', text: 'ภาษาไทย' }, { label: '🇬🇧 English', text: 'English' }]
      )]);
      return;

    case 'self_name':
      await respond([{ type: 'text', text: S(l, 'ask_name') }]);
      return;

    case 'care_mode':
      await respond([buildQuickReply(
        S(l, 'ask_mode', profile.self_name || ''),
        S(l, 'mode_buttons')
      )]);
      return;

    case 'patient_name':
      await respond([{ type: 'text', text: S(l, 'family_intro') }]);
      return;

    case 'conditions': {
      const askKey = profile.care_mode === 'family' ? 'ask_conditions_for' : 'ask_conditions';
      const askArg = profile.care_mode === 'family' ? (profile.patient_name || '') : undefined;
      await respond([buildQuickReply(
        askArg !== undefined ? S(l, askKey, askArg) : S(l, askKey),
        S(l, 'condition_buttons')
      )]);
      return;
    }

    case 'meal_times': {
      const card = buildMealTimeCard(profile, l);
      // Attaching a quick-reply to the last message makes LINE collapse the soft
      // keyboard (and show chips instead), so the tall card isn't hidden behind it.
      card.quickReply = { items: [{
        type: 'action',
        action: { type: 'postback', label: S(l, 'meal_confirm_btn'), data: 'meal_times_confirmed', displayText: S(l, 'meal_confirm_btn') },
      }]};
      await respond([
        { type: 'text', text: S(l, 'meal_card_intro') },
        card,
      ]);
      return;
    }

    case 'med_dose':
      // A med is pending its dose but we returned here without asking; ask now.
      await respond([buildQuickReply(
        S(l, 'ask_med_dose', profile.pending_med.name),
        S(l, 'dose_buttons')
      )]);
      return;

    case 'med_time':
      // We have a pending med but somehow returned here without asking; ask now.
      await respond([buildQuickReply(
        S(l, 'ask_med_time', profile.pending_med.name, profile.pending_med.dosage),
        l === 'en' ? TIME_BUTTONS_EN : TIME_BUTTONS
      )]);
      return;

    case 'medications': {
      // First time we arrive here (meal times just saved) → invite them to list meds.
      const askKey = profile.care_mode === 'family' ? 'ask_meds_for' : 'ask_meds';
      const msgs = [];
      if (profile.meal_times && profile._showMealSaved) {
        const t = profile.meal_times;
        msgs.push({ type: 'text', text: S(l, 'meal_times_saved', t.morning, t.midday, t.evening, t.bedtime) });
        profile._showMealSaved = false;
      }
      msgs.push(buildQuickReply(S(l, askKey), S(l, 'med_buttons')));
      await respond(msgs);
      return;
    }

    case 'confirm': {
      // Show the full medication list once and ask for confirmation.
      const header = profile.care_mode === 'family'
        ? (l === 'en' ? `💊 ${profile.patient_name || 'Parent'}'s medications` : `💊 ยาของคุณ${profile.patient_name || 'ท่าน'}`)
        : (l === 'en' ? '💊 Your medications' : '💊 รายการยาที่ลุงจดไว้');
      const card = await buildMedCard(patientId, header);
      const nameForConfirm = profile.care_mode === 'family' ? (profile.patient_name || '') : (profile.self_name || '');
      await respond([
        card,
        buildQuickReply(S(l, 'ask_confirm', nameForConfirm), S(l, 'confirm_buttons')),
      ]);
      return;
    }

    case 'complete':
      await finishOnboarding(target, patient, profile);
      return;
  }
}

// ------------------------------------------------------------
// finishOnboarding: mark complete and send the right closing message.
// Self mode → friendly wrap-up. Family mode → create + send invite link.
// ------------------------------------------------------------
async function finishOnboarding(target, patient, profile) {
  const patientId = patient.id;
  const lineUserId = patient.line_user_id || profile._lineUserId;
  const l = profile.language || 'th';
  const respond = (messages) => typeof target === 'string'
    ? client.replyMessage({ replyToken: target, messages })
    : client.pushMessage({ to: target.to, messages });
  await setOnboardingState(patientId, 'complete');
  clearProfile(patientId);
  medCache.delete(patientId);

  if (profile.care_mode === 'family') {
    const patientName = profile.patient_name || '';
    try {
      const { deepLink } = await createInviteLink(lineUserId, patientName);
      const card = buildInviteCard(deepLink, patientName);
      await respond([
        { type: 'text', text: S(l, 'guardian_complete', patientName) },
        card,
      ]);
    } catch (err) {
      console.error('Invite link creation failed at onboarding finish:', err.message);
      await respond([{ type: 'text', text: S(l, 'guardian_complete_fallback', patientName) }]);
    }
    return;
  }

  // Self mode
  const countResult = await pool.query(`SELECT COUNT(*) FROM medications WHERE patient_id=$1 AND active=TRUE`, [patientId]);
  const count = parseInt(countResult.rows[0].count);
  const msgKey = count > 0 ? 'complete_solo' : 'complete_no_meds';
  const msg = count > 0
    ? S(l, 'complete_solo', profile.self_name || '', count)
    : S(l, 'complete_no_meds', profile.self_name || '');
  await respond([{ type: 'text', text: msg }]);
}

// ============================================================
// IMAGE DURING ONBOARDING (photo of medicine label)
// Reads the label, then funnels the parsed med into the same slot flow.
// ============================================================

async function handleImageDuringOnboarding(event, patient) {
  const profile = await getProfile(patient);
  const l = profile.language || lang(patient);
  const patientId = patient.id;

  // If we're not yet at the medication-collection phase, a photo isn't
  // expected here — gently steer back to whatever we still need.
  const step = nextStep(profile);
  if (step !== 'medications' && step !== 'med_time' && step !== 'confirm') {
    await advanceOnboarding(event.replyToken, patient, profile);
    return;
  }

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
    // Stash as a pending med and ask the dose (then the time) — same flow as text.
    profile.pending_med = {
      name, dosageMg: dosage || null, dosage: dosage || null,
      schedule: [], timeGiven: false, stage: 'dosage',
    };
    profile.meds_done = false;
    profile.confirmed = null;
    await pool.query(`UPDATE patients SET pending_med_name=$1, pending_med_dosage=$2 WHERE id=$3`, [name, dosage || null, patientId]);
    const photoAck = l === 'en' ? 'Got it 📷 ' : 'อ่านได้ครับ 📷 ';
    await client.replyMessage({ replyToken: event.replyToken, messages: [buildQuickReply(
      photoAck + S(l, 'ask_med_dose', name + (dosage ? ` ${dosage}` : '')),
      S(l, 'dose_buttons')
    )]});
  } catch (err) {
    console.error('Image onboarding error:', err.message);
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: S(profile.language || lang(patient), 'photo_ask_retake') }]});
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
// TEMPLATED REPLIES — deterministic, zero-LLM replies for the
// high-volume, low-nuance intents (med taken/snooze, plain readings).
// Sonnet (and its cost + safety judgement) is reserved for anything
// carrying a question, symptom, or clinical nuance.
// ============================================================

// A reading bundled with a question must still go to Sonnet so it can
// actually answer ("150/95 สูงไปไหม"). Plain readings ("130/85",
// "ความดัน 130/85") carry no question marker and are safe to template.
const QUESTION_RE = /[?？]|ไหม|มั้ย|ยังไง|ทำไง|ทำยังไง|หรือเปล่า|สูงไป|ต่ำไป|อันตราย|ปกติไหม|ดีไหม|น่าห่วง|เป็นอะไร|กินได้|how|should|what|why|too high|too low|normal\?|ok\?|dangerous/i;

const READING_LABELS_TPL = {
  th: { bp: 'ความดัน', glucose: 'น้ำตาล', spo2: 'ออกซิเจน', temp: 'อุณหภูมิ', weight: 'น้ำหนัก' },
  en: { bp: 'Blood pressure', glucose: 'Blood sugar', spo2: 'Oxygen', temp: 'Temperature', weight: 'Weight' },
};

function formatReadingValue(r) {
  if (r.type === 'bp')      return `${r.value_1}/${r.value_2} mmHg`;
  if (r.type === 'glucose') return `${r.value_1} mg/dL`;
  if (r.type === 'spo2')    return `${r.value_1}%`;
  if (r.type === 'temp')    return `${r.value_1}°C`;
  if (r.type === 'weight')  return `${r.value_1} kg`;
  return `${r.value_1}`;
}

// Warm acknowledgement for med taken / snooze.
function templatedAck(intent, lang) {
  const l = lang === 'en' ? 'en' : 'th';
  if (intent === 'med_taken') {
    return l === 'en'
      ? "Great! I've noted your medication as taken 👍 Take care of yourself! 😊"
      : 'เยี่ยมเลยครับ ลุงจดไว้แล้วว่ากินยาเรียบร้อย 👍 ดูแลสุขภาพต่อไปนะครับ 😊';
  }
  // med_snooze
  return l === 'en'
    ? 'Got it — reply "taken" once you\'ve had it and I\'ll note it down 🙏'
    : 'รับทราบครับ เดี๋ยวกินแล้วพิมพ์ "กินแล้ว" บอกลุงด้วยนะครับ 🙏';
}

// Reading confirmation, keyed on alert_level. Never diagnoses — only
// records the value and, when abnormal, gently suggests seeing a doctor.
// For weight, the level line is omitted because the weightChangeMsg
// (appended by the caller) already carries the detail.
function templatedReadingReply(r, lang, fromPhoto = false) {
  const l = lang === 'en' ? 'en' : 'th';
  const label = READING_LABELS_TPL[l][r.type] || r.type;
  const val = formatReadingValue(r);
  if (l === 'en') {
    const head = fromPhoto ? `📷 I read your ${label} as ${val}. Saved it for you.` : `Saved your ${label}: ${val}.`;
    if (r.type === 'weight') return head;
    if (r.alert_level === 'urgent') return `${head}\nThis reading is outside the usual range — I'm a bit concerned, please see a doctor soon 🙏`;
    if (r.alert_level === 'watch')  return `${head}\nA little outside the usual range — worth keeping an eye on. If it stays like this, do check with your doctor.`;
    return `${head}\nIt's within a normal range — you're taking good care of yourself 👍`;
  }
  const head = fromPhoto ? `📷 ลุงอ่านค่า${label}ได้ ${val} ครับ บันทึกไว้ให้แล้ว` : `บันทึกค่า${label} ${val} ให้แล้วครับ`;
  if (r.type === 'weight') return head;
  if (r.alert_level === 'urgent') return `${head}\nค่านี้อยู่นอกเกณฑ์ปกติ ลุงเป็นห่วงครับ แนะนำให้พบแพทย์โดยเร็วนะครับ 🙏`;
  if (r.alert_level === 'watch')  return `${head}\nค่านี้สูงกว่าปกติเล็กน้อย ควรติดตามนะครับ ถ้าเป็นบ่อยลองปรึกษาคุณหมอครับ`;
  return `${head}\nอยู่ในเกณฑ์ปกติครับ ดูแลตัวเองได้ดีมากครับ 👍`;
}

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
      `SELECT g.line_user_id, g.notification_level, g.language as guardian_language,
              p.display_name as patient_name
       FROM guardians g JOIN households h ON h.id=g.household_id JOIN patients p ON p.household_id=h.id
       WHERE p.id=$1 AND g.line_user_id IS NOT NULL`,
      [patientId]
    );
    if (result.rows.length === 0) return;
    const g = result.rows[0];
    if (g.notification_level === 'summary_only' || (g.notification_level === 'daily' && reading.alert_level === 'watch')) return;

    const gl = g.guardian_language === 'en' ? 'en' : 'th';
    const patientLabel = g.patient_name
      ? (gl === 'en' ? g.patient_name : `คุณ${g.patient_name}`)
      : `...${patientId.slice(-6)}`;
    const emoji = reading.alert_level === 'urgent' ? '🚨' : '⚠️';
    const urgency = S(gl, reading.alert_level === 'urgent' ? 'guardian_alert_urgency_urgent' : 'guardian_alert_urgency_watch');

    const READING_LABELS = {
      th: { bp: 'ความดัน', glucose: 'น้ำตาล', spo2: 'ออกซิเจน', temp: 'อุณหภูมิ', weight: 'น้ำหนัก' },
      en: { bp: 'Blood pressure', glucose: 'Blood sugar', spo2: 'Oxygen', temp: 'Temperature', weight: 'Weight' },
    };
    const label = READING_LABELS[gl][reading.type] || reading.type;

    let readingText = '';
    if (reading.type === 'bp')      readingText = `${reading.value_1}/${reading.value_2} mmHg`;
    else if (reading.type === 'glucose') readingText = `${reading.value_1} mg/dL`;
    else if (reading.type === 'spo2')    readingText = `${reading.value_1}%`;
    else if (reading.type === 'temp')    readingText = `${reading.value_1}°C`;
    else if (reading.type === 'weight')  readingText = `${reading.value_1} kg${reading.value_2 ? ` (${reading.value_2 > 0 ? '+' : ''}${reading.value_2} kg)` : ''}`;

    await client.pushMessage({ to: g.line_user_id, messages: [{ type: 'text',
      text: S(gl, 'guardian_alert', emoji, `${patientLabel}: ${label}`, readingText, urgency) }]});
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
  const currentTime = `${hh}:${mm}`;

  // Match current Bangkok time against each patient's personal meal times.
  // medications.schedule stores slot names ('08:00','12:00','18:00','21:00') as anchors.
  // We compare the patient's personal times to the current clock time,
  // then check if the corresponding anchor slot is in the medication's schedule.
  const result = await pool.query(
    `SELECT m.id as medication_id, m.name, m.dosage, m.schedule,
            p.id as patient_id, p.line_user_id, p.display_name, p.language,
            p.meal_morning, p.meal_midday, p.meal_evening, p.meal_bedtime
     FROM medications m JOIN patients p ON p.id=m.patient_id
     WHERE m.active=TRUE AND p.line_user_id IS NOT NULL
     AND (
       ($1 = to_char(p.meal_morning, 'HH24:MI') AND '08:00' = ANY(m.schedule)) OR
       ($1 = to_char(p.meal_midday,  'HH24:MI') AND '12:00' = ANY(m.schedule)) OR
       ($1 = to_char(p.meal_evening, 'HH24:MI') AND '18:00' = ANY(m.schedule)) OR
       ($1 = to_char(p.meal_bedtime, 'HH24:MI') AND '21:00' = ANY(m.schedule))
     )`,
    [currentTime]
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
        const l = med.language === 'en' ? 'en' : 'th';
        const name = med.display_name ? (l === 'en' ? ` ${med.display_name}` : ` คุณ${med.display_name}`) : '';
        await client.pushMessage({ to: med.line_user_id, messages: [{ type: 'text',
          text: S(l, 'reminder_push', name, med.name, med.dosage) }]});
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

  // Sonnet, not Haiku: this summary is user-facing clinical prose (sent to
  // patient/guardian). Once-a-day-per-patient, so the cost is trivial.
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
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
              p.line_user_id, p.display_name, p.language
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
        const l = row.language === 'en' ? 'en' : 'th';
        const name = row.display_name ? (l === 'en' ? ` ${row.display_name}` : ` คุณ${row.display_name}`) : '';
        await client.pushMessage({
          to: row.line_user_id,
          messages: [{ type: 'text', text: S(l, 'followup_push', name, row.name, row.dosage) }],
        });
        await pool.query(`UPDATE medication_logs SET followup_sent=TRUE WHERE id=$1`, [row.id]);
        console.log(`🔔 Follow-up sent: ${row.name} → ${row.line_user_id}`);
      } catch (err) { console.error(`❌ Follow-up failed:`, err.message); }
    }

    // --- 60 min: still missed → notify guardian ---
    const confirmedMissed = await pool.query(
      `SELECT ml.id, ml.medication_id, ml.patient_id, ml.scheduled_at,
              m.name, m.dosage,
              p.line_user_id, p.display_name, p.language
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
        const guardian = await pool.query(
          `SELECT g.line_user_id, g.notification_level, g.language as guardian_language
           FROM guardians g
           JOIN households h ON h.id = g.household_id
           JOIN patients p ON p.household_id = h.id
           WHERE p.id = $1 AND g.line_user_id IS NOT NULL`,
          [row.patient_id]
        );
        if (guardian.rows.length > 0 && guardian.rows[0].notification_level !== 'summary_only') {
          const gl = guardian.rows[0].guardian_language === 'en' ? 'en' : 'th';
          const patientLabel = row.display_name
            ? (gl === 'en' ? row.display_name : `คุณ${row.display_name}`)
            : `...${row.patient_id.slice(-6)}`;
          const scheduledTime = new Date(new Date(row.scheduled_at).getTime() + 7*3600000)
            .toLocaleTimeString(gl === 'en' ? 'en-GB' : 'th-TH', { hour: '2-digit', minute: '2-digit' });
          await client.pushMessage({
            to: guardian.rows[0].line_user_id,
            messages: [{ type: 'text', text: S(gl, 'guardian_missed_dose', patientLabel, row.name, row.dosage, scheduledTime) }],
          });
          console.log(`📲 Missed dose guardian notified: ${row.name}`);
        }
        await pool.query(`UPDATE medication_logs SET guardian_notified=TRUE WHERE id=$1`, [row.id]);
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
              p.id as patient_id, p.line_user_id, p.display_name, p.language,
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
        const l = med.language === 'en' ? 'en' : 'th';
        const name = med.display_name ? (l === 'en' ? ` ${med.display_name}` : ` คุณ${med.display_name}`) : '';
        const doseResult = await pool.query(
          `SELECT array_length(schedule,1) as doses FROM medications WHERE id=$1`, [med.id]
        );
        const dosesPerDay = doseResult.rows[0]?.doses || 1;
        const daysLeft = Math.floor(med.pills_remaining / dosesPerDay);

        await client.pushMessage({
          to: med.line_user_id,
          messages: [{ type: 'text', text: S(l, 'refill_push', name, med.name, med.dosage, daysLeft) }],
        });

        await pool.query(`INSERT INTO refill_reminders (medication_id, sent, sent_at) VALUES ($1, TRUE, NOW())`, [med.id]);

        const guardian = await pool.query(
          `SELECT g.line_user_id, g.language as guardian_language FROM guardians g
           JOIN households h ON h.id=g.household_id
           JOIN patients p ON p.household_id=h.id
           WHERE p.id=$1 AND g.line_user_id IS NOT NULL`,
          [med.patient_id]
        );
        if (guardian.rows.length > 0) {
          const gl = guardian.rows[0].guardian_language === 'en' ? 'en' : 'th';
          const patientLabel = med.display_name
            ? (gl === 'en' ? med.display_name : `คุณ${med.display_name}`)
            : `...${med.patient_id.slice(-6)}`;
          await client.pushMessage({
            to: guardian.rows[0].line_user_id,
            messages: [{ type: 'text', text: S(gl, 'guardian_refill', patientLabel, med.name, daysLeft) }],
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
              p.line_user_id, p.display_name, p.language
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
        const l = appt.language === 'en' ? 'en' : 'th';
        const locale = l === 'en' ? 'en-GB' : 'th-TH';
        const apptTime = new Date(new Date(appt.appointment_at).getTime() + 7 * 3600000);
        const timeStr = apptTime.toLocaleString(locale, { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const name = appt.display_name ? (l === 'en' ? ` ${appt.display_name}` : ` คุณ${appt.display_name}`) : '';
        await client.pushMessage({ to: appt.line_user_id, messages: [{ type: 'text', text: S(l, 'appt_48h', name, appt.title, timeStr) }] });
        await notifyGuardianAppt(appt, 48);
        await pool.query(`UPDATE appointment_reminders SET reminder_48h_sent=TRUE WHERE id=$1`, [appt.id]);
        console.log(`📅 48h reminder sent: ${appt.title}`);
      } catch (err) { console.error('❌ 48h reminder failed:', err.message); }
    }

    // Find appointments needing 24h reminder
    const need24h = await pool.query(
      `SELECT a.id, a.title, a.appointment_at, a.patient_id,
              p.line_user_id, p.display_name, p.language
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
        const l = appt.language === 'en' ? 'en' : 'th';
        const locale = l === 'en' ? 'en-GB' : 'th-TH';
        const apptTime = new Date(new Date(appt.appointment_at).getTime() + 7 * 3600000);
        const timeStr = apptTime.toLocaleString(locale, { weekday: 'long', hour: '2-digit', minute: '2-digit' });
        const name = appt.display_name ? (l === 'en' ? ` ${appt.display_name}` : ` คุณ${appt.display_name}`) : '';
        await client.pushMessage({ to: appt.line_user_id, messages: [{ type: 'text', text: S(l, 'appt_24h', name, appt.title, timeStr) }] });
        await notifyGuardianAppt(appt, 24);
        await pool.query(`UPDATE appointment_reminders SET reminder_24h_sent=TRUE WHERE id=$1`, [appt.id]);
        console.log(`📅 24h reminder sent: ${appt.title}`);
      } catch (err) { console.error('❌ 24h reminder failed:', err.message); }
    }

  } catch (err) { console.error('❌ Appointment cron:', err.message); }
});

async function notifyGuardianAppt(appt, hours) {
  try {
    const guardian = await pool.query(
      `SELECT g.line_user_id, g.language as guardian_language FROM guardians g
       JOIN households h ON h.id=g.household_id
       JOIN patients p ON p.household_id=h.id
       WHERE p.id=$1 AND g.line_user_id IS NOT NULL`,
      [appt.patient_id]
    );
    if (guardian.rows.length === 0) return;

    const gl = guardian.rows[0].guardian_language === 'en' ? 'en' : 'th';
    const locale = gl === 'en' ? 'en-GB' : 'th-TH';
    const apptTime = new Date(new Date(appt.appointment_at).getTime() + 7 * 3600000);
    const timeStr = apptTime.toLocaleString(locale, { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const patientLabel = appt.display_name
      ? (gl === 'en' ? appt.display_name : `คุณ${appt.display_name}`)
      : (gl === 'en' ? 'your parent' : 'ผู้ที่คุณดูแล');

    await client.pushMessage({
      to: guardian.rows[0].line_user_id,
      messages: [{ type: 'text', text: S(gl, 'guardian_appt', patientLabel, hours, appt.title, timeStr) }],
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

// Generate a cryptographically random token.
// These tokens are the sole gate for binding a LINE account to a patient's
// health record, so they MUST come from a CSPRNG — never Math.random().
function generateToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let token = '';
  for (let i = 0; i < 24; i++) {
    token += chars[crypto.randomInt(chars.length)];
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

  // Check if this LINE user already has a patient record.
  // A brand-new invited user already owns an empty "shell" patient that the
  // follow event auto-created (getOrCreatePatient). That shell must NOT block
  // the invite — we detach it and move this LINE user onto the guardian's
  // placeholder patient. Only a fully-onboarded patient is genuinely linked.
  const existingPatient = await pool.query(
    `SELECT id, onboarding_state FROM patients WHERE line_user_id=$1`, [lineUserId]
  );
  if (existingPatient.rows.length > 0) {
    const ex = existingPatient.rows[0];
    if (ex.onboarding_state === 'complete') {
      return { success: false, reason: 'already_linked' };
    }
    if (ex.id !== row.patient_id) {
      // Detach the shell (clear line_user_id first to satisfy the unique
      // constraint before we reassign it to the placeholder below).
      await pool.query(
        `UPDATE patients SET line_user_id=NULL, onboarding_state='superseded' WHERE id=$1`,
        [ex.id]
      );
      clearProfile(ex.id);
      medCache.delete(ex.id);
    }
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
    `SELECT g.line_user_id, g.display_name, g.language as guardian_language FROM guardians g
     WHERE g.household_id=$1`, [row.household_id]
  );

  if (guardianResult.rows.length > 0) {
    const gl = guardianResult.rows[0].guardian_language === 'en' ? 'en' : 'th';
    const guardianName = guardianResult.rows[0].display_name || '';
    const patientLabel = row.display_name || (gl === 'en' ? 'your parent' : 'ท่าน');
    await client.pushMessage({
      to: guardianResult.rows[0].line_user_id,
      messages: [{ type: 'text', text: S(gl, 'guardian_invite_accepted', patientLabel, guardianName) }],
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
  // The footer button must open LINE's share target picker so the guardian can
  // forward the invite to the person they care for. A bare oaMessage deep link
  // (`line.me/R/oaMessage/...`) instead opens the guardian's OWN chat with the
  // bot and fires the token there — wrong recipient. `line.me/R/share?text=`
  // opens the friend/group picker; the patient-tap deep link rides inside the
  // shared text so whoever receives it can tap to connect.
  const shareText = patientName
    ? `ลุงโน้ตช่วยดูแลสุขภาพคุณ${patientName}ครับ 😊\nกดลิงก์นี้เพื่อเริ่มใช้งานได้เลยครับ:\n${deepLink}`
    : `ลุงโน้ตช่วยดูแลสุขภาพครับ 😊\nกดลิงก์นี้เพื่อเริ่มใช้งานได้เลยครับ:\n${deepLink}`;
  const shareUrl = `https://line.me/R/share?text=${encodeURIComponent(shareText)}`;
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
          action: { type: 'uri', label: '📤 ส่งให้ท่านทาง LINE', uri: shareUrl },
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

// Consume an "INVITE_<token>" message and reply with the right status.
// Called from handleEvent before onboarding routing.
async function processInviteMessage(event, lineUserId) {
  const token = event.message.text.trim().slice('INVITE_'.length).trim();
  const result = await handleInviteToken(lineUserId, token);
  // Language unknown at this point — use 'th' default, patient will set it in onboarding
  const inviteLang = 'th';
  let msg;
  if (result.success)                   msg = S(inviteLang, 'invite_welcome', result.patientName);
  else if (result.reason === 'used')    msg = S(inviteLang, 'invite_used');
  else if (result.reason === 'expired') msg = S(inviteLang, 'invite_expired');
  else if (result.reason === 'already_linked') msg = S(inviteLang, 'invite_linked');
  else msg = S(inviteLang, 'invite_invalid');
  await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: msg }]});
}

// ============================================================
// POSTBACK HANDLER — interactive Flex actions (meal-time card)
// ============================================================
async function handlePostback(event) {
  const data = event.postback?.data || '';
  const lineUserId = event.source.userId;
  const patient = await getOrCreatePatient(lineUserId);
  const patientId = patient.id;

  // The meal-time card postbacks fire both during onboarding AND when an
  // already-onboarded user re-opens the editor via "change_times". During
  // onboarding we drive the in-memory profile + advance the flow; afterwards
  // we write straight to the patients row and just acknowledge.
  const onboarding = needsOnboarding(patient);
  const profile = onboarding ? await getProfile(patient) : null;
  const l = onboarding ? (profile.language || 'th') : lang(patient);

  // Ignore unrelated postbacks (keeps future postback uses safe).
  if (!data.startsWith('edit_meal=') && data !== 'meal_times_confirmed') return;

  // 4a. A slot's time was edited via the time wheel.
  if (data.startsWith('edit_meal=')) {
    const slot = data.slice('edit_meal='.length);
    const time = event.postback.params?.time; // 'HH:MM'
    if (!['morning', 'midday', 'evening', 'bedtime'].includes(slot) || !time) return;

    if (onboarding) {
      if (!profile.meal_times) profile.meal_times = { ...DEFAULT_MEAL_TIMES };
      profile.meal_times[slot] = time;
      await persistProfile(patientId, profile, lineUserId);
    } else {
      // slot is whitelisted above, so the column name is safe to interpolate.
      await pool.query(`UPDATE patients SET meal_${slot}=$1 WHERE id=$2`, [time, patientId]);
    }

    // Don't re-send the whole card — the original card's time-pickers and
    // confirm button stay tappable, so re-sending just stacks duplicate cards
    // in the chat. A small confirmation (with a confirm chip so the soft
    // keyboard stays collapsed) is enough; the user keeps editing on the
    // original card and taps confirm when finished.
    const ack = { type: 'text', text: S(l, 'meal_edited', S(l, 'meal_slot_' + slot), time) };
    ack.quickReply = { items: [{
      type: 'action',
      action: { type: 'postback', label: S(l, 'meal_confirm_btn'), data: 'meal_times_confirmed', displayText: S(l, 'meal_confirm_btn') },
    }]};
    await client.replyMessage({ replyToken: event.replyToken, messages: [ack]});
    return; // still editing — do not advance
  }

  // 4b. The user confirmed the times.
  if (data === 'meal_times_confirmed') {
    if (onboarding) {
      if (!profile.meal_times) profile.meal_times = { ...DEFAULT_MEAL_TIMES };
      await persistProfile(patientId, profile, lineUserId);
      await advanceOnboarding(event.replyToken, patient, profile);
    } else {
      // Post-onboarding edit — times already written on each pick; just confirm.
      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text',
        text: l === 'en' ? '✅ Your reminder times are updated.' : '✅ อัปเดตเวลาเตือนเรียบร้อยแล้วครับ 😊' }]});
    }
    return;
  }
}

async function handleEvent(event) {
  // ── Follow event: user adds the bot ───────────────────────
  if (event.type === 'follow') {
    await handleFollow(event);
    return;
  }

  // ── Postback event: interactive Flex actions (e.g. meal-time card) ──
  if (event.type === 'postback') {
    await handlePostback(event);
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

  // Invite token — MUST run before onboarding routing. The invited user
  // already owns a shell patient (auto-created by the follow event), so they
  // would otherwise be sent into self-onboarding and the token never consumed.
  if (event.message.type === 'text' && event.message.text?.trim().startsWith('INVITE_')) {
    await processInviteMessage(event, lineUserId);
    return;
  }

  // Onboarding routing
  if (needsOnboarding(patient)) {
    if (event.message.type === 'image') {
      // A photo during onboarding is almost always a medicine label.
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

  // (Invite tokens are intercepted earlier in handleEvent, before onboarding
  //  routing — they never reach this handler.)

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

  // ── change_times (re-open the meal/reminder-time editor) ───
  if (intent === 'change_times') {
    const patient = await getOrCreatePatient(lineUserId);
    const l = lang(patient);
    // In-chat editable card seeded from the patient's current times.
    const card = buildMealTimeCard(mealProfileFromPatient(patient), l);
    card.quickReply = { items: [{
      type: 'action',
      action: { type: 'postback', label: S(l, 'meal_confirm_btn'), data: 'meal_times_confirmed', displayText: S(l, 'meal_confirm_btn') },
    }]};
    await client.replyMessage({ replyToken: event.replyToken, messages: [
      { type: 'text', text: l === 'en'
        ? 'Here are your reminder times — tap edit to change any.'
        : 'นี่คือเวลาเตือนของคุณครับ กดแก้ไขเพื่อเปลี่ยนได้เลยครับ' },
      card,
    ]});
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

  // ── Templated replies — skip Sonnet for med taken/snooze and plain
  //    readings. A reading bundled with a question still falls through to
  //    Sonnet so it can actually answer; an unparsed reading does too.
  if (intent === 'med_taken' || intent === 'med_snooze' ||
      (intent === 'log_reading' && reading && !QUESTION_RE.test(userMessage))) {
    const lr = await pool.query(`SELECT language FROM patients WHERE id=$1`, [patientId]);
    const tl = lr.rows[0]?.language === 'en' ? 'en' : 'th';
    let replyText;
    if (intent === 'log_reading') {
      const saved = await saveHealthLog(patientId, reading, 'chat');
      replyText = templatedReadingReply(reading, tl);
      if (saved.weightChangeMsg) replyText += `\n\n📊 ${saved.weightChangeMsg}`;
    } else {
      replyText = templatedAck(intent, tl);
      // A med ack may also carry an embedded reading ("กินยาแล้ว 130/85") —
      // save and confirm it too, matching the old fall-through behaviour.
      if (reading) {
        const saved = await saveHealthLog(patientId, reading, 'chat');
        replyText += `\n\n${templatedReadingReply(reading, tl)}`;
        if (saved.weightChangeMsg) replyText += `\n\n📊 ${saved.weightChangeMsg}`;
      }
    }
    await saveMessage(patientId, 'user', userMessage, 'text');
    await saveMessage(patientId, 'assistant', replyText, 'text');
    await incrementQuota(patientId, 'message');
    await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] });
    return;
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

    // When a reading was parsed, the user-facing confirmation comes from a
    // deterministic template (keyed on alert_level) — not Haiku's prose,
    // which can slip on tone/safety. Haiku still does the value reading.
    if (photoReading) {
      const saved = await saveHealthLog(patientId, photoReading, 'photo');
      const lr = await pool.query(`SELECT language FROM patients WHERE id=$1`, [patientId]);
      const tl = lr.rows[0]?.language === 'en' ? 'en' : 'th';
      replyText = templatedReadingReply(photoReading, tl, true);
      if (saved.weightChangeMsg) replyText += `\n\n📊 ${saved.weightChangeMsg}`;
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ลุงโน้ต is awake on port ${PORT}!`));