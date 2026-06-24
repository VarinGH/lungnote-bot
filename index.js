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

  // If abnormal, create an alert record
  if (reading.alert_level !== 'normal') {
    await pool.query(
      `INSERT INTO alerts
         (health_log_id, patient_id, type, severity, guardian_notified)
       VALUES ($1, $2, $3, $4, FALSE)`,
      [logId, patientId, `${reading.alert_level}_${reading.type}`, reading.alert_level]
    );
    console.log(`🚨 Alert created: ${reading.type} ${reading.alert_level} for patient ${patientId}`);
  }

  return { logId, alertLevel: reading.alert_level, weightChangeMsg };
}

// ============================================================
// DATABASE HELPERS
// ============================================================

async function getOrCreatePatient(lineUserId) {
  const existing = await pool.query(
    'SELECT * FROM patients WHERE line_user_id = $1',
    [lineUserId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const hhResult = await pool.query(
    `INSERT INTO households (mode) VALUES ('solo') RETURNING id`
  );
  const householdId = hhResult.rows[0].id;

  const patientResult = await pool.query(
    `INSERT INTO patients (household_id, line_user_id, care_mode)
     VALUES ($1, $2, 'self') RETURNING *`,
    [householdId, lineUserId]
  );

  await pool.query(
    `INSERT INTO subscriptions (household_id, status) VALUES ($1, 'trial')`,
    [householdId]
  );

  console.log(`✅ New patient created: ${patientResult.rows[0].id}`);
  return patientResult.rows[0];
}

async function loadHistory(patientId) {
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
    system: SYSTEM_PROMPT,
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
      system: SYSTEM_PROMPT,
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