const { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } = require('baileys');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const qrcode = require('qrcode-terminal');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const pino = require('pino'); // Untuk logging Baileys yang lebih detail (opsional)
const config = require('./config');

// --- Konfigurasi & State ---
const admins = config.admins;
const adminSockets = {}; // socket ID -> username
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId -> username
const chatReleaseTimers = {}; // chatId -> setTimeout ID
const chatHistoryFile = path.join(__dirname, 'chat_history.json');
let chatHistory = {}; // { chatId: [messages] }
let sock; // Variabel global untuk instance socket Baileys

// --- Fungsi Helper ---

// Logger Baileys (opsional, bisa dikomentari jika tidak perlu detail)
const logger = pino({ level: 'warn' }); // Level: 'trace', 'debug', 'info', 'warn', 'error', 'fatal'

// Memuat history chat dari file
function loadChatHistory() {
  try {
    if (fs.existsSync(chatHistoryFile)) {
      const data = fs.readFileSync(chatHistoryFile, 'utf-8');
      chatHistory = JSON.parse(data);
      console.log('Riwayat chat berhasil dimuat.');
    } else {
      console.log('File riwayat chat tidak ditemukan, memulai dengan history kosong.');
      chatHistory = {};
    }
  } catch (error) {
    console.error('Gagal memuat riwayat chat:', error);
    chatHistory = {};
  }
}

// Menyimpan history chat ke file
function saveChatHistory() {
  try {
    fs.writeFileSync(chatHistoryFile, JSON.stringify(chatHistory, null, 2), 'utf-8');
  } catch (error) {
    console.error('Gagal menyimpan riwayat chat:', error);
  }
}

// Membatalkan timer auto-release
function clearAutoReleaseTimer(chatId) {
  if (chatReleaseTimers[chatId]) {
    clearTimeout(chatReleaseTimers[chatId]);
    delete chatReleaseTimers[chatId];
    // console.log(`Timer auto-release untuk chat ${chatId} dibatalkan.`); // Kurangi log
  }
}

// Memulai timer auto-release
function startAutoReleaseTimer(chatId, username) {
  clearAutoReleaseTimer(chatId); // Hapus timer lama jika ada

  const timeoutMinutes = config.chatAutoReleaseTimeoutMinutes;
  if (timeoutMinutes && timeoutMinutes > 0) {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    console.log(`Memulai timer auto-release ${timeoutMinutes} menit untuk chat ${chatId} oleh ${username}.`);

    chatReleaseTimers[chatId] = setTimeout(() => {
      if (pickedChats[chatId] === username) {
        console.log(`Timer auto-release habis untuk chat ${chatId} (diambil ${username}). Melepas chat.`);
        delete pickedChats[chatId];
        delete chatReleaseTimers[chatId];
        io.emit('update_pick_status', { chatId, pickedBy: null });
        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId) {
          io.to(targetSocketId).emit('auto_release_notification', { chatId, message: `Chat ${chatId.split('@')[0]} dilepas otomatis (tidak aktif).` });
        }
      } else {
        // console.log(`Timer auto-release habis untuk chat ${chatId}, tapi status pick sudah berubah.`); // Kurangi log
        delete chatReleaseTimers[chatId];
      }
    }, timeoutMs);
  }
}

// Mendapatkan daftar username admin yang sedang online
function getOnlineAdminUsernames() {
    return Object.values(adminSockets);
}

