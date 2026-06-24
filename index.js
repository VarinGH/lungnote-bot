import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import cron from 'node-cron';

const { Pool } = pg;

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Database connected'))
  .catch(err => console.error('❌ Database connection failed:', err.message));

// --- LINE ---
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

// --- Anthropic ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();

// --- Bot personality ---
const SYSTEM_PROMPT = `
คุณคือ "ลุงโน้ต" ผู้ช่วยดูแลสุขภาพบน LINE สำหรับผู้สูงอายุไทย

กฎ:
- พูดอบอุ่น กระชับ ไม่เกิน 3 บรรทัดต่อการตอบ
- ลงท้ายด้วย "ครับ" เสมอ
- เมื่อเตือนยา ให้บอกชื่อยาและขนาดยาด้วย
- หากค่าใดผิดปกติ ให้แนะนำพบแพทย์ด้วยความห่วงใย แต่ห้ามบอกว่าเป็นโรคอะไร หรือวินิจฉัยอาการ เช่น ห้ามพูดว่า "อาจมีน้ำคั่ง" หรือ "น่าจะเป็นเบาหวาน" — บอกแค่ว่าค่าผิดปกติและควรพบแพทย์
- รับข้อมูลทั้งภาษาไทยและตัวเลข เช่น "130/85" หรือ "กินยาแล้ว"
- เมื่อผู้ใช้ส่งรูปมา ให้อ่านค่าอย่างระมัดระวัง แล้วทวนให้ผู้ใช้ยืนยันก่อนเสมอ
- ถ้ารูปไม่ชัดหรืออ่านไม่ออก ให้ขอถ่ายใหม่ อย่าเดาค่าเอง
- ห้ามวินิจฉัยโรค ห้ามแนะนำยา ห้ามบอกสาเหตุของอาการ — หน้าที่ลุงคือบันทึกและแจ้งเตือนเท่านั้น
`;

// ============================================================
// HEALTH READING PARSER
// Detects and parses health values from user messages
// ============================================================

function parseHealthReading(text) {
  // Blood pressure: 130/85 or 130/85 mmHg
  const bpMatch = text.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bpMatch) {
    const systolic = parseFloat(bpMatch[1]);
    const diastolic = parseFloat(bpMatch[2]);
    // Sanity check — realistic BP range
    if (systolic >= 60 && systolic <= 250 && diastolic >= 40 && diastolic <= 150) {
      return {
        type: 'bp',
        value_1: systolic,
        value_2: diastolic,
        unit: 'mmHg',
        alert_level: classifyBP(systolic, diastolic),
      };
    }
  }

  // SpO2: 97% or SpO2 97 or ออกซิเจน 97
  const spo2Match = text.match(/(?:spo2|ออกซิเจน|o2)[^\d]*(\d{2,3})\s*%?/i)
    || text.match(/(\d{2,3})\s*%(?!\s*น้ำตาล)/i);
  if (spo2Match) {
    const spo2 = parseFloat(spo2Match[1]);
    if (spo2 >= 70 && spo2 <= 100) {
      return {
        type: 'spo2',
        value_1: spo2,
        value_2: null,
        unit: 'pct',
        alert_level: classifySpO2(spo2),
      };
    }
  }

  // Temperature: 37.5 องศา or อุณหภูมิ 38.2 or temp 37.5
  const tempMatch = text.match(/(?:อุณหภูมิ|ไข้|temp(?:erature)?)[^\d]*(\d{2}(?:\.\d)?)/i)
    || text.match(/(\d{2}(?:\.\d)?)\s*(?:องศา|°c|c\b)/i);
  if (tempMatch) {
    const temp = parseFloat(tempMatch[1]);
    if (temp >= 35 && temp <= 42) {
      return {
        type: 'temp',
        value_1: temp,
        value_2: null,
        unit: 'C',
        alert_level: classifyTemp(temp),
      };
    }
  }

  // Glucose: น้ำตาล 120 or glucose 120 or 6.5 mmol (stored as mg/dL)
  const glucoseMatch = text.match(/(?:น้ำตาล|glucose|blood sugar)[^\d]*(\d+(?:\.\d+)?)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:mmol|mg\/dl)/i);
  if (glucoseMatch) {
    const glucose = parseFloat(glucoseMatch[1]);
    if (glucose >= 1 && glucose <= 600) {
      // Convert to mg/dL if user entered mmol/L (values <= 30 are almost certainly mmol)
      const mgdlValue = glucose <= 30 ? glucose * 18 : glucose;
      return {
        type: 'glucose',
        value_1: parseFloat(mgdlValue.toFixed(0)),
        value_2: null,
        unit: 'mgdl',
        alert_level: classifyGlucose(mgdlValue),
      };
    }
  }

  // Weight: น้ำหนัก 65 kg or 65 กก
  const weightMatch = text.match(/(?:น้ำหนัก|weight)[^\d]*(\d+(?:\.\d+)?)/i)
    || text.match(/(\d+(?:\.\d+)?)\s*(?:กก|kg|กิโล)/i);
  if (weightMatch) {
    const weight = parseFloat(weightMatch[1]);
    if (weight >= 20 && weight <= 300) {
      return {
        type: 'weight',
        value_1: weight,
        value_2: null,
        unit: 'kg',
        alert_level: 'pending', // resolved after DB lookup for previous weight
      };
    }
  }

  return null;
}

// ============================================================
// ALERT CLASSIFIERS
// ============================================================

function classifyBP(systolic, diastolic) {
  if (systolic > 180 || diastolic > 110) return 'urgent';
  if (systolic > 140 || diastolic > 90)  return 'watch';
  if (systolic < 80  || diastolic < 50)  return 'urgent';
  if (systolic < 90  || diastolic < 60)  return 'watch';
  return 'normal';
}

function classifySpO2(spo2) {
  if (spo2 < 92) return 'urgent';
  if (spo2 < 95) return 'watch';
  return 'normal';
}

function classifyTemp(temp) {
  if (temp > 38)    return 'urgent';
  if (temp >= 37.5) return 'watch';
  if (temp < 35.5)  return 'urgent';
  if (temp < 36)    return 'watch';
  return 'normal';
}

function classifyGlucose(mgdl) {
  if (mgdl > 270) return 'urgent';
  if (mgdl > 180) return 'watch';
  if (mgdl < 54)  return 'urgent';
  if (mgdl < 70)  return 'watch';
  return 'normal';
}

