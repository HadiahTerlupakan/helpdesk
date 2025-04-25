import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } from 'baileys';
import express from 'express';
const expressApp = express();
import http from 'http';
const server = http.createServer(expressApp);
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins; replace with specific origin if needed
        methods: ["GET", "POST"]
    }
});
import qrcode from 'qrcode-terminal';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import pino from 'pino'; // Untuk logging Baileys yang lebih detail (opsional)
import config from './config.js';
import { fileURLToPath } from 'url';

// --- Konfigurasi & State ---
const admins = config.admins;
const adminSockets = {}; // socket ID -> username
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId -> username
const chatReleaseTimers = {}; // chatId -> setTimeout ID
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const chatHistoryFile = path.join(__dirname, 'chat_history.json');
let chatHistory = {}; // { chatId: [messages] }
let sock; // Variabel global untuk instance socket Baileys

// --- Fungsi Helper ---

// Logger Baileys (opsional, bisa dikomentari jika tidak perlu detail)
const logger = pino({ level: 'warn' }); // Level: 'trace', 'debug', 'info', 'warn', 'error', 'fatal'

// Memuat history chat dari file
import { getDatabase, ref, child, get, set } from 'firebase/database';
import { app as firebaseApp, database } from './firebaseConfig.js';

function loadChatHistory() {
  const dbRef = ref(database, 'chatHistory'); // Pastikan referensi ke 'chatHistory' benar
  get(dbRef)
    .then((snapshot) => {
      if (snapshot.exists()) {
        const encodedChatHistory = snapshot.val();
        chatHistory = {};
        for (const encodedKey in encodedChatHistory) {
          const decodedKey = decodeFirebaseKey(encodedKey); // Decode kunci saat membaca
          chatHistory[decodedKey] = encodedChatHistory[encodedKey];
        }
        console.log('Riwayat chat berhasil dimuat dari Firebase.');
      } else {
        console.log('Tidak ada riwayat chat di Firebase, memulai dengan history kosong.');
        chatHistory = {};
      }
    })
    .catch((error) => {
      console.error('Gagal memuat riwayat chat dari Firebase:', error);
    });
}

function saveChatHistory() {
  const encodedChatHistory = {};
  for (const chatId in chatHistory) {
    const encodedKey = encodeFirebaseKey(chatId); // Encode kunci saat menyimpan
    encodedChatHistory[encodedKey] = chatHistory[chatId];
  }

  const dbRef = ref(database, 'chatHistory');
  set(dbRef, encodedChatHistory)
    .then(() => {
      console.log('Riwayat chat berhasil disimpan ke Firebase.');
    })
    .catch((error) => {
      console.error('Gagal menyimpan riwayat chat ke Firebase:', error);
    });
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

// Fungsi untuk memastikan chatId dalam format lengkap
function normalizeChatId(chatId) {
  if (!chatId.includes('@')) {
    return `${chatId}@s.whatsapp.net`;
  }
  return chatId;
}

// Fungsi untuk decode kunci jika diperlukan (opsional)
function decodeFirebaseKey(encodedKey) {
  return encodedKey
    .replace(/_dot_/g, '.')
    .replace(/_at_/g, '@')
    .replace(/_dollar_/g, '$')
    .replace(/_slash_/g, '/')
    .replace(/_openbracket_/g, '[')
    .replace(/_closebracket_/g, ']');
}

// Fungsi untuk meng-encode kunci agar valid di Firebase
function encodeFirebaseKey(key) {
  return key
    .replace(/\./g, '_dot_')
    .replace(/@/g, '_at_')
    .replace(/\$/g, '_dollar_')
    .replace(/\//g, '_slash_')
    .replace(/\[/g, '_openbracket_')
    .replace(/\]/g, '_closebracket_');
}

// --- Setup Express & Server ---
loadChatHistory(); // Muat history saat mulai

// Ganti `app` dengan `expressApp`
expressApp.use(express.static(__dirname)); // Sajikan file statis (HTML, CSS, JS Client)
expressApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Konfigurasi session
expressApp.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set true jika pakai HTTPS
}));

const PORT = config.serverPort || 3000;
server.listen(PORT, () => { // Ganti `http.listen` dengan `server.listen`
  console.log(`Server Helpdesk berjalan di http://localhost:${PORT}`);
  console.log(`Versi Aplikasi: ${config.version}`); // Log versi aplikasi
});

// --- Koneksi WhatsApp (Baileys) ---
let qrDisplayed = false; // Tambahkan variabel untuk melacak status QR Code

