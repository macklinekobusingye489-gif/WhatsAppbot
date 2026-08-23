const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;
let currentQR = '';

// Webpage auto-refreshes every 15 seconds so the QR code is never stale
app.get('/', async (req, res) => {
  if (!currentQR) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:white;font-family:sans-serif;">
          <h2>Bot connected or generating new QR code... checking in 5s</h2>
        </body>
      </html>
    `);
  }
  try {
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="refresh" content="15">
          <title>Scan WhatsApp QR</title>
        </head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background-color:#111;color:#fff;">
          <h2>Scan with WhatsApp Business</h2>
          <img src="${qrImage}" style="width:280px;height:280px;border:10px solid white;border-radius:12px;" />
          <p style="margin-top:15px;color:#00ff88;">Auto-refreshing live code...</p>
        </body>
      </html>
    `);
  } catch (err) { res.status(500).send('Error rendering QR image'); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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
  // Using fresh session storage
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_v3');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop')
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) currentQR = qr;

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      currentQR = '';
      console.log('WhatsApp Bot connected successfully!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatJid = msg.key.remoteJid;
    const isGroup = chatJid.endsWith('@g.us');

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
          documentContexts[chatJid] = extractedText.slice(0, 15000);
          await sock.sendMessage(chatJid, { text: '📚 Document analyzed! Ask me any questions about it.' });
          return;
        }
      } catch (err) {
        await sock.sendMessage(chatJid, { text: 'Failed to read document.' });
        return;
      }
    }

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
    if (!text.trim()) return;

    let systemInstruction = '';
    const docContext = documentContexts[chatJid] ? `\n\nStudy Notes:\n${documentContexts[chatJid]}` : '';

    if (isGroup) {
      systemInstruction = `You are a helpful, smart student in a study group. Explain concepts clearly, break down lessons step-by-step, encourage discussion, and keep tone educational yet informal.${docContext}`;
    } else {
      systemInstruction = `You are a friendly, natural chat companion speaking 1-on-1. Respond like a real peer. Keep answers warm, concise, and conversational.${docContext}`;
    }

    try {
      const reply = await queryGemini(text, systemInstruction);
      await sock.sendMessage(chatJid, { text: reply });
    } catch (err) {
      console.error(err);
    }
  });
}

startBot();