function classifyWeightChange(changeKg) {
  const abs = Math.abs(changeKg);
  if (abs >= 2) return 'urgent';  // ±2kg = dangerous fluid shift
  if (abs >= 1) return 'watch';   // ±1kg = worth monitoring
  return 'normal';
}

// ============================================================
// SAVE HEALTH LOG + CREATE ALERT IF NEEDED
// Only call this after the user has CONFIRMED the reading
// ============================================================

async function saveHealthLog(patientId, reading, source = 'chat') {
  // --- Special handling for weight: compare against previous readings ---
  let weightChangeMsg = null;
  if (reading.type === 'weight') {
    const currentWeight = reading.value_1;

    // --- 1. Daily change (acute: heart failure / dialysis) ---
    const prev = await pool.query(
      `SELECT value_1, recorded_at FROM health_logs
       WHERE patient_id = $1 AND type = 'weight' AND confirmed = TRUE
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [patientId]
    );

    let dailyChangeMsg = null;
    if (prev.rows.length > 0) {
      const prevWeight = parseFloat(prev.rows[0].value_1);
      const changeKg = currentWeight - prevWeight;
      const prevDate = new Date(prev.rows[0].recorded_at);
      const daysDiff = Math.round(
        (Date.now() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      reading.alert_level = classifyWeightChange(changeKg);
      reading.value_2 = parseFloat(changeKg.toFixed(1));

      const direction = changeKg > 0 ? '⬆️ เพิ่มขึ้น' : '⬇️ ลดลง';
      const absChange = Math.abs(changeKg).toFixed(1);
      const dayLabel = daysDiff === 0
        ? 'วันนี้' : daysDiff === 1
        ? 'เมื่อวาน' : `${daysDiff} วันที่แล้ว`;

      if (reading.alert_level === 'urgent') {
        dailyChangeMsg =
          `${direction} ${absChange} กก จากครั้งก่อน (${dayLabel})\n` +
          `⚠️ น้ำหนักเปลี่ยนแปลงมาก ควรพบแพทย์โดยเร็วนะครับ`;
      } else if (reading.alert_level === 'watch') {
        dailyChangeMsg =
          `${direction} ${absChange} กก จากครั้งก่อน (${dayLabel})\n` +
          `ลุงจะคอยติดตามให้นะครับ`;
      } else {
        dailyChangeMsg = `${direction} ${absChange} กก จากครั้งก่อน (${dayLabel}) — ปกติดีครับ`;
      }
    } else {
      reading.alert_level = 'normal';
      dailyChangeMsg = 'บันทึกน้ำหนักครั้งแรกแล้วครับ ลุงจะคอยติดตามให้ทุกวันนะครับ 📊';
    }

    // --- 2. GLIM criteria: unintentional weight loss ---
    // >5% within 6 months OR >10% beyond 6 months
    let glimMsg = null;

    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    // Get oldest reading within 6 months
    const within6mo = await pool.query(
      `SELECT value_1, recorded_at FROM health_logs
       WHERE patient_id = $1 AND type = 'weight' AND confirmed = TRUE
       AND recorded_at >= $2
       ORDER BY recorded_at ASC
       LIMIT 1`,
      [patientId, sixMonthsAgo]
    );

    // Get oldest reading between 6-12 months ago
    const beyond6mo = await pool.query(
      `SELECT value_1, recorded_at FROM health_logs
       WHERE patient_id = $1 AND type = 'weight' AND confirmed = TRUE
       AND recorded_at >= $2 AND recorded_at < $3
       ORDER BY recorded_at ASC
       LIMIT 1`,
      [patientId, twelveMonthsAgo, sixMonthsAgo]
    );

    if (within6mo.rows.length > 0) {
      const baseWeight = parseFloat(within6mo.rows[0].value_1);
      const lossPct = ((baseWeight - currentWeight) / baseWeight) * 100;
      if (lossPct >= 5) {
        glimMsg =
          `📉 น้ำหนักลดลง ${lossPct.toFixed(1)}% ใน 6 เดือนที่ผ่านมา\n` +
          `⚠️ ควรพบแพทย์เพื่อตรวจประเมินนะครับ (GLIM criteria)`;
        // Escalate alert level if not already urgent
        if (reading.alert_level !== 'urgent') reading.alert_level = 'watch';
      }
    }

    if (!glimMsg && beyond6mo.rows.length > 0) {
      const baseWeight = parseFloat(beyond6mo.rows[0].value_1);
      const lossPct = ((baseWeight - currentWeight) / baseWeight) * 100;
      if (lossPct >= 10) {
        glimMsg =
          `📉 น้ำหนักลดลง ${lossPct.toFixed(1)}% เกิน 6 เดือน\n` +
          `⚠️ ควรพบแพทย์เพื่อตรวจประเมินนะครับ (GLIM criteria)`;
        if (reading.alert_level !== 'urgent') reading.alert_level = 'watch';
      }
    }

    weightChangeMsg = glimMsg
      ? `${dailyChangeMsg}\n\n${glimMsg}`
      : dailyChangeMsg;
  }
  // Insert into health_logs with confirmed = TRUE
  const result = await pool.query(
    `INSERT INTO health_logs
       (patient_id, type, value_1, value_2, unit, alert_level, confirmed, source)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
     RETURNING id`,
    [
      patientId,
      reading.type,
      reading.value_1,
      reading.value_2,
      reading.unit,
      reading.alert_level,
      source,
    ]
  );

  const logId = result.rows[0].id;
  console.log(`✅ Health log saved: ${reading.type} ${reading.value_1} [${reading.alert_level}]`);

  // If abnormal, create an alert record and notify guardian
  if (reading.alert_level !== 'normal' && reading.alert_level !== 'pending') {
    const alertResult = await pool.query(
      `INSERT INTO alerts
         (health_log_id, patient_id, type, severity, guardian_notified)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id`,
      [logId, patientId, `${reading.alert_level}_${reading.type}`, reading.alert_level]
    );
    const alertId = alertResult.rows[0].id;
    console.log(`🚨 Alert created: ${reading.type} ${reading.alert_level} for patient ${patientId}`);

    // Push to guardian (non-blocking — runs in background)
    notifyGuardian(patientId, reading, alertId);
  }

  return { logId, alertLevel: reading.alert_level, weightChangeMsg };
}

// ============================================================
// CAREGIVER ALERTS
// Push guardian when a reading is watch or urgent
// ============================================================

async function notifyGuardian(patientId, reading, alertId) {
  try {
    // Find guardian for this patient's household
    const result = await pool.query(
      `SELECT g.line_user_id, g.display_name, g.notification_level,
              p.display_name as patient_name
       FROM guardians g
       JOIN households h ON h.id = g.household_id
       JOIN patients p ON p.household_id = h.id
       WHERE p.id = $1
       AND g.line_user_id IS NOT NULL`,
      [patientId]
    );

    if (result.rows.length === 0) return; // Solo mode — no guardian to notify

    const guardian = result.rows[0];

    // Respect notification_level preference
    if (
      guardian.notification_level === 'summary_only' ||
      (guardian.notification_level === 'daily' && reading.alert_level === 'watch')
    ) return;

    const patientLabel = guardian.patient_name
      ? `คุณ${guardian.patient_name}`
      : `ผู้ใช้ ...${patientId.slice(-6)}`; // fallback to last 6 chars of patient UUID

    const emoji = reading.alert_level === 'urgent' ? '🚨' : '⚠️';
    const urgencyLabel = reading.alert_level === 'urgent'
      ? 'ค่าผิดปกติ — ควรพบแพทย์โดยเร็ว'
      : 'ค่าที่ควรติดตาม';

    // Format the reading value clearly
    let readingText = '';
    if (reading.type === 'bp') {
      readingText = `ความดัน ${reading.value_1}/${reading.value_2} mmHg`;
    } else if (reading.type === 'glucose') {
      readingText = `น้ำตาล ${reading.value_1} mg/dL`;
    } else if (reading.type === 'spo2') {
      readingText = `ออกซิเจน ${reading.value_1}%${reading.value_2 ? ` ชีพจร ${reading.value_2} ครั้ง/นาที` : ''}`;
    } else if (reading.type === 'temp') {
      readingText = `อุณหภูมิ ${reading.value_1}°C`;
    } else if (reading.type === 'weight') {
      const change = reading.value_2
        ? ` (${reading.value_2 > 0 ? '+' : ''}${reading.value_2} กก)`
        : '';
      readingText = `น้ำหนัก ${reading.value_1} กก${change}`;
    }

    const message =
      `${emoji} แจ้งเตือนจากลุงโน้ต\n` +
      `${patientLabel}: ${readingText}\n` +
      `${urgencyLabel}ครับ`;

    await client.pushMessage({
      to: guardian.line_user_id,
      messages: [{ type: 'text', text: message }],
    });

    // Mark alert as notified
    await pool.query(
      `UPDATE alerts SET guardian_notified = TRUE WHERE id = $1`,
      [alertId]
    );

    console.log(`📲 Guardian notified: ${reading.type} ${reading.alert_level} → ${guardian.line_user_id}`);

  } catch (err) {
    console.error('❌ Guardian notification failed:', err.message);
    // Non-fatal — don't let alert failure break the bot
  }
}

async function getOrCreatePatient(lineUserId) {
  const existing = await pool.query(
    'SELECT * FROM patients WHERE line_user_id = $1',
    [lineUserId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // Brand new user — create household + patient in 'new' onboarding state
  const hhResult = await pool.query(
    `INSERT INTO households (mode) VALUES ('solo') RETURNING id`
  );
  const householdId = hhResult.rows[0].id;

  const patientResult = await pool.query(
    `INSERT INTO patients (household_id, line_user_id, care_mode, onboarding_state)
     VALUES ($1, $2, 'self', 'new') RETURNING *`,
    [householdId, lineUserId]
  );

  await pool.query(
    `INSERT INTO subscriptions (household_id, status) VALUES ($1, 'trial')`,
    [householdId]
  );

  console.log(`✅ New patient created: ${patientResult.rows[0].id}`);
  return patientResult.rows[0];
}

function needsOnboarding(patient) {
  return !patient.onboarding_state || patient.onboarding_state !== 'complete';
}

async function setOnboardingState(patientId, state) {
  await pool.query(
    `UPDATE patients SET onboarding_state = $1 WHERE id = $2`,
    [state, patientId]
  );
}

function buildQuickReply(text, buttons) {
  return {
    type: 'text',
    text,
    quickReply: {
      items: buttons.map(b => ({
        type: 'action',
        action: { type: 'message', label: b.label, text: b.text || b.label },
      })),
    },
  };
}

// ============================================================
// INTENT CLASSIFIER
// Uses Haiku to understand natural language in onboarding.
// Returns a simple intent string so we don't need rigid keywords.
// ============================================================

async function classifyIntent(text, context) {
  const prompts = {
    done_or_more:
      `User said: "${text}"\nAre they saying they are DONE (finished, no more items, that's all) or do they have MORE items to add? Or are they saying something else entirely?\nReply with exactly one word: DONE, MORE, or OTHER`,

    mode_choice:
      `User said: "${text}"\nAre they saying they want to use this app for THEMSELVES (self-care, solo) or for a FAMILY member (parent, spouse, someone else)? Or unclear?\nReply with exactly one word: SELF, FAMILY, or UNCLEAR`,

    has_conditions:
      `User said: "${text}"\nAre they listing medical conditions (blood pressure, diabetes, heart disease etc) or saying they have NONE?\nReply with exactly one word: HAS_CONDITIONS, NO_CONDITIONS, or UNCLEAR`,

    has_meds:
      `User said: "${text}"\nAre they saying they have medications to list (yes, have meds, want to type or photo) or NO medications?\nReply with exactly one word: HAS_MEDS, NO_MEDS, or UNCLEAR`,

    correct_or_edit:
      `User said: "${text}"\nAre they confirming the information is CORRECT (yes, right, ok, looks good) or do they want to EDIT something (wrong, fix, change)?\nReply with exactly one word: CORRECT, EDIT, or UNCLEAR`,
  };

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10, // just one word needed
      messages: [{ role: 'user', content: prompts[context] }],
    });
    return response.content.find(b => b.type === 'text')?.text?.trim().toUpperCase() || 'UNCLEAR';
  } catch (err) {
    console.error('Intent classification failed:', err.message);
    return 'UNCLEAR';
  }
}
  const replyToken = event.replyToken;
  const text = event.message?.text?.trim() || '';
  const patientId = patient.id;
  const state = patient.onboarding_state || 'new';

  // STATE: new → greet and ask name
  if (state === 'new') {
    await setOnboardingState(patientId, 'asking_name');
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: 'สวัสดีครับ ผมลุงโน้ต ผู้ช่วยดูแลสุขภาพครับ 😊\nขอทราบชื่อของคุณด้วยได้ไหมครับ? (พิมพ์ชื่อได้เลยครับ)' }],
    });
    return;
  }

  // STATE: asking_name → save name, ask mode
  if (state === 'asking_name') {
    if (!text || text.length < 1) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: 'ขอโทษครับ ลุงยังไม่ได้ยินชื่อ ช่วยพิมพ์ชื่อมาอีกครั้งได้ไหมครับ?' }],
      });
      return;
    }
    await pool.query(`UPDATE patients SET display_name = $1 WHERE id = $2`, [text, patientId]);
    await setOnboardingState(patientId, 'asking_mode');
    await client.replyMessage({
      replyToken,
      messages: [buildQuickReply(
        `ยินดีที่ได้รู้จักคุณ${text}ครับ 😊\n\nลุงโน้ตจะดูแลใครครับ?`,
        [
          { label: '🧓 ดูแลตัวเอง',           text: 'ดูแลตัวเอง' },
          { label: '👨‍👩‍👧 ดูแลคุณพ่อคุณแม่',  text: 'ดูแลพ่อแม่' },
        ]
      )],
    });
    return;
  }

  // STATE: asking_mode → set mode, branch
  if (state === 'asking_mode') {
    const intent = await classifyIntent(text, 'mode_choice');

    if (intent === 'UNCLEAR') {
      await client.replyMessage({
        replyToken,
        messages: [buildQuickReply('ขอโทษครับ ลุงยังไม่เข้าใจ — เลือกได้เลยครับ:', [
          { label: '🧓 ดูแลตัวเอง',           text: 'ดูแลตัวเอง' },
          { label: '👨‍👩‍👧 ดูแลคุณพ่อคุณแม่',  text: 'ดูแลพ่อแม่' },
        ])],
      });
      return;
    }

    if (intent === 'FAMILY') {
      await pool.query(
        `UPDATE households SET mode = 'guardian'
         WHERE id = (SELECT household_id FROM patients WHERE id = $1)`, [patientId]
      );
      await pool.query(`UPDATE patients SET care_mode = 'family' WHERE id = $1`, [patientId]);
      await setOnboardingState(patientId, 'complete');
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: 'ดีมากเลยครับที่ดูแลคุณพ่อคุณแม่ 🙏\nระบบเชิญสมาชิกกำลังพัฒนาอยู่ครับ เร็ว ๆ นี้จะใช้ได้เลยครับ ตอนนี้ใช้งานบอทได้ปกติก่อนเลยนะครับ' }],
      });
      return;
    }

    // Solo → ask conditions
    await setOnboardingState(patientId, 'asking_conditions');
    await client.replyMessage({
      replyToken,
      messages: [buildQuickReply(
        'รับทราบครับ 😊 ขอถามนิดนึงนะครับ — มีโรคประจำตัวไหมครับ?',
        [
          { label: '❤️ ความดัน',        text: 'ความดัน' },
          { label: '🩸 เบาหวาน',        text: 'เบาหวาน' },
          { label: '❤️🩸 ทั้งสองอย่าง', text: 'ความดันและเบาหวาน' },
          { label: '✨ ไม่มี',           text: 'ไม่มี' },
        ]
      )],
    });
    return;
  }

  // STATE: asking_conditions → save, ask meds
  if (state === 'asking_conditions') {
    const intent = await classifyIntent(text, 'has_conditions');
    const conditions = intent === 'NO_CONDITIONS' ? null : text;
    await pool.query(`UPDATE patients SET conditions = $1 WHERE id = $2`, [conditions, patientId]);
    await setOnboardingState(patientId, 'asking_meds');
    await client.replyMessage({
      replyToken,
      messages: [buildQuickReply(
        'รับทราบครับ 👍\nตอนนี้ทานยาประจำอยู่ไหมครับ? ถ้ามีบอกชื่อยามาได้เลย หรือถ่ายรูปฉลากยาส่งมาก็ได้ครับ 💊',
        [
          { label: '💊 มียา — พิมพ์บอกลุง', text: 'มียา' },
          { label: '📷 ถ่ายรูปฉลากยา',      text: 'ถ่ายรูปยา' },
          { label: '🚫 ไม่มียา',             text: 'ไม่มียา' },
        ]
      )],
    });
    return;
  }

