const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;
let currentQR = '';

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

const conversationHistory = {};
const documentContexts = {};

function getStringSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  let matches = 0;
  const minLen = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLen; i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return matches / Math.max(s1.length, s2.length);
}

async function queryGemini(messages, systemInstruction) {
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
        ...messages
      ]
    })
  });
  const data = await response.json();
  return data.choices[0]?.message?.content || 'Yeah, got it.';
}

async function startBot() {
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
    const senderName = msg.pushName || 'Friend';

    // 1. Handle PDF/Text Document Uploads
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
          await new Promise(resolve => setTimeout(resolve, 5000));
          await sock.sendMessage(chatJid, { text: 'Got the notes. Let me know what you need from them.' });
          return;
        }
      } catch (err) {
        console.error('Error parsing document:', err);
        return;
      }
    }

    // 2. Extract Message Text
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
    if (!text.trim()) return;

    // 3. Group Tag Check (Spectate unless directly tagged/mentioned)
    if (isGroup) {
      const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : '';
      const contextInfo = msg.message.extendedTextMessage?.contextInfo;
      const mentionedJids = contextInfo?.mentionedJid || [];
      const isTagged = mentionedJids.some(jid => jid.includes(botNumber));
      const isRepliedTo = contextInfo?.participant?.includes(botNumber);

      if (!isTagged && !isRepliedTo) {
        return;
      }
    }

    // 4. Update Conversation Memory
    if (!conversationHistory[chatJid]) {
      conversationHistory[chatJid] = [];
    }

    conversationHistory[chatJid].push({ role: 'user', content: `${senderName}: ${text}` });

    const maxMemory = isGroup ? 10 : 30;
    if (conversationHistory[chatJid].length > maxMemory) {
      conversationHistory[chatJid] = conversationHistory[chatJid].slice(-maxMemory);
    }

    // 5. Target Detection for Mackline / M.A.C.K / Macky
    const isGirlfriend = getStringSimilarity(senderName, '..M..A..C..K..') >= 0.4 || 
                         senderName.toLowerCase().includes('mack') || 
                         senderName.toLowerCase().includes('macky');

    const docContext = documentContexts[chatJid] ? `\n\nStudy Notes:\n${documentContexts[chatJid]}` : '';

    let systemInstruction = '';

    if (isGroup) {
      systemInstruction = `You are Jonah, a smart, relaxed guy in a study group. When people tag you, give clear, helpful student-style answers or explain lesson topics smoothly without sounding like a robotic tutor. Never greet repeatedly.${docContext}`;
    } else if (isGirlfriend) {
      systemInstruction = `You are Jonah texting Mackline (call her "Macky"). 
Tone: Extra casual, cool, unbothered, and relaxed. 
Guidelines: Be friendly and smooth, but keep your responses concise and slightly laid-back. Never act needy, overly dramatic, eager, or jealous. Do not bring up relationship heavy topics or other people. Act completely secure, low-key, and natural like a real guy texting. Never sound like an AI assistant.${docContext}`;
    } else {
      systemInstruction = `You are Jonah texting 1-on-1. Respond as yourself: cool, relaxed, concise, and natural. Match the flow of the conversation based on past messages. Never use generic customer service greetings like "How can I help you?".${docContext}`;
    }

    // 6. Natural 5-Second Delay & Reply Execution
    setTimeout(async () => {
      try {
        const reply = await queryGemini(conversationHistory[chatJid], systemInstruction);

        conversationHistory[chatJid].push({ role: 'assistant', content: reply });

        await sock.sendMessage(chatJid, { text: reply });
      } catch (err) {
        console.error('Error generating reply:', err);
      }
    }, 5000);
  });
}

startBot();