// Membersihkan state admin saat disconnect/logout
function cleanupAdminState(socketId) {
    const username = adminSockets[socketId];
    if (username) {
        console.log(`Membersihkan state untuk admin ${username} (Socket ID: ${socketId})`);
        // Lepas chat yang sedang diambil dan batalkan timer
        for (const chatId in pickedChats) {
            if (pickedChats[chatId] === username) {
                clearAutoReleaseTimer(chatId);
                delete pickedChats[chatId];
                io.emit('update_pick_status', { chatId, pickedBy: null });
                console.log(`Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            }
        }
        delete adminSockets[socketId];
        delete usernameToSocketId[username];
        // Broadcast daftar admin online terbaru
        io.emit('update_online_admins', getOnlineAdminUsernames());
        return username;
    }
    return null;
}

// --- Setup Express & Server ---
loadChatHistory(); // Muat history saat mulai

app.use(express.static(__dirname)); // Sajikan file statis (HTML, CSS, JS Client)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Konfigurasi session
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set true jika pakai HTTPS
}));

const PORT = config.serverPort || 3000;
http.listen(PORT, () => {
  console.log(`Server Helpdesk berjalan di http://localhost:${PORT}`);
});

// --- Koneksi WhatsApp (Baileys) ---
async function connectToWhatsApp() {
  console.log("Mencoba menghubungkan ke WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.baileysOptions?.printQRInTerminal ?? true, // Ambil dari config atau default true
    browser: Browsers.macOS('Desktop'), // Memberi tahu WA kita adalah browser desktop
    logger: logger, // Gunakan logger pino
    // Opsi lain jika diperlukan:
    // version: [2, 2413, 1], // Contoh pin versi jika ada masalah kompatibilitas
    // connectTimeoutMs: 60000, // Timeout koneksi lebih lama
    // keepAliveIntervalMs: 30000 // Interval keep-alive
  });

  // Event handler Baileys
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('QR Code diterima, pindai dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = ![401, 403, 411, 419, 500].includes(statusCode); // Kode error yg tidak perlu reconnect otomatis
      console.error(`Koneksi WhatsApp terputus: ${lastDisconnect?.error?.message || 'Alasan tidak diketahui'} (Code: ${statusCode}), Mencoba menyambung kembali: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 15000); // Coba sambung lagi setelah 15 detik
      } else {
        console.error("Tidak dapat menyambung kembali secara otomatis. Periksa folder auth_info_baileys atau scan ulang QR.");
        // Mungkin perlu membersihkan sesi atau memberi tahu admin
      }
    } else if (connection === 'open') {
      console.log('Berhasil terhubung ke WhatsApp!');
      io.emit('whatsapp_connected'); // Beri tahu frontend bahwa WA terhubung
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
      // Abaikan notifikasi status, pesan dari diri sendiri, atau pesan tanpa konten
      if (message.key.remoteJid === 'status@broadcast' || message.key.fromMe || !message.message) {
          continue;
      }

      console.log('Pesan masuk dari:', message.key.remoteJid);
      const chatId = message.key.remoteJid;
      let messageContent = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
      let mediaData = null;
      let mediaType = null;
      let caption = '';
      let fileName = null;

      // Cek tipe pesan dan unduh media jika ada
      const messageType = Object.keys(message.message)[0];
      const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType);

      if (isMedia) {
          try {
              // Hati-hati: downloadMediaMessage bisa memakan waktu & resource
              const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
              mediaData = buffer.toString('base64');
              mediaType = messageType;
              caption = message.message[mediaType]?.caption || '';
              if (mediaType === 'documentMessage') {
                  fileName = message.message[mediaType]?.fileName || 'Dokumen';
              }
              // Prioritaskan caption, lalu nama file untuk konten teks jika media
              messageContent = caption || (mediaType === 'documentMessage' ? fileName : '');
              // console.log(`Media ${mediaType} dari ${chatId} diterima.`); // Kurangi log
          } catch (error) {
              console.error(`Gagal mengunduh media dari ${chatId}:`, error);
              messageContent = '[Gagal memuat media]';
          }
      } else if (!messageContent && messageType !== 'protocolMessage' && messageType !== 'senderKeyDistributionMessage') {
          // Handle pesan tanpa teks (misal: lokasi, kontak, polling - belum didukung)
          console.log(`Tipe pesan tidak didukung atau kosong: ${messageType} dari ${chatId}`);
          messageContent = `[Tipe Pesan: ${messageType}]`; // Beri indikasi tipe pesan
      }

      // Hanya proses jika ada konten yang relevan atau merupakan media
      if (messageContent || mediaData) {
          const messageData = {
              id: message.key.id,
              from: chatId,
              text: messageContent,
              mediaData: mediaData,
              mediaType: mediaType,
              fileName: fileName,
              timestamp: message.messageTimestamp ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
              unread: true,
              type: 'incoming'
          };

          // Simpan ke history
          if (!chatHistory[chatId]) {
              chatHistory[chatId] = [];
          }
          // Hindari duplikasi sederhana (cek ID jika ada)
          if (!chatHistory[chatId].some(m => m.id === messageData.id)) {
              chatHistory[chatId].push(messageData);
              saveChatHistory(); // Simpan setelah menambahkan
          } else {
              console.warn(`Pesan duplikat terdeteksi (ID: ${messageData.id}), diabaikan.`);
              continue; // Jangan proses lebih lanjut jika duplikat
          }


          // Kirim ke semua admin yang terhubung
          io.emit('new_message', messageData);

          // Notifikasi browser (hanya jika chat tidak sedang di-pick oleh siapapun ATAU di-pick oleh admin lain)
          const pickedBy = pickedChats[chatId];
          // Kita tidak tahu siapa yang menerima notif, jadi kirim saja, frontend yg filter
           io.emit('notification', {
               title: `Pesan Baru (${chatId.split('@')[0]})`,
               body: messageContent || `[${mediaType || 'Media'}]`,
               icon: '/favicon.ico', // Ganti jika perlu
               chatId: chatId // Sertakan chatId agar frontend bisa filter
           });
      }
    }
  });

}

// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`Admin terhubung: ${socket.id}`);

  // Emit daftar admin terdaftar dan online saat admin terhubung
  socket.emit('registered_admins', admins); // Emit registered admins
  socket.emit('update_online_admins', getOnlineAdminUsernames()); // Emit online admins

  // Kirim status awal saat admin baru terhubung
  socket.emit('initial_pick_status', pickedChats);
  socket.emit('update_online_admins', getOnlineAdminUsernames());
  if (sock?.user) { // Kirim status koneksi WA jika sudah terhubung
      socket.emit('whatsapp_connected');
  }

  // Meminta data awal (history & picks) setelah login/reconnect
  socket.on('request_initial_data', () => {
    const username = adminSockets[socket.id];
    if (username) {
      console.log(`Admin ${username} meminta data awal.`);
      socket.emit('initial_data', chatHistory);
      socket.emit('initial_pick_status', pickedChats); // Kirim lagi pick status
      socket.emit('update_online_admins', getOnlineAdminUsernames()); // Kirim lagi admin online
    } else {
      console.warn(`Socket ${socket.id} meminta data awal sebelum login.`);
      socket.emit('request_login'); // Minta klien untuk login
    }
  });

  // Meminta history chat spesifik
  socket.on('get_chat_history', (chatId) => {
    const username = adminSockets[socket.id];
    if (username && chatId) {
        // console.log(`Admin ${username} meminta history untuk ${chatId}`); // Kurangi log
        const history = chatHistory[chatId] || [];
        socket.emit('chat_history', { chatId, messages: history });
     }
  });

  // Proses login admin
  socket.on('admin_login', ({ username, password }) => {
    const adminUser = admins[username];
    if (adminUser && adminUser.password === password) {
      if (usernameToSocketId[username]) {
         console.warn(`Login gagal: Admin ${username} sudah login dari socket ${usernameToSocketId[username]}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain.' });
         return;
      }
      console.log(`Login berhasil: ${username} (Socket ID: ${socket.id})`);
      adminSockets[socket.id] = username;
      usernameToSocketId[username] = socket.id;
      socket.emit('login_success', { username, initials: adminUser.initials });
      // Kirim data awal setelah login berhasil
      socket.emit('initial_data', chatHistory);
      socket.emit('initial_pick_status', pickedChats);
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Broadcast update admin online
    } else {
      console.log(`Login gagal untuk username: ${username}.`);
      socket.emit('login_failed', { message: 'Username atau password salah.' });
    }
  });

  // Handle admin reconnect
  socket.on('admin_reconnect', ({ username }) => {
    const adminUser = admins[username];
    if (adminUser) {
        if (usernameToSocketId[username]) {
            console.warn(`Reconnect failed: Admin ${username} already logged in from another socket.`);
            socket.emit('reconnect_failed');
            return;
        }
        console.log(`Reconnect successful for ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = username;
        usernameToSocketId[username] = socket.id;
        socket.emit('reconnect_success', { username, currentPicks: pickedChats });
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Broadcast updated online admins
    } else {
        console.warn(`Reconnect failed: Admin ${username} not found.`);
        socket.emit('reconnect_failed');
    }
  });

  // Proses logout admin
  socket.on('admin_logout', () => {
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`Admin ${username} logout.`);
        socket.emit('logout_success'); // Notify the client of successful logout
    }
  });

  // Mengambil chat
  socket.on('pick_chat', ({ chatId }) => {
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
    if (!chatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    if (pickedChats[chatId] && pickedChats[chatId] !== username) {
      socket.emit('pick_error', { chatId, message: `Sudah diambil oleh ${pickedChats[chatId]}.` });
    } else if (!pickedChats[chatId]) {
      pickedChats[chatId] = username;
      console.log(`Admin ${username} mengambil chat ${chatId}`);
      io.emit('update_pick_status', { chatId, pickedBy: username });
      startAutoReleaseTimer(chatId, username); // Mulai timer
      // Tandai pesan terakhir sebagai terbaca oleh sistem (opsional)
       if (chatHistory[chatId]) {
           const lastMsg = chatHistory[chatId][chatHistory[chatId].length - 1];
           if (lastMsg && lastMsg.type === 'incoming' && lastMsg.unread) {
               lastMsg.unread = false;
               saveChatHistory();
               // Beri tahu semua klien bahwa status baca berubah (frontend akan handle indikator)
               io.emit('update_chat_read_status', { chatId });
           }
       }
    } else {
      // Admin yang sama mengklik pick lagi -> restart timer
      console.log(`Admin ${username} mengklik pick lagi untuk ${chatId}, restart timer.`);
      startAutoReleaseTimer(chatId, username);
      socket.emit('pick_info', { chatId, message: 'Timer direset.' }); // Info opsional
    }
  });

  // Melepas chat
  socket.on('unpick_chat', ({ chatId }) => {
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
    if (!chatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    if (pickedChats[chatId] === username) {
      clearAutoReleaseTimer(chatId); // Batalkan timer
      delete pickedChats[chatId];
      console.log(`Admin ${username} melepas chat ${chatId}`);
      io.emit('update_pick_status', { chatId, pickedBy: null });
    } else if (pickedChats[chatId]) {
       socket.emit('pick_error', { chatId, message: `Hanya ${pickedChats[chatId]} yang bisa melepas chat ini.` });
    } else {
       socket.emit('pick_error', { chatId, message: 'Chat ini tidak sedang diambil.' });
    }
  });

  // Mendelegasikan chat
  socket.on('delegate_chat', ({ chatId, targetAdminUsername }) => {
      const senderAdminUsername = adminSockets[socket.id];

      // Validasi
      if (!senderAdminUsername) return socket.emit('delegate_error', { chatId, message: 'Login diperlukan.' });
      if (!chatId || !targetAdminUsername) return socket.emit('delegate_error', { chatId, message: 'Data tidak lengkap.' });
      if (pickedChats[chatId] !== senderAdminUsername) return socket.emit('delegate_error', { chatId, message: 'Anda tidak memegang chat ini.' });
      if (senderAdminUsername === targetAdminUsername) return socket.emit('delegate_error', { chatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      if (!usernameToSocketId[targetAdminUsername]) return socket.emit('delegate_error', { chatId, message: `Admin ${targetAdminUsername} tidak online.` });

      // Proses Delegasi
      console.log(`Admin ${senderAdminUsername} mendelegasikan chat ${chatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(chatId); // Batalkan timer lama
      pickedChats[chatId] = targetAdminUsername; // Update pemilik chat
      startAutoReleaseTimer(chatId, targetAdminUsername); // Mulai timer baru untuk target

      io.emit('update_pick_status', { chatId, pickedBy: targetAdminUsername }); // Broadcast perubahan

      // Notifikasi ke target
      const targetSocketId = usernameToSocketId[targetAdminUsername];
      io.to(targetSocketId).emit('chat_delegated_to_you', {
          chatId,
          fromAdmin: senderAdminUsername,
          message: `Chat ${chatId.split('@')[0]} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
      });

      // Konfirmasi ke pengirim
      socket.emit('delegate_success', { chatId, targetAdminUsername });
  });

  // Mengirim balasan
  socket.on('reply_message', async ({ to, text }) => {
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('send_error', { to, text, message: 'Login diperlukan.' });
    if (!to || !text) return socket.emit('send_error', { to, text, message: 'Data tidak lengkap.' });
    if (!sock) return socket.emit('send_error', { to, text, message: 'Koneksi WhatsApp belum siap.' });

    if (!pickedChats[to]) {
        return socket.emit('send_error', { to, text, message: 'Ambil chat ini terlebih dahulu.' });
    }
    if (pickedChats[to] !== username) {
      return socket.emit('send_error', { to, text, message: `Sedang ditangani oleh ${pickedChats[to]}.` });
    }

    try {
      const adminInfo = admins[username];
      const adminInitials = adminInfo?.initials || username.substring(0, 2).toUpperCase();
      const replyTextWithInitials = `${text.trim()}\n\n_${adminInitials}_`; // Italic initials

      // console.log(`Admin ${username} mengirim balasan ke: ${to}`); // Kurangi log
      const sentMsg = await sock.sendMessage(to, { text: replyTextWithInitials });
      // console.log(`Pesan dari ${username} berhasil dikirim: ${sentMsg.key.id}`); // Kurangi log

      clearAutoReleaseTimer(to); // Batalkan timer karena ada balasan

      const outgoingMessageData = {
        id: sentMsg.key.id,
        from: username, // Nama admin pengirim
        to: to,
        text: text.trim(), // Teks asli
        initials: adminInitials,
        timestamp: sentMsg.messageTimestamp ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
        type: 'outgoing'
      };

      socket.emit('reply_sent_confirmation', outgoingMessageData); // Konfirmasi ke pengirim

      // Simpan ke history
      if (!chatHistory[to]) chatHistory[to] = [];
      chatHistory[to].push(outgoingMessageData);
      saveChatHistory();

      // Broadcast ke admin lain (opsional, agar mereka lihat balasannya juga)
      // socket.broadcast.emit('new_outgoing_message', outgoingMessageData);

    } catch (error) {
      console.error(`Gagal mengirim pesan ke ${to} oleh ${username}:`, error);
      socket.emit('send_error', { to, text, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  // Menandai chat sebagai sudah dibaca
  socket.on('mark_as_read', ({ chatId }) => {
     const username = adminSockets[socket.id];
     if (!username || !chatId) return; // Abaikan jika tidak login atau chatId kosong

     const pickedBy = pickedChats[chatId];

     // Hanya proses jika chat belum diambil ATAU diambil oleh admin yang mengirim event
     if (!pickedBy || pickedBy === username) {
          // console.log(`Chat ${chatId} ditandai terbaca oleh ${username}.`); // Kurangi log
         if (chatHistory[chatId]) {
              let changed = false;
              // Tandai semua pesan masuk terakhir sebagai sudah dibaca
              for (let i = chatHistory[chatId].length - 1; i >= 0; i--) {
                   if (chatHistory[chatId][i].type === 'incoming' && chatHistory[chatId][i].unread) {
                       chatHistory[chatId][i].unread = false;
                       changed = true;
                   } else if (chatHistory[chatId][i].type === 'outgoing') {
                       // Berhenti jika sudah mencapai pesan keluar terakhir (asumsi sudah dibaca)
                       break;
                   }
              }
              if (changed) {
                  saveChatHistory(); // Simpan jika ada perubahan
                  io.emit('update_chat_read_status', { chatId }); // Broadcast status baca
              }
         }
     } else {
          // console.log(`Event mark_as_read untuk ${chatId} dari ${username} diabaikan (diambil ${pickedBy}).`); // Kurangi log
     }
   });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    const username = adminSockets[socket.id]; // Ambil username SEBELUM dihapus
    const cleanedUsername = cleanupAdminState(socket.id); // Hapus dari state
    if (cleanedUsername) {
      console.log(`Admin ${cleanedUsername} terputus (${socket.id}). Alasan: ${reason}`);
    } else {
       console.log(`Koneksi socket ${socket.id} terputus (belum login). Alasan: ${reason}`);
    }
  });
});

// --- Mulai Koneksi WhatsApp ---
connectToWhatsApp().catch(err => {
  console.error("Gagal memulai koneksi WhatsApp awal:", err);
  // Mungkin perlu keluar atau mencoba lagi dengan strategi berbeda
});

// --- Graceful Shutdown (opsional tapi bagus) ---
process.on('SIGINT', async () => {
  console.log('Menerima SIGINT (Ctrl+C). Membersihkan...');
  if (sock) {
    // await sock.logout(); // Logout dari sesi WA jika memungkinkan
    console.log('Menutup koneksi WhatsApp...');
    // sock.ws.close(); // Tutup websocket jika perlu
  }
  saveChatHistory(); // Pastikan history tersimpan
  console.log('Server dimatikan.');
  process.exit(0);
});