// ============================================================
// MEDICATION PARSER
// Extracts name, dosage, and schedule times from natural text
// ============================================================

function parseMedication(text) {
  // --- Schedule time mapping ---
  const timeMap = {
    'เช้า':       '08:00',
    'กลางวัน':    '12:00',
    'เที่ยง':     '12:00',
    'บ่าย':       '14:00',
    'เย็น':       '18:00',
    'ก่อนนอน':   '21:00',
    'นอน':        '21:00',
    'กลางคืน':   '21:00',
    'ดึก':        '22:00',
  };

  // Shorthand patterns → multiple times
  const shorthand = {
    'วันละครั้ง':         ['08:00'],
    'วันละ1ครั้ง':        ['08:00'],
    'วันละ 1 ครั้ง':      ['08:00'],
    'เช้าเย็น':           ['08:00', '18:00'],
    'เช้ากลางวันเย็น':    ['08:00', '12:00', '18:00'],
    'เช้า กลางวัน เย็น':  ['08:00', '12:00', '18:00'],
    'สามมื้อ':            ['08:00', '12:00', '18:00'],
    '3มื้อ':              ['08:00', '12:00', '18:00'],
    'เช้าเย็นก่อนนอน':   ['08:00', '18:00', '21:00'],
  };

  // Build schedule array
  let schedule = [];

  // Check shorthand first
  for (const [pattern, times] of Object.entries(shorthand)) {
    if (text.includes(pattern)) {
      schedule = times;
      break;
    }
  }

  // If no shorthand, scan for individual time keywords
  if (schedule.length === 0) {
    for (const [word, time] of Object.entries(timeMap)) {
      if (text.includes(word) && !schedule.includes(time)) {
        schedule.push(time);
      }
    }
  }

  // Check for explicit HH:MM times e.g. "08:00" "9:30"
  const explicitTimes = text.match(/\b([0-9]{1,2}:[0-9]{2})\b/g);
  if (explicitTimes) {
    explicitTimes.forEach(t => {
      const padded = t.padStart(5, '0');
      if (!schedule.includes(padded)) schedule.push(padded);
    });
  }

  // Default to morning if no time detected at all
  if (schedule.length === 0) schedule = ['08:00'];

  // Sort schedule chronologically
  schedule.sort();

  // --- Extract dosage: look for number + unit ---
  const dosageMatch = text.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|เม็ด|แคปซูล|ช้อน|ซีซี)/i);
  const dosage = dosageMatch ? `${dosageMatch[1]}${dosageMatch[2]}` : null;

  // --- Extract medication name ---
  // Remove dosage, schedule keywords, and common Thai filler words
  let name = text
    .replace(/\d+(?:\.\d+)?\s*(mg|mcg|ml|เม็ด|แคปซูล|ช้อน|ซีซี)/gi, '')
    .replace(/วันละ\s*\d+\s*ครั้ง/g, '')
    .replace(/กิน|ทาน|รับประทาน|ยา/g, '')
    .replace(new RegExp(Object.keys(shorthand).join('|'), 'g'), '')
    .replace(new RegExp(Object.keys(timeMap).join('|'), 'g'), '')
    .replace(/\b([0-9]{1,2}:[0-9]{2})\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If name is empty after stripping, use the original text truncated
  if (!name || name.length < 2) name = text.split(' ')[0];

  return { name, dosage, schedule };
}

