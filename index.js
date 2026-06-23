import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';

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

// --- Anthropic configuration ---
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
    `INSERT INTO subscriptions (household_id, status)
     VALUES ($1, 'trial')`,
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
  return result.rows.reverse().map(row => ({
    role: row.role,
    content: row.content,
  }));
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
        text: 'ขอโทษครับ ลุงอ่านรูปไม่ค่อยออก ช่วยถ่ายใหม่ให้ชัด ๆ อีกครั้งได้เลยครับ',
      }],
    });
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(3000, () => console.log('✅ ลุงโน้ต is awake and running on port 3000!'));