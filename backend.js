const { makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('baileys');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const qrcode = require('qrcode-terminal');
const session = require('express-session');
const fs = require('fs'); // Tambahkan fs untuk file operations
const path = require('path'); // Tambahkan path
const config = require('./config'); // Impor konfigurasi

// Gunakan konfigurasi dari config.js
const admins = config.admins;
const adminSockets = {}; // Untuk melacak socket ID -> username
const pickedChats = {}; // Untuk melacak chat mana yang diambil oleh admin mana { chatId: username }
const chatHistoryFile = path.join(__dirname, 'chat_history.json'); // Path ke file history
let chatHistory = {}; // Variabel untuk menyimpan history di memori

// Fungsi untuk memuat history dari file
function loadChatHistory() {
  try {
    if (fs.existsSync(chatHistoryFile)) {
      const data = fs.readFileSync(chatHistoryFile, 'utf-8');
      chatHistory = JSON.parse(data);
      console.log('Riwayat chat berhasil dimuat.');
    } else {
      console.log('File riwayat chat tidak ditemukan, memulai dengan history kosong.');
    }
  } catch (error) {
    console.error('Gagal memuat riwayat chat:', error);
    chatHistory = {}; // Reset jika ada error
  }
}

// Fungsi untuk menyimpan history ke file
function saveChatHistory() {
  try {
    fs.writeFileSync(chatHistoryFile, JSON.stringify(chatHistory, null, 2), 'utf-8');
    // console.log('Riwayat chat berhasil disimpan.'); // Optional: log setiap penyimpanan
  } catch (error) {
    console.error('Gagal menyimpan riwayat chat:', error);
  }
}

// Muat history saat aplikasi dimulai
loadChatHistory();

// Serve static files
app.use(express.static(__dirname));

// Route untuk halaman utama
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Konfigurasi session
app.use(session({
  secret: config.sessionSecret, // Gunakan secret dari config
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set secure: true jika menggunakan HTTPS
}));

// Inisialisasi server
const PORT = config.serverPort || 3000; // Gunakan port dari config atau default 3000
http.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});

// Koneksi WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  // const pino = require('pino'); // Dikomentari untuk debugging
// const logger = pino(); // Dikomentari untuk debugging