function hasTimeInfo(text) {
  const timeWords = [
    'เช้า', 'กลางวัน', 'เที่ยง', 'บ่าย', 'เย็น', 'ก่อนนอน', 'นอน', 'กลางคืน', 'ดึก',
    'วันละ', 'เช้าเย็น', 'สามมื้อ', '3มื้อ',
  ];
  const hasExplicitTime = /\b([0-9]{1,2}:[0-9]{2})\b/.test(text);
  return hasExplicitTime || timeWords.some(w => text.includes(w));
}

async function saveMedicationWithSchedule(patientId, name, dosage, schedule, source = 'chat') {
  const result = await pool.query(
    `INSERT INTO medications (patient_id, name, dosage, schedule, active, source)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     RETURNING id, name, dosage, schedule`,
    [patientId, name, dosage, schedule, source]
  );
  console.log(`💊 Medication saved: ${name} ${dosage || ''} @ ${schedule.join(', ')}`);
  return result.rows[0];
}

// Format saved medication for confirmation message
function formatMedConfirmation(med) {
  const timeLabels = {
    '08:00': 'เช้า', '12:00': 'กลางวัน', '14:00': 'บ่าย',
    '18:00': 'เย็น', '21:00': 'ก่อนนอน', '22:00': 'กลางคืน',
  };
  const scheduleLabel = med.schedule
    .map(t => timeLabels[t] || t)
    .join(', ');
  return `${med.name}${med.dosage ? ` ${med.dosage}` : ''} — ${scheduleLabel}`;
}