async function connectToWhatsApp() {
  console.log("Mencoba menghubungkan ke WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.baileysOptions?.printQRInTerminal ?? true,
    browser: Browsers.macOS('Desktop'),
    logger: logger,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !qrDisplayed) { // Tampilkan QR hanya jika belum ditampilkan
      qrDisplayed = true; // Tandai QR sudah ditampilkan
      console.log('QR Code diterima, pindai dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      qrDisplayed = false; // Reset status QR jika koneksi terputus
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = ![401, 403, 411, 419, 500].includes(statusCode);
      console.error(`Koneksi WhatsApp terputus: ${lastDisconnect?.error?.message || 'Alasan tidak diketahui'} (Code: ${statusCode}), Mencoba menyambung kembali: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 15000);
      } else {
        console.error("Tidak dapat menyambung kembali secara otomatis. Periksa folder auth_info_baileys atau scan ulang QR.");
      }
    } else if (connection === 'open') {
      console.log('Berhasil terhubung ke WhatsApp!');
      io.emit('whatsapp_connected');
    }
  });

  // Tambahkan variabel untuk melacak pesan keluar yang sudah ditangani
  const outgoingMessageIds = new Set();

  // Pastikan event handler hanya terdaftar satu kali
  sock.ev.off('messages.upsert');
  
  sock.ev.on('messages.upsert', async ({ messages }) => {
    // Skip jika tidak ada pesan
    if (!messages || messages.length === 0) return;
    for (const message of messages) {
      const chatId = normalizeChatId(message.key.remoteJid); // Pastikan format asli

      // Abaikan pesan keluar yang sudah diproses
      if (message.key.fromMe) {
        if (outgoingMessageIds.has(message.key.id)) {
          console.log(`Pesan keluar dengan ID ${message.key.id} sudah diproses sebelumnya.`);
          continue;
        }
        console.log(`Pesan keluar dengan ID ${message.key.id} diabaikan dalam upsert.`);
        outgoingMessageIds.add(message.key.id);
        continue;
      }

      // Inisialisasi variabel untuk konten pesan
      let messageContent = null;
      let mediaData = null;
      let mediaType = null;
      let fileName = null;

      // Tentukan tipe pesan
      const messageType = Object.keys(message.message)[0];
      const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType);

      if (isMedia) {
        try {
          // Unduh media jika ada
          const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
          mediaData = buffer.toString('base64'); // Konversi ke base64
          mediaType = messageType;
          fileName = message.message[mediaType]?.fileName || 'Media';
          messageContent = message.message[mediaType]?.caption || `[${mediaType}]`; // Gunakan caption jika ada
        } catch (error) {
          console.error(`Gagal mengunduh media dari ${chatId}:`, error);
          messageContent = '[Gagal memuat media]';
        }
      } else if (messageType === 'conversation') {
        messageContent = message.message.conversation;
      } else if (messageType === 'extendedTextMessage') {
        messageContent = message.message.extendedTextMessage.text;
      } else {
        messageContent = '[Pesan tidak dikenal]';
      }

      const messageData = {
        id: message.key.id,
        from: chatId,
        text: messageContent,
        mediaData: mediaData,
        mediaType: mediaType,
        fileName: fileName,
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        unread: true,
        type: 'incoming' // Pastikan hanya pesan masuk yang diberi tipe 'incoming'
      };

      const encodedChatId = encodeFirebaseKey(chatId); // Encode kunci untuk penyimpanan
      if (!chatHistory[encodedChatId]) {
        chatHistory[encodedChatId] = [];
      }

      // Hindari duplikasi sederhana (cek ID jika ada)
      if (!chatHistory[encodedChatId].some(m => m.id === messageData.id)) {
        chatHistory[encodedChatId].push(messageData);
        saveChatHistory(); // Simpan setelah menambahkan pesan baru
      } else {
        console.warn(`Pesan duplikat terdeteksi (ID: ${messageData.id}), diabaikan.`);
        continue;
      }

      // Kirim ke semua admin yang terhubung
      io.emit('new_message', { ...messageData, chatId }); // Kirim format asli ke frontend

      // Notifikasi browser (hanya jika chat tidak sedang di-pick oleh siapapun ATAU di-pick oleh admin lain)
      const pickedBy = pickedChats[chatId];
      io.emit('notification', {
        title: `Pesan Baru (${chatId.split('@')[0]})`,
        body: messageContent || `[${mediaType || 'Media'}]`,
        icon: '/favicon.ico', // Ganti jika perlu
        chatId: chatId // Sertakan chatId agar frontend bisa filter
      });

      if (message.key.fromMe) {
        // Tandai pesan keluar sebagai sudah ditangani
        outgoingMessageIds.add(message.key.id);
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
      const decodedChatHistory = {};
      for (const encodedKey in chatHistory) {
        const decodedKey = decodeFirebaseKey(encodedKey); // Decode chatId sebelum mengirim ke frontend
        decodedChatHistory[decodedKey] = chatHistory[encodedKey].map((message) => ({
          ...message,
          chatId: decodedKey // Tambahkan chatId ke setiap pesan untuk konsistensi
        }));
      }
      socket.emit('initial_data', decodedChatHistory); // Kirim data histori yang sudah di-decode
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
      const encodedChatId = encodeFirebaseKey(chatId); // Encode untuk pencarian
      const history = chatHistory[encodedChatId]?.map((message) => ({
        ...message,
        chatId // Tambahkan chatId ke setiap pesan untuk konsistensi
      })) || [];
      socket.emit('chat_history', { chatId, messages: history }); // Kirim format asli ke frontend
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

      // Proses Delegasi
      console.log(`Admin ${senderAdminUsername} mendelegasikan chat ${chatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(chatId); // Batalkan timer lama
      pickedChats[chatId] = targetAdminUsername; // Update pemilik chat
      startAutoReleaseTimer(chatId, targetAdminUsername); // Mulai timer baru untuk target

      io.emit('update_pick_status', { chatId, pickedBy: targetAdminUsername }); // Broadcast perubahan

      // Notifikasi ke target jika online
      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId) {
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${chatId.split('@')[0]} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
          });
      }

      // Konfirmasi ke pengirim
      socket.emit('delegate_success', { chatId, targetAdminUsername });
  });

  // Mengirim balasan
  socket.on('reply_message', async ({ to, text, media }) => {
    const chatId = normalizeChatId(to); // Normalisasi chatId
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('send_error', { to, text, message: 'Login diperlukan.' });
    if (!chatId || (!text && !media)) return socket.emit('send_error', { to, text, message: 'Data tidak lengkap.' });
    if (!sock) return socket.emit('send_error', { to, text, message: 'Koneksi WhatsApp belum siap.' });

    if (!pickedChats[chatId]) {
      return socket.emit('send_error', { to, text, message: 'Ambil chat ini terlebih dahulu.' });
    }
    if (pickedChats[chatId] !== username) {
      return socket.emit('send_error', { to, text, message: `Sedang ditangani oleh ${pickedChats[chatId]}.` });
    }

    try {
      const adminInfo = admins[username];
      const adminInitials = adminInfo?.initials || username.substring(0, 2).toUpperCase();
      const replyTextWithInitials = text ? `${text.trim()}

_${adminInitials}_` : null;

      let sentMsg;
      if (media) {
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const mediaOptions = {
          caption: replyTextWithInitials,
          mimetype: media.type,
          fileName: media.name
        };

        if (media.type.startsWith('image/')) {
          sentMsg = await sock.sendMessage(chatId, { image: mediaBuffer, ...mediaOptions });
        } else if (media.type.startsWith('video/')) {
          sentMsg = await sock.sendMessage(chatId, { video: mediaBuffer, ...mediaOptions });
        } else if (media.type.startsWith('audio/')) {
          sentMsg = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: media.type });
          if (replyTextWithInitials && !text) {
            await sock.sendMessage(chatId, { text: `_${adminInitials}_` });
          }
        } else if (media.type === 'application/pdf' || media.type.startsWith('document/')) {
          sentMsg = await sock.sendMessage(chatId, { document: mediaBuffer, ...mediaOptions });
        } else {
          console.warn(`Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to, text, media, message: 'Tipe media tidak didukung.' });
          return;
        }
      } else {
        sentMsg = await sock.sendMessage(chatId, { text: replyTextWithInitials });
      }

      const outgoingMessageData = {
        id: sentMsg.key.id,
        from: username,
        to: chatId,
        text: text?.trim() || null,
        mediaType: media?.type || null,
        mediaData: media?.data || null,
        fileName: media?.name || null,
        initials: adminInitials,
        timestamp: sentMsg.messageTimestamp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        type: 'outgoing'
      };

      // Simpan pesan keluar ke chatHistory
      const encodedChatId = encodeFirebaseKey(chatId);
      if (!chatHistory[encodedChatId]) {
        chatHistory[encodedChatId] = [];
      }

      // Hindari duplikasi sebelum menyimpan
      if (!chatHistory[encodedChatId].some(m => m.id === outgoingMessageData.id)) {
        chatHistory[encodedChatId].push(outgoingMessageData);
        saveChatHistory();
      }

      // Kirim pesan keluar ke semua admin yang terhubung
      io.emit('new_message', { ...outgoingMessageData, chatId });

      // Konfirmasi ke pengirim
      socket.emit('reply_sent_confirmation', outgoingMessageData);

    } catch (error) {
      console.error(`Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      socket.emit('send_error', { to, text, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
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
    console.log('Menutup koneksi WhatsApp...');
  }
  saveChatHistory(); // Pastikan history tersimpan sebelum aplikasi dimatikan
  console.log('Server dimatikan.');
  process.exit(0);
});