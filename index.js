import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import cron from 'node-cron';

const { Pool } = pg;

// --- Database connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

pool.query('SELECT NOW()')
  .then(() => console.log('✅ Database connected'))
  .catch(err => console.error('❌ Database connection failed:', err.message));

// --- LINE configuration ---
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
- หากค่าความดันหรือน้ำตาลผิดปกติ แนะนำให้พบแพทย์ด้วยความห่วงใย
- รับข้อมูลทั้งภาษาไทยและตัวเลข เช่น "130/85" หรือ "กินยาแล้ว"
- เมื่อผู้ใช้ส่งรูปมา ให้อ่านค่าอย่างระมัดระวัง แล้วทวนให้ผู้ใช้ยืนยันก่อนเสมอ
- ถ้ารูปไม่ชัดหรืออ่านไม่ออก ให้ขอถ่ายใหม่ อย่าเดาค่าเอง
`;

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
  // Keep only last 20 rows per patient
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
// SCHEDULER HELPERS
// ============================================================

// Find all medications due at the current HH:MM (Bangkok time)
async function getMedicationsDue() {
  // Get current time in Bangkok (UTC+7)
  const now = new Date();
  const bangkokTime = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const hours = String(bangkokTime.getUTCHours()).padStart(2, '0');
  const minutes = String(bangkokTime.getUTCMinutes()).padStart(2, '0');
  const currentTime = `${hours}:${minutes}`;

  // Find active medications whose schedule array contains the current time
  // Also join patients to get the LINE user ID for pushing
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

// Log a medication reminder as "pending" — updated later when user responds
async function logMedicationReminder(medicationId, patientId, scheduledAt) {
  const result = await pool.query(
    `INSERT INTO medication_logs (medication_id, patient_id, status, scheduled_at)
     VALUES ($1, $2, 'missed', $3)
     RETURNING id`,
    [medicationId, patientId, scheduledAt]
  );
  return result.rows[0].id;
}

// Update a medication log to "taken" when user confirms
async function markMedicationTaken(patientId, medicationName) {
  // Find the most recent 'missed' log for this patient's medication
  await pool.query(
    `UPDATE medication_logs
     SET status = 'taken', responded_at = NOW()
     WHERE patient_id = $1
     AND status = 'missed'
     AND medication_id IN (
       SELECT id FROM medications
       WHERE patient_id = $1
       AND LOWER(name) LIKE LOWER($2)
     )
     AND scheduled_at > NOW() - INTERVAL '2 hours'`,
    [patientId, `%${medicationName}%`]
  );
}

// Detect if a user message means "I took my medication"
function isTakenConfirmation(text) {
  const taken = [
    'กินแล้ว', 'ทานแล้ว', 'กินยาแล้ว', 'ทานยาแล้ว',
    'โอเค', 'ok', 'ตกลง', 'รับทราบ', '✅', '👍',
    'เรียบร้อย', 'done', 'เสร็จแล้ว',
  ];
  return taken.some(word => text.toLowerCase().includes(word));
}

// ============================================================
// THE SCHEDULER — runs every minute
// ============================================================

cron.schedule('* * * * *', async () => {
  try {
    const meds = await getMedicationsDue();
    if (meds.length === 0) return;

    console.log(`⏰ Scheduler: ${meds.length} medication(s) due now`);

    for (const med of meds) {
      try {
        const patientName = med.display_name ? `คุณ${med.display_name}` : 'ครับ';
        const message =
          `💊 ถึงเวลากินยาแล้ว${patientName !== 'ครับ' ? ' ' + patientName : ''}ครับ\n` +
          `ยา: ${med.name}${med.dosage ? ` ${med.dosage}` : ''}\n` +
          `กินเสร็จแล้วตอบ "กินแล้ว" ให้ลุงทราบด้วยนะครับ 🙏`;

        // Push the reminder (this is a paid LINE push message)
        await client.pushMessage({
          to: med.line_user_id,
          messages: [{ type: 'text', text: message }],
        });

        // Log it as "missed" initially — updated to "taken" if user confirms
        await logMedicationReminder(
          med.medication_id,
          med.patient_id,
          new Date()
        );

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

  // Check if user is confirming they took their medication
  if (isTakenConfirmation(userMessage)) {
    // Mark the most recent pending medication as taken
    await pool.query(
      `UPDATE medication_logs
       SET status = 'taken', responded_at = NOW()
       WHERE patient_id = $1
       AND status = 'missed'
       AND scheduled_at > NOW() - INTERVAL '2 hours'`,
      [patientId]
    );
  }

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

  await saveMessage(patientId, 'user', userMessage, 'text');
  await saveMessage(patientId, 'assistant', reply, 'text');
  await incrementQuota(patientId, 'message');

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: reply }],
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
              text: 'ผู้สูงอายุส่งรูปนี้มา อาจเป็นเครื่องวัดความดัน เครื่องวัดน้ำตาล เครื่องวัดออกซิเจน หรือฉลากยา ช่วยอ่านค่าอย่างระมัดระวัง แล้วทวนสิ่งที่อ่านได้ให้ผู้ใช้ยืนยันก่อนเสมอครับ',
            },
          ],
        },
      ],
    });

    const reply =
      response.content.find(b => b.type === 'text')?.text ??
      'ขอโทษครับ ลุงอ่านรูปไม่ค่อยออก ช่วยถ่ายใหม่ให้ชัด ๆ อีกครั้งได้ไหมครับ';

    await saveMessage(patientId, 'user', '[ผู้ใช้ส่งรูปภาพมาให้ลุงอ่าน]', 'image_summary');
    await saveMessage(patientId, 'assistant', reply, 'text');
    await incrementQuota(patientId, 'photo');

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: reply }],
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