// Build a LINE Flex Message card listing all medications
async function buildMedCard(patientId, headerText = '💊 รายการยาของคุณ') {
  const result = await pool.query(
    `SELECT name, dosage, schedule FROM medications
     WHERE patient_id = $1 AND active = TRUE
     ORDER BY created_at`,
    [patientId]
  );

  const timeLabels = {
    '08:00': 'เช้า', '12:00': 'กลางวัน', '14:00': 'บ่าย',
    '18:00': 'เย็น', '21:00': 'ก่อนนอน', '22:00': 'กลางคืน',
  };

  const rows = result.rows.map(m => {
    const times = m.schedule.map(t => timeLabels[t] || t).join(', ');
    const label = `${m.name}${m.dosage ? ` ${m.dosage}` : ''}`;
    return {
      type: 'box',
      layout: 'horizontal',
      contents: [
        { type: 'text', text: label, size: 'sm', color: '#1a1a1a', flex: 3, wrap: true },
        { type: 'text', text: times, size: 'sm', color: '#555555', flex: 2, align: 'end', wrap: true },
      ],
      paddingTop: '8px',
      paddingBottom: '8px',
      borderWidth: '1px',
      borderColor: '#eeeeee',
      cornerRadius: '4px',
    };
  });

  return {
    type: 'flex',
    altText: headerText,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'text',
          text: headerText,
          weight: 'bold',
          size: 'md',
          color: '#ffffff',
        }],
        backgroundColor: '#06C755',
        paddingAll: '14px',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: rows.length > 0 ? rows : [{
          type: 'text',
          text: 'ยังไม่มีรายการยาครับ',
          size: 'sm',
          color: '#999999',
        }],
        paddingAll: '12px',
        spacing: 'none',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'text',
          text: `รวม ${rows.length} รายการ · แจ้งลุงเพื่อแก้ไขได้เลยครับ`,
          size: 'xs',
          color: '#aaaaaa',
          align: 'center',
        }],
        paddingAll: '10px',
      },
    },
  };
}
  if (state === 'asking_meds') {
    const noMeds      = text.includes('ไม่มียา');
    const wantToType  = text.includes('มียา');
    const wantPhoto   = text.includes('ถ่ายรูปยา');

    if (noMeds) {
      await setOnboardingState(patientId, 'complete');
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text',
          text: `เรียบร้อยครับ คุณ${patient.display_name || ''} 🎉\nลุงโน้ตพร้อมดูแลแล้วครับ! บอกค่าความดัน น้ำตาล หรืออาการมาได้เลยนะครับ` }],
      });
      return;
    }

    if (wantPhoto) {
      await setOnboardingState(patientId, 'asking_more_meds');
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text',
          text: 'ถ่ายรูปฉลากยามาได้เลยครับ ลุงจะอ่านและจดไว้ให้ครับ 📷' }],
      });
      return;
    }

    if (wantToType) {
      await setOnboardingState(patientId, 'asking_more_meds');
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text',
          text: 'พิมพ์ชื่อยามาได้เลยครับ เช่น\n"Amlodipine 5mg กินเช้า"\n"metformin 500mg เช้าเย็น"\nบอกทีละตัวก็ได้ครับ 💊' }],
      });
      return;
    }

    // User typed a med name directly without pressing a button
    const { name, dosage, schedule } = parseMedication(text);
    if (name && name.length >= 2) {
      if (!hasTimeInfo(text)) {
        // No time detected — ask explicitly before saving
        await pool.query(
          `UPDATE patients SET pending_med_name = $1, pending_med_dosage = $2 WHERE id = $3`,
          [name, dosage, patientId]
        );
        await setOnboardingState(patientId, 'asking_med_time');
        await client.replyMessage({
          replyToken,
          messages: [buildQuickReply(
            `${name}${dosage ? ` ${dosage}` : ''} — ทานตอนไหนครับ?`,
            [
              { label: '🌅 เช้า',           text: 'เช้า' },
              { label: '☀️ กลางวัน',        text: 'กลางวัน' },
              { label: '🌆 เย็น',           text: 'เย็น' },
              { label: '🌙 ก่อนนอน',        text: 'ก่อนนอน' },
              { label: '🌅☀️🌆 เช้าเย็น',  text: 'เช้าเย็น' },
              { label: '3 มื้อ',            text: 'เช้ากลางวันเย็น' },
            ]
          )],
        });
        return;
      }

      const med = await saveMedicationWithSchedule(patientId, name, dosage, schedule, 'chat');
      await setOnboardingState(patientId, 'asking_more_meds');
      await client.replyMessage({
        replyToken,
        messages: [buildQuickReply(
          `จดไว้แล้วครับ 💊\n✅ ${formatMedConfirmation(med)}\n\nมียาตัวอื่นอีกไหมครับ?`,
          [
            { label: '💊 มียาอีก', text: 'มียาอีก' },
            { label: '✅ หมดแล้ว', text: 'หมดแล้ว' },
          ]
        )],
      });
      return;
    }

    // Could not parse name — ask again
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text',
        text: 'ขอโทษครับ ลุงอ่านไม่ออก ช่วยพิมพ์ชื่อยาใหม่อีกครั้งได้ไหมครับ? เช่น "Amlodipine 5mg"' }],
    });
    return;
  }

  // STATE: asking_med_time → save med with the chosen time then continue
  if (state === 'asking_med_time') {
    const pendingResult = await pool.query(
      `SELECT pending_med_name, pending_med_dosage FROM patients WHERE id = $1`,
      [patientId]
    );
    const { pending_med_name, pending_med_dosage } = pendingResult.rows[0];
    const { schedule } = parseMedication(text); // parse the time answer
    const finalSchedule = schedule.length > 0 ? schedule : ['08:00'];

    const med = await saveMedicationWithSchedule(
      patientId, pending_med_name, pending_med_dosage, finalSchedule, 'chat'
    );

    // Clear pending fields
    await pool.query(
      `UPDATE patients SET pending_med_name = NULL, pending_med_dosage = NULL WHERE id = $1`,
      [patientId]
    );
    await setOnboardingState(patientId, 'asking_more_meds');

    await client.replyMessage({
      replyToken,
      messages: [buildQuickReply(
        `จดไว้แล้วครับ 💊\n✅ ${formatMedConfirmation(med)}\n\nมียาตัวอื่นอีกไหมครับ?`,
        [
          { label: '💊 มียาอีก', text: 'มียาอีก' },
          { label: '✅ หมดแล้ว', text: 'หมดแล้ว' },
        ]
      )],
    });
    return;
  }

  // STATE: asking_more_meds → loop for additional meds
  if (state === 'asking_more_meds') {
    const done = text.includes('หมดแล้ว') || text.includes('ไม่มีแล้ว') || text.includes('เท่านี้') || text.includes('ถูกต้อง') || text.includes('ใช่');
    const more = text.includes('มียาอีก');
    const notCorrect = text.includes('ไม่ถูก') || text.includes('แก้ไข') || text.includes('ผิด');

    if (notCorrect) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text',
          text: 'บอกลุงได้เลยครับ ว่าอยากแก้ไขยาตัวไหน หรือเพิ่ม/ลบอะไรครับ?' }],
      });
      return;
    }

    if (done) {
      await setOnboardingState(patientId, 'complete');
      // Show Flex card + confirmation
      const card = await buildMedCard(patientId, '💊 รายการยาที่ลุงจดไว้');
      await client.replyMessage({
        replyToken,
        messages: [
          card,
          buildQuickReply(
            `ข้อมูลยาถูกต้องไหมครับ คุณ${patient.display_name || ''}?\nลุงจะเตือนยาตามเวลาที่จดไว้เลยครับ ⏰`,
            [
              { label: '✅ ถูกต้องแล้ว',   text: 'ถูกต้องแล้ว' },
              { label: '✏️ แก้ไขบางอย่าง', text: 'อยากแก้ไข' },
            ]
          ),
        ],
      });
      return;
    }

    if (more) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text',
          text: 'พิมพ์ชื่อยาตัวต่อไปได้เลยครับ 💊' }],
      });
      return;
    }

    // User typed another med name
    const { name, dosage, schedule } = parseMedication(text);
    if (name && name.length >= 2) {
      if (!hasTimeInfo(text)) {
        // No time — ask before saving
        await pool.query(
          `UPDATE patients SET pending_med_name = $1, pending_med_dosage = $2 WHERE id = $3`,
          [name, dosage, patientId]
        );
        await setOnboardingState(patientId, 'asking_med_time');
        await client.replyMessage({
          replyToken,
          messages: [buildQuickReply(
            `${name}${dosage ? ` ${dosage}` : ''} — ทานตอนไหนครับ?`,
            [
              { label: '🌅 เช้า',          text: 'เช้า' },
              { label: '☀️ กลางวัน',       text: 'กลางวัน' },
              { label: '🌆 เย็น',          text: 'เย็น' },
              { label: '🌙 ก่อนนอน',       text: 'ก่อนนอน' },
              { label: '🌅☀️🌆 เช้าเย็น', text: 'เช้าเย็น' },
              { label: '3 มื้อ',           text: 'เช้ากลางวันเย็น' },
            ]
          )],
        });
        return;
      }

      const med = await saveMedicationWithSchedule(patientId, name, dosage, schedule, 'chat');
      await client.replyMessage({
        replyToken,
        messages: [buildQuickReply(
          `จดไว้แล้วครับ 💊\n✅ ${formatMedConfirmation(med)}\n\nมียาตัวอื่นอีกไหมครับ?`,
          [
            { label: '💊 มียาอีก', text: 'มียาอีก' },
            { label: '✅ หมดแล้ว', text: 'หมดแล้ว' },
          ]
        )],
      });
      return;
    }

    // Parse failed
    await client.replyMessage({
      replyToken,
      messages: [buildQuickReply(
        'ขอโทษครับ ลุงอ่านไม่ออก ช่วยพิมพ์ใหม่ได้ไหมครับ? เช่น "Amlodipine 5mg"',
        [{ label: '✅ หมดแล้ว ไม่มียาอีก', text: 'หมดแล้ว' }]
      )],
    });
    return;
  }
}

