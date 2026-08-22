const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;
let currentQR = '';

app.get('/', async (req, res) => {
  if (!currentQR) return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">Bot is connected!</h2>');
  try {
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`<body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;"><img src="${qrImage}" style="width:280px;height:280px;border:10px solid white;border-radius:12px;"/></body>`);
  } catch (err) { res.status(500).send('Error'); }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// Store extracted document text per chat JID
const documentContexts = {};

async function queryGemini(prompt, systemInstruction) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: prompt }
      ]
    })
  });
  const data = await response.json();
  return data.choices[0]?.message?.content || 'Sorry, I could not process that.';
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: Browsers.macOS('Desktop') });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) currentQR = qr;
    if (connection === 'close') {
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
    } else if (connection === 'open') {
      currentQR = '';
      console.log('Bot Connected!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatJid = msg.key.remoteJid;
    const isGroup = chatJid.endsWith('@g.us');

    // 1. Handle Document Uploads (.pdf or .txt)
    const docMessage = msg.message.documentMessage || msg.message.documentWithCaptionMessage?.message?.documentMessage;
    if (docMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        let extractedText = '';

        if (docMessage.mimetype === 'application/pdf') {
          const parsed = await pdfParse(buffer);
          extractedText = parsed.text;
        } else if (docMessage.mimetype.includes('text')) {
          extractedText = buffer.toString('utf-8');
        }

        if (extractedText) {
          documentContexts[chatJid] = extractedText.slice(0, 15000); // Store up to ~15k chars
          await sock.sendMessage(chatJid, { text: '📚 Document analyzed! Ask me any questions about it.' });
          return;
        }
      } catch (err) {
        await sock.sendMessage(chatJid, { text: 'Failed to read document.' });
        return;
      }
    }

    // 2. Extract Message Text
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
    if (!text.trim()) return;

    // 3. Define System Instructions based on Chat Type & Context
    let systemInstruction = '';
    const docContext = documentContexts[chatJid] ? `\n\nStudy Notes:\n${documentContexts[chatJid]}` : '';

    if (isGroup) {
      systemInstruction = `You are a helpful, smart student in a study group. Explain concepts clearly, break down lessons step-by-step, encourage discussion, and keep tone educational yet informal.${docContext}`;
    } else {
      systemInstruction = `You are a friendly, natural chat companion speaking 1-on-1. Respond like a real peer. Keep answers warm, concise, and conversational.${docContext}`;
    }

    // 4. Send Query to Gemini and Reply
    try {
      const reply = await queryGemini(text, systemInstruction);
      await sock.sendMessage(chatJid, { text: reply });
    } catch (err) {
      console.error(err);
    }
  });
}

startBot();
