const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = '';

// Webpage to display the QR image directly
app.get('/', async (req, res) => {
  if (!currentQR) {
    return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">Waiting for QR Code... Please refresh in 5 seconds.</h2>');
  }
  try {
    const qrImage = await QRCode.toDataURL(currentQR);
    res.send(`
      <!進入html>
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WhatsApp Bot Pairing</title>
        </head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:sans-serif;background-color:#111;color:#fff;">
          <h2>Scan with WhatsApp Business</h2>
          <img src="${qrImage}" style="width:280px;height:280px;border:10px solid white;border-radius:12px;" />
          <p style="margin-top:20px;color:#aaa;">Refresh page if code expires</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR image.');
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop')
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      currentQR = qr;
    }

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

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (text.toLowerCase().startsWith('!ai ')) {
      const prompt = text.slice(4);
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const data = await response.json();
        const reply = data.choices[0]?.message?.content || 'No response from AI.';

        await sock.sendMessage(msg.key.remoteJid, { text: reply });
      } catch (err) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Error reaching Gemini.' });
      }
    }
  });
}

startBot();