// Handle photo of medicine label during onboarding
async function handleImageDuringOnboarding(event, patient) {
  try {
    const stream = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imageBase64 = Buffer.concat(chunks).toString('base64');

    // Ask Haiku to read the label and return structured JSON
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
          },
          {
            type: 'text',
            text: 'นี่คือฉลากยา กรุณาอ่านชื่อยาและขนาดยา ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น: {"name":"ชื่อยา","dosage":"ขนาดยา"}',
          },
        ],
      }],
    });

    const raw = response.content.find(b => b.type === 'text')?.text ?? '';
    let name = null;
    let dosage = null;

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        name = parsed.name;
        dosage = parsed.dosage;
      }
    } catch (e) {
      // JSON parse failed — try to use raw text as name
      name = raw.trim().split('\n')[0].substring(0, 100);
    }

    if (!name || name.length < 2) {
      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text',
          text: 'ขอโทษครับ ลุงอ่านฉลากไม่ออก ช่วยถ่ายใหม่ให้ชัดขึ้น หรือพิมพ์ชื่อยามาแทนได้ไหมครับ?' }],
      });
      return;
    }

    // Save with default morning schedule — user can update later
    const result = await pool.query(
      `INSERT INTO medications (patient_id, name, dosage, schedule, active, source)
       VALUES ($1, $2, $3, ARRAY['08:00'], TRUE, 'photo')
       RETURNING id, name, dosage, schedule`,
      [patient.id, name, dosage]
    );
    const med = result.rows[0];

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildQuickReply(
        `อ่านได้ครับ 💊\n✅ ${formatMedConfirmation(med)}\n(เวลากินตั้งเป็นเช้าไว้ก่อน แก้ไขได้ทีหลังนะครับ)\n\nมียาตัวอื่นอีกไหมครับ?`,
        [
          { label: '💊 มียาอีก', text: 'มียาอีก' },
          { label: '✅ หมดแล้ว', text: 'หมดแล้ว' },
        ]
      )],
    });

  } catch (err) {
    console.error('Image during onboarding error:', err.message);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text',
        text: 'ขอโทษครับ ลุงอ่านรูปไม่ออก ช่วยถ่ายใหม่หรือพิมพ์ชื่อยามาได้ไหมครับ?' }],
    });
  }
}

