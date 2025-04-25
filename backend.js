// server.js

import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } from 'baileys';
import express from 'express';
const expressApp = express(); // Gunakan expressApp konsisten
import http from 'http';
const server = http.createServer(expressApp); // Gunakan server konsisten
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins; replace with specific origin if needed
        methods: ["GET", "POST"]
    }
});
import qrcode from 'qrcode-terminal';
import session from 'express-session';
import fs from 'fs'; // Tetap impor fs jika diperlukan untuk hal lain, meskipun chat history di Firebase
import path from 'path';
import pino from 'pino'; // Untuk logging Baileys yang lebih detail (opsional)
import config from './config.js'; // Pastikan file ini ada
import { fileURLToPath } from 'url';

// Firebase Imports
import { getDatabase, ref, child, get, set } from 'firebase/database';
import { app as firebaseApp, database } from './firebaseConfig.js'; // Pastikan file ini ada

// --- Konfigurasi & State ---
const admins = config.admins; // Dari config.js
const adminSockets = {}; // socket ID -> username
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId (normalized) -> username
const chatReleaseTimers = {}; // chatId (normalized) -> setTimeout ID
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// const chatHistoryFile = path.join(__dirname, 'chat_history.json'); // Tidak digunakan lagi untuk Firebase
let chatHistory = {}; // { encodedChatId: [messages] } - Simpan di memory setelah dimuat dari Firebase

let sock; // Variabel global untuk instance socket Baileys

// --- Fungsi Helper ---

// Logger Baileys (opsional, bisa dikomentari jika tidak perlu detail)
const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' }); // Level logging bisa diatur di config

