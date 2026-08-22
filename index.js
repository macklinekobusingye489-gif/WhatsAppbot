const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  // Request 8-digit phone pairing code if not connected yet
  if (!sock.authState.creds.registered) {
    const phoneNumber = '256746685245'; 
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('\n====================================');
        console.log(`YOUR WHATSAPP PAIRING CODE: ${code}`);
        console.log('====================================\n');
      } catch (err) {
        console.log('Error requesting pairing code:', err);
      }
    }, 5000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
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