// Load patient's medications from DB for context injection
async function loadPatientContext(patientId) {
  const result = await pool.query(
    `SELECT name, dosage, schedule FROM medications
     WHERE patient_id = $1 AND active = TRUE
     ORDER BY created_at`,
    [patientId]
  );

  if (result.rows.length === 0) return '';

  const timeLabels = {
    '08:00': 'เช้า', '12:00': 'กลางวัน', '14:00': 'บ่าย',
    '18:00': 'เย็น', '21:00': 'ก่อนนอน', '22:00': 'กลางคืน',
  };

  const medList = result.rows.map(m => {
    const times = m.schedule.map(t => timeLabels[t] || t).join(', ');
    return `- ${m.name}${m.dosage ? ` ${m.dosage}` : ''} (${times})`;
  }).join('\n');

  return `\n\nยาที่ผู้ใช้ทานประจำ (จากฐานข้อมูล):\n${medList}`;
}

// Build dynamic system prompt with patient context injected
async function buildSystemPrompt(patientId) {
  const patientContext = await loadPatientContext(patientId);
  return SYSTEM_PROMPT + patientContext;
}
  const result = await pool.query(
    `SELECT role, content FROM conversation_history
     WHERE patient_id = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [patientId]
  );
  return result.rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

async function saveMessage(patientId, role, content, contentType = 'text') {
  await pool.query(
    `INSERT INTO conversation_history (patient_id, role, content_type, content)
     VALUES ($1, $2, $3, $4)`,
    [patientId, role, contentType, content]
  );
  await pool.query(
    `DELETE FROM conversation_history
     WHERE patient_id = $1
     AND id NOT IN (
       SELECT id FROM conversation_history
       WHERE patient_id = $1
       ORDER BY created_at DESC
       LIMIT 20
     )`,
    [patientId]
  );
}

async function incrementQuota(patientId, type) {
  try {
    await pool.query(`SELECT increment_quota($1, $2)`, [patientId, type]);
  } catch (err) {
    console.error('Quota increment failed:', err.message);
  }
}

// ============================================================
// SCHEDULER
// ============================================================

async function getMedicationsDue() {
  const now = new Date();
  const bangkokTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const hours = String(bangkokTime.getUTCHours()).padStart(2, '0');
  const minutes = String(bangkokTime.getUTCMinutes()).padStart(2, '0');
  const currentTime = `${hours}:${minutes}`;

  const result = await pool.query(
    `SELECT m.id as medication_id, m.name, m.dosage, m.schedule,
            p.id as patient_id, p.line_user_id, p.display_name
     FROM medications m
     JOIN patients p ON p.id = m.patient_id
     WHERE m.active = TRUE
     AND p.line_user_id IS NOT NULL
     AND $1 = ANY(m.schedule)`,
    [currentTime]
  );
  return result.rows;
}

async function logMedicationReminder(medicationId, patientId, scheduledAt) {
  const result = await pool.query(
    `INSERT INTO medication_logs (medication_id, patient_id, status, scheduled_at)
     VALUES ($1, $2, 'missed', $3) RETURNING id`,
    [medicationId, patientId, scheduledAt]
  );
  return result.rows[0].id;
}

function isTakenConfirmation(text) {
  const taken = [
    'กินแล้ว', 'ทานแล้ว', 'กินยาแล้ว', 'ทานยาแล้ว',
    'โอเค', 'ok', 'ตกลง', 'รับทราบ', '✅', '👍',
    'เรียบร้อย', 'done', 'เสร็จแล้ว',
  ];
  return taken.some(word => text.toLowerCase().includes(word));
}

cron.schedule('* * * * *', async () => {
  try {
    const meds = await getMedicationsDue();
    if (meds.length === 0) return;

    console.log(`⏰ Scheduler: ${meds.length} medication(s) due now`);

    for (const med of meds) {
      try {
        const patientName = med.display_name ? ` คุณ${med.display_name}` : '';
        const message =
          `💊 ถึงเวลากินยาแล้ว${patientName}ครับ\n` +
          `ยา: ${med.name}${med.dosage ? ` ${med.dosage}` : ''}\n` +
          `กินเสร็จแล้วตอบ "กินแล้ว" ให้ลุงทราบด้วยนะครับ 🙏`;

        await client.pushMessage({
          to: med.line_user_id,
          messages: [{ type: 'text', text: message }],
        });

        await logMedicationReminder(med.medication_id, med.patient_id, new Date());
        console.log(`✅ Reminder sent: ${med.name} → ${med.line_user_id}`);
      } catch (err) {
        console.error(`❌ Failed to send reminder for ${med.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Scheduler error:', err.message);
  }
});