// Memuat history chat dari Firebase
function loadChatHistory() {
  const dbRef = ref(database, 'chatHistory'); // Pastikan referensi ke 'chatHistory' benar
  get(dbRef)
    .then((snapshot) => {
      if (snapshot.exists()) {
        // Data dari Firebase sudah dalam bentuk objek dengan kunci encoded
        const firebaseData = snapshot.val();
        // Langsung gunakan data dari Firebase, kunci sudah encoded
        chatHistory = firebaseData;
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

// Menyimpan history chat ke Firebase
function saveChatHistory() {
  // chatHistory di memory sudah menggunakan kunci yang di-encoded
  const dbRef = ref(database, 'chatHistory');
  set(dbRef, chatHistory)
    .then(() => {
      // console.log('Riwayat chat berhasil disimpan ke Firebase.'); // Kurangi log ini agar tidak spam
    })
    .catch((error) => {
      console.error('Gagal menyimpan riwayat chat ke Firebase:', error);
    });
}

// Membatalkan timer auto-release
function clearAutoReleaseTimer(chatId) {
  const normalizedChatId = normalizeChatId(chatId); // Pastikan pakai normalized ID
  if (chatReleaseTimers[normalizedChatId]) {
    clearTimeout(chatReleaseTimers[normalizedChatId]);
    delete chatReleaseTimers[normalizedChatId];
    // console.log(`Timer auto-release untuk chat ${normalizedChatId} dibatalkan.`); // Kurangi log
  }
}

// Memulai timer auto-release
function startAutoReleaseTimer(chatId, username) {
  const normalizedChatId = normalizeChatId(chatId); // Pastikan pakai normalized ID
  clearAutoReleaseTimer(normalizedChatId); // Hapus timer lama jika ada

  const timeoutMinutes = config.chatAutoReleaseTimeoutMinutes;
  if (timeoutMinutes && timeoutMinutes > 0) {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    console.log(`Memulai timer auto-release ${timeoutMinutes} menit untuk chat ${normalizedChatId} oleh ${username}.`);

    chatReleaseTimers[normalizedChatId] = setTimeout(() => {
      // Cek kembali status pick saat timer habis
      if (pickedChats[normalizedChatId] === username) {
        console.log(`Timer auto-release habis untuk chat ${normalizedChatId} (diambil ${username}). Melepas chat.`);
        delete pickedChats[normalizedChatId];
        delete chatReleaseTimers[normalizedChatId];
        io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Emit ID normalized
        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId) {
          io.to(targetSocketId).emit('auto_release_notification', { chatId: normalizedChatId, message: `Chat ${normalizedChatId.split('@')[0]} dilepas otomatis (tidak aktif).` });
        }
      } else {
         // console.log(`Timer auto-release habis untuk chat ${normalizedChatId}, tapi status pick sudah berubah.`); // Kurangi log
        delete chatReleaseTimers[normalizedChatId]; // Hapus timer meskipun status pick sudah berubah
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
        for (const chatId in pickedChats) { // pickedChats menggunakan normalized ID
            if (pickedChats[chatId] === username) {
                clearAutoReleaseTimer(chatId); // Gunakan normalized ID
                delete pickedChats[chatId];
                io.emit('update_pick_status', { chatId: chatId, pickedBy: null }); // Emit ID normalized
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
  if (!chatId) return null; // Handle null/undefined input
  // Periksa apakah sudah memiliki domain '@s.whatsapp.net' atau '@g.us'
  if (chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@g.us')) {
    return chatId;
  }
  // Asumsikan itu nomor telepon tanpa domain
  return `${chatId}@s.whatsapp.net`;
}

// Fungsi untuk decode kunci jika diperlukan (misal: saat mengirim ke frontend)
function decodeFirebaseKey(encodedKey) {
   if (!encodedKey) return null;
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
   if (!key) return null;
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

expressApp.use(express.static(__dirname)); // Sajikan file statis (HTML, CSS, JS Client)
expressApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Konfigurasi session
expressApp.use(session({
  secret: config.sessionSecret, // Dari config.js
  resave: false,
  saveUninitialized: true,
  cookie: { secure: config.cookieSecure || false } // Set true jika pakai HTTPS
}));

const PORT = config.serverPort || 3000; // Dari config.js atau default 3000
server.listen(PORT, () => {
  console.log(`Server Helpdesk berjalan di http://localhost:${PORT}`);
  console.log(`Versi Aplikasi: ${config.version || 'N/A'}`); // Log versi aplikasi dari config
});

// --- Koneksi WhatsApp (Baileys) ---
let qrDisplayed = false; // Tambahkan variabel untuk melacak status QR Code

async function connectToWhatsApp() {
  console.log("Mencoba menghubungkan ke WhatsApp...");
  // useMultiFileAuthState akan membuat folder 'auth_info_baileys' jika belum ada
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.baileysOptions?.printQRInTerminal ?? true, // Dari config.js
    browser: Browsers.macOS('Desktop'), // Bisa diatur di config jika perlu
    logger: logger, // Gunakan logger pino
    getMessage: async (key) => { // Fungsi getMessage untuk Baileys V4+
        // Ini dipanggil oleh Baileys saat perlu mendapatkan payload pesan sebelumnya (misal untuk quoting)
        // Kita bisa coba cari di history kita
        const encodedChatId = encodeFirebaseKey(key.remoteJid);
        if (chatHistory[encodedChatId]) {
            const msg = chatHistory[encodedChatId].find(m => m.id === key.id);
            // Perlu mengembalikan payload pesan Baileys, bukan format messageData kita
            // Implementasi ini cukup kompleks, untuk pemula bisa dikosongkan/disederhanakan dulu
            // atau diambil dari cache Baileys jika ada.
            // Sebagai fallback sederhana:
            console.warn(`Baileys meminta pesan ${key.id} dari ${key.remoteJid}. Tidak ditemukan di cache history lokal.`);
            return undefined; // Tidak ditemukan
        }
         console.warn(`Baileys meminta pesan ${key.id} dari ${key.remoteJid}. Chat ${encodedChatId} tidak ditemukan di history.`);
        return undefined; // Chat tidak ada di history
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isOnline, isConnecting } = update; // Ambil lebih banyak info jika tersedia

    if (qr && !qrDisplayed) { // Tampilkan QR hanya jika belum ditampilkan
      qrDisplayed = true; // Tandai QR sudah ditampilkan
      console.log('QR Code diterima, pindai dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
      io.emit('whatsapp_qr', qr); // Emit QR ke frontend jika perlu
    }

    if (connection === 'close') {
      qrDisplayed = false; // Reset status QR jika koneksi terputus
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Daftar status code yang TIDAK perlu reconnect otomatis:
      // 401: Unauthorized (sesi invalid)
      // 403: Forbidden
      // 411: Length Required (biasanya masalah request, bukan sesi)
      // 419: Authentication Timeout (sesi expired)
      // 500: Internal Server Error dari WA
      const shouldReconnect = ![401, 403, 411, 419, 500].includes(statusCode);
      console.error(`Koneksi WhatsApp terputus: ${lastDisconnect?.error?.message || 'Alasan tidak diketahui'} (Code: ${statusCode || 'N/A'}), Mencoba menyambung kembali: ${shouldReconnect}`);
      io.emit('whatsapp_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode }); // Beri tahu frontend
      if (shouldReconnect) {
        console.log("Mencoba menyambung kembali dalam 15 detik...");
        setTimeout(connectToWhatsApp, 15000);
      } else {
        console.error("Tidak dapat menyambung kembali secara otomatis. Periksa folder auth_info_baileys, hapus jika sesi invalid, atau scan ulang QR.");
        io.emit('whatsapp_fatal_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode, message: 'Fatal disconnection, manual intervention needed.' });
      }
    } else if (connection === 'open') {
      console.log('Berhasil terhubung ke WhatsApp!');
      qrDisplayed = false; // Reset jika sudah terhubung
      io.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' }); // Beri tahu frontend
      // Setelah terhubung, mungkin perlu memuat ulang/memverifikasi history chat
      // loadChatHistory(); // Mungkin tidak perlu dipanggil di sini jika sudah dipanggil saat server mulai
    } else {
        console.log(`Status koneksi WhatsApp: ${connection} ${isConnecting ? '(connecting)' : ''} ${isOnline ? '(online)' : ''}`);
        // io.emit('whatsapp_status_update', { connection, isOnline, isConnecting }); // Opsional: emit status update
    }
  });

  // --- PERBAIKAN UTAMA UNTUK MENGHINDARI DUPLIKASI PESAN KELUAR ---
  // Event messages.update dan variabel outgoingMessageIds dihapus.
  // messages.upsert HANYA akan memproses pesan MASUK.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Type 'notify' untuk pesan baru, 'append' jika ditambahkan ke chat yang sudah ada
    // console.log('messages.upsert type:', type); // Opsional: log tipe upsert
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
      // --- LANGSUNG ABAIKAN pesan yang dikirim OLEH bot/admin ini ---
      if (message.key.fromMe) {
        // console.log(`Mengabaikan pesan keluar dari messages.upsert (ID: ${message.key.id})`); // Opsional: log yang diabaikan
        continue; // Lewati pemrosesan untuk pesan keluar
      }

      // --- Hanya proses pesan MASUK dari user lain ---
      const chatId = normalizeChatId(message.key.remoteJid); // Pastikan format asli (normalized)

       // Abaikan pesan dari 'status@broadcast' jika tidak diinginkan
      if (chatId === 'status@broadcast') {
          // console.log('Mengabaikan pesan dari status@broadcast');
          continue;
      }
       // Abaikan pesan dari bot sendiri jika entah kenapa muncul (seharusnya sudah terhandle fromMe)
       if (sock?.user?.id && chatId === sock.user.id) {
           console.warn('Mengabaikan pesan dari bot sendiri di messages.upsert? (should be fromMe)');
           continue;
       }

      // Inisialisasi variabel untuk konten pesan
      let messageContent = null;
      let mediaData = null;
      let mediaType = null;
      let fileName = null;

      // Tentukan tipe pesan
      const messageType = message.message ? Object.keys(message.message)[0] : null;
      const isMedia = messageType ? ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType) : false;

      if (isMedia && message.message[messageType]) { // Pastikan message.message[messageType] ada
        try {
          // Unduh media jika ada
          const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
          mediaData = buffer.toString('base64'); // Konversi ke base64
          mediaType = messageType;
          // Coba ambil nama file/caption dari properti yang relevan
          const mediaProps = message.message[messageType];
          fileName = mediaProps.fileName || mediaProps.caption || `${messageType}`; // Fallback
          messageContent = mediaProps.caption || `[${messageType.replace('Message', '')}]`; // Gunakan caption atau tipe media
        } catch (error) {
          console.error(`Gagal mengunduh media dari ${chatId}:`, error);
          messageContent = `[Gagal memuat media ${messageType.replace('Message', '')}]`;
        }
      } else if (messageType === 'conversation') {
        messageContent = message.message.conversation;
      } else if (messageType === 'extendedTextMessage' && message.message.extendedTextMessage.text) {
        messageContent = message.message.extendedTextMessage.text;
        // Handle quoted message info if needed
        // const quotedMessage = message.message.extendedTextMessage.contextInfo?.quotedMessage;
        // if(quotedMessage) { /* proses info pesan yang di-quote */ }
      } else if (messageType === 'imageMessage' && message.message.imageMessage.caption) {
         // Kasus teks pada imageMessage tanpa extendedTextMessage
         messageContent = message.message.imageMessage.caption;
      }
       // Tambahkan handler untuk tipe pesan lain yang umum jika perlu, misal contactsArrayMessage, locationMessage dll.
      else {
         // console.log('Pesan masuk dengan tipe tidak dikenali atau kosong:', messageType, JSON.stringify(message.message)); // Debugging tipe tidak dikenal
         messageContent = `[Pesan tidak dikenal atau kosong: ${messageType || 'N/A'}]`;
      }


      const messageData = {
        id: message.key.id,
        from: chatId, // Untuk pesan masuk, 'from' adalah chatId user
        text: messageContent,
        mediaData: mediaData,
        mediaType: mediaType,
        fileName: fileName,
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        unread: true, // Pesan masuk awal dianggap belum dibaca
        type: 'incoming' // Tandai sebagai pesan masuk
      };

      const encodedChatId = encodeFirebaseKey(chatId); // Encode kunci untuk penyimpanan
      // Pastikan encodedChatId valid sebelum melanjutkan
      if (!encodedChatId) {
          console.error('Gagal meng-encode chatId:', chatId, 'mengabaikan pesan.');
          continue;
      }

      if (!chatHistory[encodedChatId]) {
        chatHistory[encodedChatId] = [];
      }

      // Hindari duplikasi sederhana (cek ID jika ada)
      // Ini penting karena upsert bisa dipicu beberapa kali untuk pesan yang sama.
      if (!chatHistory[encodedChatId].some(m => m.id === messageData.id)) {
        console.log(`Menambahkan pesan masuk baru (ID: ${messageData.id}) ke chat ${chatId}`);
        chatHistory[encodedChatId].push(messageData);
        saveChatHistory(); // Simpan setelah menambahkan pesan baru

        // Kirim pesan masuk baru ke semua admin yang terhubung
        io.emit('new_message', { ...messageData, chatId: chatId }); // Kirim format asli ke frontend

        // Notifikasi browser (hanya untuk pesan masuk baru)
        const pickedBy = pickedChats[chatId];
        // Hanya beri notifikasi jika chat tidak sedang diambil oleh siapapun
        // atau jika Anda ingin notifikasi muncul bahkan jika diambil (misal: untuk admin lain)
        // if (!pickedBy) { // Aktifkan baris ini jika hanya ingin notifikasi saat chat belum diambil
            io.emit('notification', {
              title: `Pesan Baru (${chatId.split('@')[0]})`,
              body: messageContent || `[${mediaType || 'Media'}]`,
              icon: '/favicon.ico', // Ganti jika perlu
              chatId: chatId // Sertakan chatId agar frontend bisa filter
            });
        // } // Tutup blok if jika diaktifkan
      } else {
         // console.log(`Pesan duplikat terdeteksi di upsert (ID: ${messageData.id}), diabaikan penambahannya ke history dan emit.`); // Kurangi log
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
  socket.emit('initial_pick_status', pickedChats); // pickedChats menggunakan normalized ID
  socket.emit('update_online_admins', getOnlineAdminUsernames());
  if (sock?.user) { // Kirim status koneksi WA jika sudah terhubung
      socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
  } else {
      socket.emit('whatsapp_disconnected', { reason: 'Connecting...', statusCode: 'N/A' }); // Beri status connecting jika belum siap
  }


  // Meminta data awal (history & picks) setelah login/reconnect
  socket.on('request_initial_data', () => {
    const username = adminSockets[socket.id];
    if (username) {
      console.log(`Admin ${username} meminta data awal.`);
      const decodedChatHistory = {};
      // Iterasi melalui history yang ter-encoded di memory
      for (const encodedKey in chatHistory) {
        const decodedKey = decodeFirebaseKey(encodedKey); // Decode chatId sebelum mengirim ke frontend
         // Pastikan kunci decoded valid
         if (decodedKey) {
            decodedChatHistory[decodedKey] = chatHistory[encodedKey].map((message) => ({
              ...message,
              chatId: decodedKey // Tambahkan chatId ter-decode ke setiap pesan
            }));
         }
      }
      socket.emit('initial_data', decodedChatHistory); // Kirim data histori yang sudah di-decode
      socket.emit('initial_pick_status', pickedChats); // Kirim lagi pick status (menggunakan normalized ID)
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Kirim lagi admin online
    } else {
      console.warn(`Socket ${socket.id} meminta data awal sebelum login.`);
      socket.emit('request_login'); // Minta klien untuk login
    }
  });

  // Meminta history chat spesifik
  socket.on('get_chat_history', (chatId) => {
    const username = adminSockets[socket.id];
    if (username && chatId) {
      const normalizedChatId = normalizeChatId(chatId); // Normalize input chatId
      const encodedChatId = encodeFirebaseKey(normalizedChatId); // Encode untuk pencarian di memory/Firebase

      if (!encodedChatId) {
          console.error('Gagal meng-encode chatId untuk get_chat_history:', chatId);
          return socket.emit('chat_history_error', { chatId, message: 'Chat ID tidak valid.' });
      }

      const history = chatHistory[encodedChatId]?.map((message) => ({
        ...message,
        chatId: normalizedChatId // Tambahkan chatId ter-decode ke setiap pesan untuk konsistensi frontend
      })) || [];
      socket.emit('chat_history', { chatId: normalizedChatId, messages: history }); // Kirim format asli (normalized ID) ke frontend
    } else {
        socket.emit('chat_history_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
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
      const decodedChatHistory = {};
       for (const encodedKey in chatHistory) {
         const decodedKey = decodeFirebaseKey(encodedKey);
         if (decodedKey) {
            decodedChatHistory[decodedKey] = chatHistory[encodedKey].map((message) => ({ ...message, chatId: decodedKey }));
         }
       }
      socket.emit('initial_data', decodedChatHistory);
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
        // Izinkan reconnect meskipun sudah ada koneksi lama,
        // tapi clean up koneksi lama jika masih aktif
        const existingSocketId = usernameToSocketId[username];
        if (existingSocketId && existingSocketId !== socket.id && io.sockets.sockets.get(existingSocketId)) {
             console.warn(`Admin ${username} mereconnect. Disconnecting old socket ${existingSocketId}.`);
             io.sockets.sockets.get(existingSocketId)?.disconnect(true); // Putuskan koneksi lama
        }

        console.log(`Reconnect successful for ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = username;
        usernameToSocketId[username] = socket.id;
        socket.emit('reconnect_success', { username, currentPicks: pickedChats });
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Broadcast updated online admins

         // Kirim data awal setelah reconnect berhasil
        const decodedChatHistory = {};
        for (const encodedKey in chatHistory) {
          const decodedKey = decodeFirebaseKey(encodedKey);
          if (decodedKey) {
             decodedChatHistory[decodedKey] = chatHistory[encodedKey].map((message) => ({ ...message, chatId: decodedKey }));
          }
        }
        socket.emit('initial_data', decodedChatHistory);
        socket.emit('initial_pick_status', pickedChats);
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
        // Mungkin perlu membersihkan session di sini jika menggunakan express-session
        // req.session.destroy(); // Tidak langsung tersedia di socket.io, perlu cara lain
        socket.emit('logout_success'); // Notify the client of successful logout
    } else {
         socket.emit('logout_failed', { message: 'Not logged in.' });
    }
  });

  // Mengambil chat
  socket.on('pick_chat', ({ chatId }) => {
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
    const normalizedChatId = normalizeChatId(chatId); // Normalize input
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    if (pickedChats[normalizedChatId] && pickedChats[normalizedChatId] !== username) {
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedChats[normalizedChatId]}.` });
    } else if (!pickedChats[normalizedChatId]) {
      pickedChats[normalizedChatId] = username;
      console.log(`Admin ${username} mengambil chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username }); // Emit normalized ID
      startAutoReleaseTimer(normalizedChatId, username); // Mulai timer dengan normalized ID
      // Tandai pesan terakhir sebagai terbaca oleh sistem (opsional, hanya untuk indikator)
       const encodedChatId = encodeFirebaseKey(normalizedChatId);
       if (encodedChatId && chatHistory[encodedChatId]) {
           let changed = false;
           // Tandai semua pesan masuk terakhir sebagai sudah dibaca saat di-pick
           for (let i = chatHistory[encodedChatId].length - 1; i >= 0; i--) {
                if (chatHistory[encodedChatId][i].type === 'incoming' && chatHistory[encodedChatId][i].unread) {
                    chatHistory[encodedChatId][i].unread = false;
                    changed = true;
                } else if (chatHistory[encodedChatId][i].type === 'outgoing') {
                    // Berhenti jika sudah mencapai pesan keluar terakhir
                    break;
                }
           }
           if (changed) {
               saveChatHistory();
               io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Broadcast status baca
           }
       }
    } else {
      // Admin yang sama mengklik pick lagi -> restart timer
      console.log(`Admin ${username} mengklik pick lagi untuk ${normalizedChatId}, restart timer.`);
      startAutoReleaseTimer(normalizedChatId, username);
      socket.emit('pick_info', { chatId: normalizedChatId, message: 'Timer direset.' }); // Info opsional
    }
  });

  // Melepas chat
  socket.on('unpick_chat', ({ chatId }) => {
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
     const normalizedChatId = normalizeChatId(chatId); // Normalize input
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });


    if (pickedChats[normalizedChatId] === username) {
      clearAutoReleaseTimer(normalizedChatId); // Batalkan timer
      delete pickedChats[normalizedChatId];
      console.log(`Admin ${username} melepas chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Emit normalized ID
    } else if (pickedChats[normalizedChatId]) {
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedChats[normalizedChatId]} yang bisa melepas chat ini.` });
    } else {
       socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
    }
  });

  // Mendelegasikan chat
  socket.on('delegate_chat', ({ chatId, targetAdminUsername }) => {
      const senderAdminUsername = adminSockets[socket.id];
      const normalizedChatId = normalizeChatId(chatId); // Normalize input

      // Validasi
      if (!senderAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Login diperlukan.' });
      if (!normalizedChatId || !targetAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Data tidak lengkap.' });
      if (pickedChats[normalizedChatId] !== senderAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Anda tidak memegang chat ini.' });
      if (senderAdminUsername === targetAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      // Cek apakah target admin valid (ada di daftar admin)
      if (!admins[targetAdminUsername]) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Admin target tidak ditemukan.' });


      // Proses Delegasi
      console.log(`Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId); // Batalkan timer lama
      pickedChats[normalizedChatId] = targetAdminUsername; // Update pemilik chat
      startAutoReleaseTimer(normalizedChatId, targetAdminUsername); // Mulai timer baru untuk target

      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername }); // Broadcast perubahan

      // Notifikasi ke target jika online
      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId) {
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0]} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
          });
      }

      // Konfirmasi ke pengirim
      socket.emit('delegate_success', { chatId: normalizedChatId, targetAdminUsername });
  });


  // Mengirim balasan
  socket.on('reply_message', async ({ to, text, media }) => {
    const chatId = normalizeChatId(to); // Normalisasi chatId
    const username = adminSockets[socket.id];
    if (!username) return socket.emit('send_error', { to: chatId, text, message: 'Login diperlukan.' });
    if (!chatId || (!text && !media)) return socket.emit('send_error', { to: chatId, text, message: 'Data tidak lengkap.' });
    if (!sock) return socket.emit('send_error', { to: chatId, text, message: 'Koneksi WhatsApp belum siap.' });

    // Cek status pick chat
    if (!pickedChats[chatId]) {
      return socket.emit('send_error', { to: chatId, text, message: 'Ambil chat ini terlebih dahulu.' });
    }
    if (pickedChats[chatId] !== username) {
      return socket.emit('send_error', { to: chatId, text, message: `Sedang ditangani oleh ${pickedChats[chatId]}.` });
    }

    try {
      const adminInfo = admins[username];
      const adminInitials = adminInfo?.initials || username.substring(0, 2).toUpperCase();
      // Tambahkan inisial ke teks atau caption
      const textWithInitials = text ? `${text.trim()}

_${adminInitials}_` : `_${adminInitials}_`; // Tambahkan inisial bahkan jika hanya media tanpa teks utama

      let sentMsgResult; // Variabel untuk menampung hasil sock.sendMessage

      if (media) {
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const mediaOptions = {
          mimetype: media.type,
          fileName: media.name || 'file', // Beri nama default jika kosong
          caption: (text || media.type.startsWith('audio/')) ? textWithInitials : undefined // Caption hanya untuk image/video/document, atau jika ada teks utama untuk audio?
           // Untuk audio/voice note, caption seringkali diabaikan. Inisial mungkin perlu dikirim terpisah.
           // Mari coba kirim caption untuk image/video/document, untuk audio kita handle terpisah.
        };

        if (media.type.startsWith('image/')) {
          sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, caption: textWithInitials, ...mediaOptions });
        } else if (media.type.startsWith('video/')) {
          sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, caption: textWithInitials, ...mediaOptions });
        } else if (media.type.startsWith('audio/')) {
           // Untuk audio, kirim file audio dulu
           sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: media.type, ptt: true }); // ptt: true for voice note
           // Lalu kirim inisial/teks terpisah jika ada teks utama atau hanya inisial
           if (textWithInitials && textWithInitials.trim().length > 0) {
               // Kirim inisial/teks sebagai pesan terpisah
               // Ini akan menghasilkan 2 bubble chat (1 audio, 1 teks)
              await sock.sendMessage(chatId, { text: textWithInitials });
           }
        } else if (media.type === 'application/pdf' || media.type.startsWith('document/')) {
          sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, caption: textWithInitials, ...mediaOptions });
        } else {
          console.warn(`Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to: chatId, text, media, message: 'Tipe media tidak didukung.' });
          return;
        }

        // Note: Jika audio dan teks dikirim terpisah, hanya pesan media (audio) yang ID-nya
        // akan dicatat dalam outgoingMessageData pertama. Pesan teks inisial yang terpisah
        // tidak akan tercatat di sini secara otomatis. Ini mungkin perlu penyesuaian di frontend
        // atau struktur history jika Anda ingin kedua bubble tercatat.
        // Untuk saat ini, kita hanya merekam event pengiriman media awal.

      } else {
        // Hanya pesan teks
        if (textWithInitials.trim().length > 0) {
           sentMsgResult = await sock.sendMessage(chatId, { text: textWithInitials });
        } else {
            // Tidak ada teks atau media
            socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten untuk dikirim.' });
            return;
        }
      }

      // Pastikan sock.sendMessage berhasil mengembalikan setidaknya satu pesan di array
      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.');
          socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          return;
      }

      // Buat objek data pesan keluar untuk history dan frontend
      // Gunakan teks ASLI (tanpa inisial) untuk history, inisial disimpan terpisah
      const outgoingMessageData = {
        id: sentMsg.key.id, // ID pesan dari Baileys
        from: username, // Admin pengirim (username)
        to: chatId,    // Chat tujuan (normalized ID)
        text: text?.trim() || null, // Teks asli (tanpa inisial)
        mediaType: media?.type || null,
        mediaData: media?.data || null, // Simpan data base64 (hati-hati ukuran history)
        fileName: media?.name || null,
        initials: adminInitials, // Simpan inisial terpisah
        timestamp: sentMsg.messageTimestamp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        type: 'outgoing' // Tandai sebagai pesan keluar
      };

      // Simpan pesan keluar ke chatHistory (di memory, lalu akan disimpan ke Firebase)
      const encodedChatId = encodeFirebaseKey(chatId);
      if (!encodedChatId) {
           console.error('Gagal meng-encode chatId untuk menyimpan pesan keluar:', chatId);
           return socket.emit('send_error', { to: chatId, text, media, message: 'Kesalahan internal saat menyimpan history.' });
      }

      if (!chatHistory[encodedChatId]) {
        chatHistory[encodedChatId] = [];
      }

      // Hindari duplikasi sebelum menyimpan (penting untuk konsistensi)
      if (!chatHistory[encodedChatId].some(m => m.id === outgoingMessageData.id)) {
        chatHistory[encodedChatId].push(outgoingMessageData);
        saveChatHistory(); // Simpan ke Firebase
      } else {
          console.warn(`Pesan keluar dengan ID ${outgoingMessageData.id} sudah ada di history.`);
      }

      // --- Kirim pesan keluar ke SEMUA admin yang terhubung ---
      // Frontend akan menerima ini dan menampilkan pesan di UI.
      // Frontend pengirim harus memperbarui tampilan pesan pendingnya atau menambahkan pesan jika belum ada.
      io.emit('new_message', { ...outgoingMessageData, chatId: chatId }); // Kirim normalized ID

      // Konfirmasi ke pengirim (opsional, bisa digunakan frontend untuk indikator sukses)
      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.to
      });

      // Restart timer auto-release setelah mengirim pesan
      startAutoReleaseTimer(chatId, username);


    } catch (error) {
      console.error(`Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  // Menandai chat sebagai sudah dibaca
  socket.on('mark_as_read', ({ chatId }) => {
     const username = adminSockets[socket.id];
     if (!username || !chatId) return; // Abaikan jika tidak login atau chatId kosong

     const normalizedChatId = normalizeChatId(chatId);
     const encodedChatId = encodeFirebaseKey(normalizedChatId);

     if (!encodedChatId) {
         console.error('Gagal meng-encode chatId untuk mark_as_read:', chatId);
         return;
     }

     // Hanya proses jika chat belum diambil ATAU diambil oleh admin yang mengirim event
     const pickedBy = pickedChats[normalizedChatId]; // Cek status pick dengan normalized ID
     if (!pickedBy || pickedBy === username) {
          // console.log(`Chat ${normalizedChatId} ditandai terbaca oleh ${username}.`); // Kurangi log
         if (chatHistory[encodedChatId]) { // Cari di history dengan encoded ID
              let changed = false;
              // Tandai semua pesan masuk terakhir sebagai sudah dibaca
              // Iterasi dari akhir history chat tersebut
              for (let i = chatHistory[encodedChatId].length - 1; i >= 0; i--) {
                   // Pastikan pesan tersebut milik user (incoming) dan belum dibaca
                   if (chatHistory[encodedChatId][i].type === 'incoming' && chatHistory[encodedChatId][i].unread) {
                       chatHistory[encodedChatId][i].unread = false;
                       changed = true;
                   } else if (chatHistory[encodedChatId][i].type === 'outgoing') {
                       // Jika sudah menemukan pesan keluar, berhenti. Asumsi pesan sebelum itu (ke atas)
                       // sudah dibaca oleh admin yang berinteraksi sebelumnya.
                       // Ini logika penyederhanaan "tandai terakhir terbaca".
                       break;
                   }
              }
              if (changed) {
                  saveChatHistory(); // Simpan jika ada perubahan status baca
                  io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Broadcast status baca dengan normalized ID
                  // Opsional: Beri tahu WhatsApp bahwa pesan telah dibaca (memerlukan info pesan spesifik)
                  // sock.sendReadReceipt(message.key.remoteJid, message.key.participant, [message.key.id]);
                  // Ini lebih rumit, biasanya dilakukan saat menerima pesan baru, bukan saat mengklik 'mark as read'
                  // karena perlu ID pesan terakhir. Untuk kesederhanaan, biarkan Baileys/WA sendiri yang menandai terbaca
                  // saat admin membuka chat di frontend dan pesan-pesan di-load/dilihat.
              }
         }
     } else {
          // console.log(`Event mark_as_read untuk ${normalizedChatId} dari ${username} diabaikan (diambil ${pickedBy}).`); // Kurangi log
     }
   });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    const username = adminSockets[socket.id]; // Ambil username SEBELUM dihapus
    const cleanedUsername = cleanupAdminState(socket.id); // Hapus dari state dan bersihkan picks
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
    // await sock.logout(); // Jika ingin logout sesi
    sock.end(new Error('Server Shutdown')); // Menutup koneksi tanpa logout sesi
  }
  saveChatHistory(); // Pastikan history tersimpan ke Firebase sebelum aplikasi dimatikan
  console.log('Server dimatikan.');
  process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Menerima SIGTERM. Membersihkan...');
    if (sock) {
       console.log('Menutup koneksi WhatsApp...');
       sock.end(new Error('Server Shutdown'));
    }
     saveChatHistory();
    console.log('Server dimatikan.');
    process.exit(0);
});

// Tangani error tak tertangkap
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  // Jangan langsung exit, biarkan process manager menanganinya
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Jangan langsung exit, biarkan process manager menanganinya
});