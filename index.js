import 'dotenv/config';
import express from 'express';
import * as line from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';

// --- Configuration ---
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// Client for SENDING replies back to the user (text messages, etc.)
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// NEW: Client for DOWNLOADING the files (photos) that users send us.
// This comes built into @line/bot-sdk v11 — no extra install needed.
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const app = express();

// --- Bot's personality ---
const SYSTEM_PROMPT = `
คุณคือ "ลุงโน้ต" ผู้ช่วยดูแลสุขภาพบน LINE สำหรับผู้สูงอายุไทย

กฎ:
- พูดอบอุ่น กระชับ ไม่เกิน 3 บรรทัดต่อการตอบ
- ลงท้ายด้วย "ครับ" เสมอ
- เมื่อเตือนยา ให้บอกชื่อยาและขนาดยาด้วย
- หากค่าความดันหรือน้ำตาลผิดปกติ แนะนำให้พบแพทย์ด้วยความห่วงใย
- รับข้อมูลทั้งภาษาไทยและตัวเลข เช่น "130/85" หรือ "กินยาแล้ว"
- เมื่อผู้ใช้ส่งรูปมา (เช่น เครื่องวัดความดัน เครื่องวัดน้ำตาล หรือฉลากยา)
  ให้อ่านค่าหรือข้อความในรูปอย่างระมัดระวัง แล้ว "ทวนค่าที่อ่านได้ให้ผู้ใช้ยืนยันก่อนเสมอ"
  เช่น "ลุงอ่านได้ความดัน 130/85 ถูกไหมครับ"
- ถ้ารูปไม่ชัดหรืออ่านไม่ออก ให้ขอให้ถ่ายใหม่อย่างสุภาพ อย่าเดาค่าเอง
`;

// --- Simple in-memory conversation history (per user) ---
const conversationHistory = new Map();

// --- Webhook handler ---
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
  // We only care about messages for now
  if (event.type !== 'message') return;

  const userId = event.source.userId;

  // Make sure this user has a history list
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  const history = conversationHistory.get(userId);

  // Route the message depending on whether it's text or a photo
  if (event.message.type === 'text') {
    await handleTextMessage(event, history);
  } else if (event.message.type === 'image') {
    await handleImageMessage(event, history);
  } else {
    // Stickers, voice messages, etc. — gently steer the user back
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'ลุงรับเป็นข้อความหรือรูปภาพได้นะครับ ลองพิมพ์มา หรือถ่ายรูปค่าความดัน/น้ำตาล/ฉลากยา มาให้ลุงดูได้เลยครับ',
      }],
    });
  }
}

// --- TEXT messages (this is your original logic, unchanged) ---
async function handleTextMessage(event, history) {
  const userMessage = event.message.text;

  history.push({ role: 'user', content: userMessage });
  if (history.length > 10) history.splice(0, 2);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const reply =
    response.content.find((block) => block.type === 'text')?.text ??
    'ขอโทษครับ ลุงไม่เข้าใจ ลองพิมพ์ใหม่อีกครั้งนะครับ';

  history.push({ role: 'assistant', content: reply });

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: reply }],
  });
}

// --- IMAGE messages (NEW) ---
async function handleImageMessage(event, history) {
  try {
    // 1. Download the photo from LINE. It arrives as a "stream" (data in pieces),
    //    so we collect the pieces into one buffer, then turn it into base64 text.
    const stream = await blobClient.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const imageBuffer = Buffer.concat(chunks);
    const imageBase64 = imageBuffer.toString('base64');

    // 2. Send the photo to Claude and ask "ลุงโน้ต" to read it.
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [
        ...history,
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg', // LINE photos are JPEG
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text:
                'ผู้สูงอายุส่งรูปนี้มา อาจเป็นเครื่องวัดความดัน เครื่องวัดน้ำตาล หรือฉลากยา ' +
                'ช่วยอ่านค่า/ข้อความในรูปอย่างระมัดระวัง แล้วทวนสิ่งที่อ่านได้ให้ผู้ใช้ยืนยันก่อนเสมอครับ',
            },
          ],
        },
      ],
    });

    const reply =
      response.content.find((block) => block.type === 'text')?.text ??
      'ขอโทษครับ ลุงอ่านรูปไม่ค่อยออก ช่วยถ่ายใหม่ให้ชัด ๆ อีกครั้งได้ไหมครับ';

    // 3. Save a LIGHT text note in history (we do NOT keep the photo itself,
    //    to save memory and keep API costs low).
    history.push({ role: 'user', content: '[ผู้ใช้ส่งรูปภาพมาให้ลุงอ่าน]' });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 10) history.splice(0, 2);

    // 4. Reply back on LINE.
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

app.listen(3000, () => console.log('✅ ลุงโน้ต is awake and running on port 3000!'));