console.log('⏰ Medication reminder scheduler started (checks every minute)');

// ============================================================
// WEBHOOK
// ============================================================

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  for (const event of req.body.events) {
    try {
      await handleEvent(event);
    } catch (error) {
      console.error('Error handling event:', error);
    }
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const lineUserId = event.source.userId;
  const patient = await getOrCreatePatient(lineUserId);
  const patientId = patient.id;

  // Route to onboarding if not complete
  if (needsOnboarding(patient)) {
    // Allow image during asking_more_meds state (photo of label)
    if (event.message.type === 'image' && patient.onboarding_state === 'asking_more_meds') {
      await handleImageDuringOnboarding(event, patient);
      return;
    }
    if (event.message.type === 'text') {
      await handleOnboarding(event, patient);
      return;
    }
  }

  if (event.message.type === 'text') {
    await handleTextMessage(event, patientId);
  } else if (event.message.type === 'image') {
    await handleImageMessage(event, patientId);
  } else {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'ลุงรับเป็นข้อความหรือรูปภาพได้นะครับ ลองพิมพ์มา หรือถ่ายรูปค่าความดัน/น้ำตาล/ฉลากยา มาให้ลุงดูได้เลยครับ',
      }],
    });
  }
}

// ============================================================
// TEXT MESSAGES
// ============================================================

async function handleTextMessage(event, patientId) {
  const userMessage = event.message.text;

  // --- Check if user is asking for their medication list ---
  const medListTriggers = [
    'รายการยา', 'ยาอะไรบ้าง', 'จดยาอะไร', 'มียาอะไร',
    'ยาทั้งหมด', 'ยาที่มี', 'ดูยา', 'list ยา', 'ยาของฉัน',
  ];
  if (medListTriggers.some(t => userMessage.includes(t))) {
    const card = await buildMedCard(patientId, '💊 รายการยาของคุณ');
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [card],
    });
    await incrementQuota(patientId, 'message');
    return; // skip Claude call entirely — no AI needed
  }

  // --- Check for medication confirmation ---
  if (isTakenConfirmation(userMessage)) {
    await pool.query(
      `UPDATE medication_logs
       SET status = 'taken', responded_at = NOW()
       WHERE patient_id = $1
       AND status = 'missed'
       AND scheduled_at > NOW() - INTERVAL '2 hours'`,
      [patientId]
    );
  }

  // --- Check for health reading in the message ---
  const reading = parseHealthReading(userMessage);

  // --- Load history and call Claude ---
  const history = await loadHistory(patientId);
  history.push({ role: 'user', content: userMessage });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: await buildSystemPrompt(patientId),
    messages: history,
  });

  const reply =
    response.content.find(b => b.type === 'text')?.text ??
    'ขอโทษครับ ลุงไม่เข้าใจ ลองพิมพ์ใหม่อีกครั้งนะครับ';

  // --- Save health log if a reading was detected ---
  let weightChangeMsg = null;
  if (reading) {
    const result = await saveHealthLog(patientId, reading, 'chat');
    weightChangeMsg = result.weightChangeMsg;
  }

  // --- Save conversation ---
  await saveMessage(patientId, 'user', userMessage, 'text');

  // Append weight change info to reply if present
  const finalReply = weightChangeMsg
    ? `${reply}\n\n📊 ${weightChangeMsg}`
    : reply;

  await saveMessage(patientId, 'assistant', finalReply, 'text');
  await incrementQuota(patientId, 'message');

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: finalReply }],
  });
}

// ============================================================
// IMAGE / PHOTO MESSAGES
// ============================================================

async function handleImageMessage(event, patientId) {
  try {
    const stream = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const imageBase64 = Buffer.concat(chunks).toString('base64');

    const history = await loadHistory(patientId);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: await buildSystemPrompt(patientId),
      messages: [
        ...history,
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 },
            },
            {
              type: 'text',
              text: 'ผู้สูงอายุส่งรูปนี้มา อาจเป็นเครื่องวัดความดัน เครื่องวัดน้ำตาล เครื่องวัดออกซิเจน หรือฉลากยา ช่วยอ่านค่าอย่างระมัดระวัง แล้วทวนสิ่งที่อ่านได้ให้ผู้ใช้ยืนยันก่อนเสมอครับ — ตอบในรูปแบบ JSON ด้วยนะครับ: {"type":"bp|glucose|spo2|temp|weight","value_1":0,"value_2":null,"unit":"mmHg|mmol|pct|C|kg","reply":"ข้อความตอบกลับ"}',
            },
          ],
        },
      ],
    });

    const rawReply = response.content.find(b => b.type === 'text')?.text ?? '';

    // Try to extract structured reading from Claude's JSON response
    let photoReading = null;
    let replyText = rawReply;

    try {
      const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        replyText = parsed.reply || rawReply;
        if (parsed.type && parsed.value_1) {
          photoReading = {
            type: parsed.type,
            value_1: parseFloat(parsed.value_1),
            value_2: parsed.value_2 ? parseFloat(parsed.value_2) : null,
            unit: parsed.unit,
            // Classify alert level based on type
            alert_level: parsed.type === 'bp'
              ? classifyBP(parsed.value_1, parsed.value_2 || 0)
              : parsed.type === 'spo2'
              ? classifySpO2(parsed.value_1)
              : parsed.type === 'temp'
              ? classifyTemp(parsed.value_1)
              : parsed.type === 'glucose'
              ? classifyGlucose(parsed.value_1 <= 30 ? parsed.value_1 * 18 : parsed.value_1)
              : 'normal',
          };
        }
      }
    } catch (e) {
      // JSON parsing failed — Claude replied in plain text, that's fine
      replyText = rawReply;
    }

    // Save photo reading to health_logs if extracted
    // Note: confirmed = TRUE because Claude read it back and user will see the confirmation
    if (photoReading) {
      await saveHealthLog(patientId, photoReading, 'photo');
    }

    await saveMessage(patientId, 'user', '[ผู้ใช้ส่งรูปภาพมาให้ลุงอ่าน]', 'image_summary');
    await saveMessage(patientId, 'assistant', replyText, 'text');
    await incrementQuota(patientId, 'photo');

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: replyText }],
    });

  } catch (error) {
    console.error('Image handling error:', error);
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'ขอโทษครับ ลุงอ่านรูปไม่ค่อยออก ช่วยถ่ายใหม่ให้ชัด ๆ อีกครั้งได้ไหมครับ',
      }],
    });
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(3000, () => console.log('✅ ลุงโน้ต is awake and running on port 3000!'));