const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    // logger: logger // Menghapus konfigurasi logger untuk sementara
  });

  // Generate QR code
  sock.ev.on('connection.update', (update) => {
    const { qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: true });
    }
  });

  // Event listener untuk koneksi WhatsApp
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if(connection === 'close') {
      // Periksa keberadaan error dan output sebelum mengakses statusCode
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== 401;
      console.log(`Koneksi terputus karena: ${lastDisconnect?.error}, mencoba menyambung kembali: ${shouldReconnect}`);
      if(shouldReconnect) {
        connectToWhatsApp();
      }
    } else if(connection === 'open') {
      console.log('Berhasil terhubung ke WhatsApp');
    }
  });

  // Event listener untuk pesan masuk
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      if (!message.key.fromMe) {
        console.log('Pesan masuk dari:', message.key.remoteJid);
        
        let messageContent = message.message?.conversation || message.message?.extendedTextMessage?.text || ''; // Default ke string kosong
        let mediaData = null;
        let mediaType = null;
        let caption = ''; // Variabel untuk caption

        // Cek apakah pesan adalah media
        const messageType = Object.keys(message.message || {})[0]; // Dapatkan tipe pesan (imageMessage, videoMessage, etc.)
        if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType)) {
          try {
            const buffer = await downloadMediaMessage(message, 'buffer', {});
            mediaData = buffer.toString('base64');
            mediaType = messageType; // Simpan tipe media
            // Coba ekstrak caption dari berbagai tipe media
            caption = message.message[mediaType]?.caption || '';
            messageContent = caption; // Gunakan caption sebagai messageContent jika ada media
            console.log(`Media ${mediaType} (caption: '${caption}') dari ${message.key.remoteJid} berhasil diunduh.`);
          } catch (error) {
            console.error('Gagal mengunduh media:', error);
            messageContent = 'Gagal memuat media'; // Pesan error jika unduhan gagal
          }
        } else if (!messageContent) {
            // Handle other message types if necessary, or set default text
            messageContent = 'Pesan tidak didukung';
        }

        // Buat objek data pesan
        const messageData = {
          from: message.key.remoteJid,
          text: messageContent, // Ini akan berisi caption jika ada media, atau teks biasa
          mediaData: mediaData, // Kirim data media base64
          mediaType: mediaType, // Kirim tipe media
          timestamp: new Date().toISOString(),
          unread: true,
          type: 'incoming' // Tambahkan tipe pesan
        };

        // Simpan pesan ke history
        const chatId = message.key.remoteJid;
        if (!chatHistory[chatId]) {
          chatHistory[chatId] = [];
        }
        chatHistory[chatId].push(messageData); // Gunakan messageData yang sudah didefinisikan
        saveChatHistory(); // Simpan perubahan ke file

        // Kirim pesan ke semua admin melalui Socket.IO
        io.emit('new_message', messageData); // Gunakan messageData yang sudah didefinisikan
        
        // Tambahkan notifikasi browser
        io.emit('notification', {
          title: 'Pesan Baru',
          body: `Pesan dari ${message.key.remoteJid}`,
          icon: '/whatsapp-icon.png'
        });
      }
    }
  });

  // Simpan kredensial saat diperbarui
  sock.ev.on('creds.update', saveCreds);

  // Socket.IO untuk menerima balasan dari admin
  io.on('connection', (socket) => {
    console.log('Admin terhubung:', socket.id);

    // Kirim status pick awal saat admin terhubung
    socket.emit('initial_pick_status', pickedChats);

    // Event untuk mengirim data awal (semua history chat)
    socket.on('request_initial_data', () => {
      const username = adminSockets[socket.id];
      if (username) {
        console.log(`Admin ${username} meminta data awal.`);
        // Kirim seluruh history chat yang tersimpan
        // Format: { chatId1: [msg1, msg2], chatId2: [msg3] }
        socket.emit('initial_data', chatHistory);
      } else {
        console.log(`Socket ${socket.id} meminta data awal tetapi tidak terautentikasi.`);
        // Mungkin kirim error atau abaikan
      }
    });

    // Event untuk meminta history chat TERTENTU (jika diperlukan, misal saat klik chat)
    // Sebaiknya gunakan initial_data untuk pemuatan awal
    socket.on('get_chat_history', (chatId) => {
      console.log(`Admin ${adminSockets[socket.id] || socket.id} meminta history untuk ${chatId}`);
      const history = chatHistory[chatId] || [];
      socket.emit('chat_history', { chatId, messages: history });
    });
    // Verifikasi login admin
    socket.on('admin_login', ({ username, password }) => {
      console.log(`Received admin_login event from socket ${socket.id} for username: ${username}`); // Logging
      // Gunakan data dari config.js untuk verifikasi
      const adminUser = admins[username];
      console.log(`Checking credentials: User found in config? ${!!adminUser}, Password match? ${adminUser ? adminUser.password === password : 'N/A'}`); // Logging
      if (adminUser && adminUser.password === password) {
        console.log(`Login successful for ${username}. Emitting login_success.`); // Logging
        adminSockets[socket.id] = username; // Simpan username berdasarkan socket ID
        socket.emit('login_success', { username, initials: adminUser.initials }); // Kirim juga inisial
        // Kirim status pick awal ke admin yang baru login
        socket.emit('initial_pick_status', pickedChats);

    // Event untuk mengirim data awal (semua history chat)
    socket.on('request_initial_data', () => {
      const username = adminSockets[socket.id];
      if (username) {
        console.log(`Admin ${username} meminta data awal.`);
        // Kirim seluruh history chat yang tersimpan
        // Format: { chatId1: [msg1, msg2], chatId2: [msg3] }
        socket.emit('initial_data', chatHistory);
      } else {
        console.log(`Socket ${socket.id} meminta data awal tetapi tidak terautentikasi.`);
        // Mungkin kirim error atau abaikan
      }
    });
      } else {
        console.log(`Login failed for username: ${username}. Emitting login_failed.`); // Logging
        socket.emit('login_failed');
      }
    });

    // Logout admin
    socket.on('admin_logout', () => {
      const username = adminSockets[socket.id];
      if (username) {
        console.log(`Admin ${username} logout.`);
        // Hapus chat yang sedang diambil oleh admin ini
        for (const chatId in pickedChats) {
          if (pickedChats[chatId] === username) {
            delete pickedChats[chatId];
            // Broadcast perubahan status pick
            io.emit('update_pick_status', { chatId, pickedBy: null });
            console.log(`Chat ${chatId} dilepas karena ${username} logout.`);
          }
        }
        delete adminSockets[socket.id];
      }
    });

    // Event untuk mengambil chat
    socket.on('pick_chat', ({ chatId }) => {
      const username = adminSockets[socket.id];
      if (!username) {
        socket.emit('pick_error', { chatId, message: 'Anda harus login untuk mengambil chat.' });
        return;
      }
      if (pickedChats[chatId] && pickedChats[chatId] !== username) {
        socket.emit('pick_error', { chatId, message: `Chat sudah diambil oleh ${pickedChats[chatId]}.` });
      } else if (!pickedChats[chatId]) {
        pickedChats[chatId] = username;
        console.log(`Admin ${username} mengambil chat ${chatId}`);
        // Broadcast perubahan status pick ke semua admin
        io.emit('update_pick_status', { chatId, pickedBy: username });
        // Tandai chat sebagai sudah dibaca oleh admin yang mengambil
        // (Opsional: bisa juga dilakukan di frontend saat loadChatMessages)
        // io.emit('update_chat_status', { chatId, unread: false });
      } else {
        // Admin yang sama mengklik pick lagi (tidak perlu aksi khusus, atau bisa dianggap error)
        // socket.emit('pick_error', { chatId, message: 'Anda sudah mengambil chat ini.' });
        console.log(`Admin ${username} sudah mengambil chat ${chatId}`);
      }
    });

    // Event untuk melepas chat (opsional)
    socket.on('unpick_chat', ({ chatId }) => {
      const username = adminSockets[socket.id];
      if (pickedChats[chatId] === username) {
        delete pickedChats[chatId];
        console.log(`Admin ${username} melepas chat ${chatId}`);
        io.emit('update_pick_status', { chatId, pickedBy: null });
      } else if (pickedChats[chatId]) {
         socket.emit('pick_error', { chatId, message: `Anda tidak bisa melepas chat yang diambil oleh ${pickedChats[chatId]}.` });
      } else {
         socket.emit('pick_error', { chatId, message: 'Chat ini belum diambil.' });
      }
    });
    // Event untuk melepas chat (opsional, tapi berguna)
    socket.on('unpick_chat', ({ chatId }) => {
      const username = adminSockets[socket.id];
      if (!username) {
        socket.emit('pick_error', { chatId, message: 'Anda harus login.' });
        return;
      }
      if (pickedChats[chatId] === username) {
        delete pickedChats[chatId];
        console.log(`Admin ${username} melepas chat ${chatId}`);
        io.emit('update_pick_status', { chatId, pickedBy: null });
      } else if (pickedChats[chatId]) {
         socket.emit('pick_error', { chatId, message: `Anda tidak bisa melepas chat yang diambil oleh ${pickedChats[chatId]}.` });
      } else {
         // Chat memang tidak sedang diambil, tidak perlu error
         console.log(`Admin ${username} mencoba melepas chat ${chatId} yang tidak diambil.`);
         // socket.emit('pick_error', { chatId, message: 'Chat ini belum diambil.' });
      }
    });

    socket.on('reply_message', async ({ to, text }) => {
      const username = adminSockets[socket.id];
      if (!username) {
        socket.emit('send_error', { to, text, message: 'Login diperlukan untuk mengirim balasan.' });
        return;
      }

      // Cek apakah chat sudah diambil dan oleh siapa
      if (!pickedChats[to]) {
          socket.emit('send_error', { to, text, message: 'Anda harus mengambil chat ini terlebih dahulu sebelum membalas.' });
          console.log(`Admin ${username} mencoba membalas chat ${to} yang belum diambil.`);
          return;
      }

      if (pickedChats[to] !== username) {
        socket.emit('send_error', { to, text, message: `Chat ini sedang ditangani oleh ${pickedChats[to]}.` });
        console.log(`Admin ${username} mencoba membalas chat ${to} yang diambil oleh ${pickedChats[to]}.`);
        return;
      }

      // Jika chat diambil oleh admin yang benar, lanjutkan mengirim
      try {
        const adminInitials = admins[username]?.initials || '??'; // Dapatkan inisial admin
        const replyTextWithInitials = `${text}\n\n-${adminInitials}`; // Tambahkan inisial ke teks balasan dengan format baru

        console.log(`Admin ${username} (${adminInitials}) mengirim balasan ke: ${to}, Pesan: ${replyTextWithInitials}`);
        const sentMsg = await sock.sendMessage(to, { text: replyTextWithInitials });
        console.log(`Pesan dari ${username} berhasil dikirim ke WhatsApp: ${sentMsg.key.id}`);
        // Logging tambahan untuk verifikasi
        console.log('Detail pesan terkirim:', {
          to: to,
          text: replyTextWithInitials,
          id: sentMsg.key.id,
          timestamp: new Date().toISOString()
        });

        // Buat data pesan keluar untuk history dan konfirmasi
        const outgoingMessageData = {
          from: username, // Gunakan username admin
          to: to,
          text: text, // Simpan teks asli tanpa inisial di history internal
          initials: adminInitials, // Simpan inisial
          timestamp: new Date(sentMsg.messageTimestamp * 1000).toISOString(), // Gunakan timestamp dari Baileys
          type: 'outgoing',
          id: sentMsg.key.id // Sertakan ID pesan untuk referensi
        };

        // Kirim konfirmasi ke klien yang mengirim (termasuk inisial)
        socket.emit('reply_sent_confirmation', outgoingMessageData);

        // Simpan pesan keluar ke history (gunakan data yang sudah dibuat)
        if (!chatHistory[to]) {
          chatHistory[to] = [];
        }
        chatHistory[to].push(outgoingMessageData);
        saveChatHistory(); // Simpan perubahan ke file

      } catch (error) {
        console.error('Gagal mengirim pesan:', error);
        // Kirim error ke klien yang mengirim
        socket.emit('send_error', {
          to: to,
          text: text,
          message: 'Gagal mengirim pesan ke WhatsApp: ' + error.message
        });
      }
    });

    // Handle mark as read
    socket.on('mark_as_read', ({ chatId }) => {
      const username = adminSockets[socket.id];
      const pickedBy = pickedChats[chatId];

      // Hanya proses jika chat belum diambil atau diambil oleh admin yang mengirim event
      if (!pickedBy || pickedBy === username) {
          console.log(`Chat ${chatId} ditandai terbaca oleh ${username || 'sistem'}`);
          // Broadcast status unread=false ke semua admin
          // Frontend akan mengabaikan ini jika chat diambil oleh admin lain
          io.emit('update_chat_status', {
            chatId,
            unread: false
          });
          // Update status unread di history (jika perlu)
          // if (chatHistory[chatId]) {
          //     const lastMessage = chatHistory[chatId][chatHistory[chatId].length - 1];
          //     if (lastMessage) lastMessage.unread = false;
          //     saveChatHistory();
          // }
      } else {
          console.log(`Event mark_as_read untuk ${chatId} diabaikan karena diambil oleh ${pickedBy}`);
      }
    });

    // Event untuk meminta status pick awal (dipanggil dari frontend setelah login)
    // Sebenarnya sudah dikirim saat 'login_success', tapi bisa jadi fallback
    socket.on('request_initial_pick_status', () => {
        socket.emit('initial_pick_status', pickedChats);

    // Event untuk mengirim data awal (semua history chat)
    socket.on('request_initial_data', () => {
      const username = adminSockets[socket.id];
      if (username) {
        console.log(`Admin ${username} meminta data awal.`);
        // Kirim seluruh history chat yang tersimpan
        // Format: { chatId1: [msg1, msg2], chatId2: [msg3] }
        socket.emit('initial_data', chatHistory);
      } else {
        console.log(`Socket ${socket.id} meminta data awal tetapi tidak terautentikasi.`);
        // Mungkin kirim error atau abaikan
      }
    });
    });



    socket.on('disconnect', () => {
      const username = adminSockets[socket.id];
      if (username) {
        console.log(`Admin ${username} terputus (${socket.id})`);
        // Otomatis unpick chat yang sedang ditangani saat disconnect
        for (const chatId in pickedChats) {
          if (pickedChats[chatId] === username) {
            delete pickedChats[chatId];
            // Broadcast perubahan status pick
            io.emit('update_pick_status', { chatId, pickedBy: null });
            console.log(`Chat ${chatId} dilepas karena ${username} terputus.`);
          }
        }
        delete adminSockets[socket.id]; // Hapus dari daftar admin aktif
      } else {
         console.log('Koneksi socket terputus (belum login):', socket.id);
      }
    });
  });
}

// Mulai koneksi WhatsApp
connectToWhatsApp();