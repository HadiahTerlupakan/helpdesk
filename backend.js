// backend.js atau server.js

import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } from 'baileys';
import express from 'express';
const expressApp = express();
import http from 'http';
const server = http.createServer(expressApp);
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
import qrcode from 'qrcode-terminal';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import config from './config.js'; // Pastikan file ini ada dan sudah diperbarui
import { fileURLToPath } from 'url';

// Firebase Imports
import { getDatabase, ref, child, get, set, remove } from 'firebase/database';
import { app as firebaseApp, database } from './firebaseConfig.js'; // Pastikan file ini ada

// --- Konfigurasi & State ---
let admins = {}; // { username: { password, initials, role } } - Akan dimuat dari Firebase
const adminSockets = {}; // socket ID -> { username: '...', role: '...' } // Sekarang menyimpan role
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId (normalized) -> username
const chatReleaseTimers = {}; // chatId (normalized) -> setTimeout ID
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Struktur chatHistory: { encodedChatId: { status: 'open'|'closed', messages: [...] } }
let chatHistory = {};
const superAdminUsername = config.superAdminUsername; // Ambil superadmin username dari config

let sock; // Variabel global untuk instance socket Baileys
let qrDisplayed = false; // <--- PERBAIKAN: Deklarasi di scope yang lebih luas

// --- Fungsi Helper ---

const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' });

// Memuat Data dari Firebase (History & Admins)
async function loadDataFromFirebase() {
    console.log("Memuat data dari Firebase...");
    const dbRef = ref(database); // Root reference

    try {
        // Muat Chat History
        const historySnapshot = await get(child(dbRef, 'chatHistory'));
        if (historySnapshot.exists()) {
            chatHistory = historySnapshot.val();
            console.log('Riwayat chat berhasil dimuat dari Firebase.');
             // Pastikan struktur history sesuai harapan jika dimuat
            for (const encodedChatId in chatHistory) {
                 if (chatHistory[encodedChatId] && !chatHistory[encodedChatId].messages) {
                     // Jika data lama tanpa array messages, konversi (opsional)
                     console.warn(`Mengkonversi struktur chat history lama untuk ${decodeFirebaseKey(encodedChatId)}`);
                     chatHistory[encodedChatId] = { status: 'open', messages: chatHistory[encodedChatId] }; // Asumsi data lama adalah array messages
                 }
                 if (!chatHistory[encodedChatId]?.status) {
                      chatHistory[encodedChatId].status = 'open'; // Set status default jika tidak ada
                 }
            }
        } else {
            console.log('Tidak ada riwayat chat di Firebase.');
            chatHistory = {};
        }

        // Muat Admins
        const adminsSnapshot = await get(child(dbRef, 'admins'));
        if (adminsSnapshot.exists()) {
            admins = adminsSnapshot.val();
            console.log('Data admin berhasil dimuat dari Firebase.');
             // Validasi dasar untuk superadmin
             if (!admins[superAdminUsername] || admins[superAdminUsername].role !== 'superadmin') {
                 console.warn(`PERINGATAN: Super Admin '${superAdminUsername}' tidak ditemukan atau tidak memiliki role 'superadmin' di Firebase. Beberapa fungsi mungkin tidak tersedia.`);
             }
        } else {
            console.warn('Tidak ada data admin di Firebase. Menggunakan data dari config.js sebagai default.');
            // Jika tidak ada admin di Firebase, gunakan yang dari config sebagai default
             admins = config.admins;
             console.log('Menggunakan admin dari config.js.');
             // Opsional: Simpan admin dari config ke Firebase untuk pertama kali
             saveAdminsToFirebase(); // Panggil ini sekali saat tidak ada admin di DB
        }

    } catch (error) {
        console.error('Gagal memuat data dari Firebase:', error);
        // Handle error - mungkin perlu keluar atau mencoba lagi
         throw error; // Lempar error agar proses start terhenti jika gagal muat data kritis
    }
}

// Menyimpan Chat History ke Firebase
function saveChatHistoryToFirebase() {
    const dbRef = ref(database, 'chatHistory');
    set(dbRef, chatHistory)
        .then(() => {
            // console.log('Riwayat chat berhasil disimpan ke Firebase.');
        })
        .catch((error) => {
            console.error('Gagal menyimpan riwayat chat ke Firebase:', error);
        });
}

// Menyimpan Data Admin ke Firebase
function saveAdminsToFirebase() {
    const dbRef = ref(database, 'admins');
    set(dbRef, admins)
        .then(() => {
            console.log('Data admin berhasil disimpan ke Firebase.');
            // Broadcast updated admin list to all clients
            io.emit('registered_admins', admins);
        })
        .catch((error) => {
            console.error('Gagal menyimpan data admin ke Firebase:', error);
        });
}

// Menghapus Chat History dari Firebase
async function deleteChatHistoryFromFirebase(encodedChatId) {
    const dbRef = ref(database, `chatHistory/${encodedChatId}`);
    try {
        await remove(dbRef);
        console.log(`Chat history untuk ${decodeFirebaseKey(encodedChatId)} berhasil dihapus dari Firebase.`);
        return true;
    } catch (error) {
        console.error(`Gagal menghapus chat history untuk ${decodeFirebaseKey(encodedChatId)} dari Firebase:`, error);
        return false;
    }
}

// Menghapus Semua Chat History dari Firebase
async function deleteAllChatHistoryFromFirebase() {
    const dbRef = ref(database, 'chatHistory');
    try {
        await remove(dbRef);
        console.log('Semua chat history berhasil dihapus dari Firebase.');
        return true;
    } catch (error) {
        console.error('Gagal menghapus semua chat history dari Firebase:', error);
        return false;
    }
}


// Membatalkan timer auto-release
function clearAutoReleaseTimer(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  if (chatReleaseTimers[normalizedChatId]) {
    clearTimeout(chatReleaseTimers[normalizedChatId]);
    delete chatReleaseTimers[normalizedChatId];
    // console.log(`Timer auto-release untuk chat ${normalizedChatId} dibatalkan.`);
  }
}

// Memulai timer auto-release
function startAutoReleaseTimer(chatId, username) {
  const normalizedChatId = normalizeChatId(chatId);
  clearAutoReleaseTimer(normalizedChatId);

  const timeoutMinutes = config.chatAutoReleaseTimeoutMinutes;
  if (timeoutMinutes && timeoutMinutes > 0) {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    console.log(`Memulai timer auto-release ${timeoutMinutes} menit untuk chat ${normalizedChatId} oleh ${username}.`);

    chatReleaseTimers[normalizedChatId] = setTimeout(() => {
      if (pickedChats[normalizedChatId] === username) {
        console.log(`Timer auto-release habis untuk chat ${normalizedChatId} (diambil ${username}). Melepas chat.`);
        delete pickedChats[normalizedChatId];
        delete chatReleaseTimers[normalizedChatId];
        io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId) {
          io.to(targetSocketId).emit('auto_release_notification', { chatId: normalizedChatId, message: `Chat ${normalizedChatId.split('@')[0]} dilepas otomatis (tidak aktif).` });
        }
      } else {
        delete chatReleaseTimers[normalizedChatId];
      }
    }, timeoutMs);
  }
}

// Mendapatkan daftar username admin yang sedang online
function getOnlineAdminUsernames() {
    return Object.values(adminSockets).map(adminInfo => adminInfo.username);
}

// Mendapatkan info admin (termasuk role) berdasarkan Socket ID
function getAdminInfoBySocketId(socketId) {
    return adminSockets[socketId] || null;
}

// Membersihkan state admin saat disconnect/logout
function cleanupAdminState(socketId) {
    const adminInfo = adminSockets[socketId];
    if (adminInfo) {
        const username = adminInfo.username;
        console.log(`Membersihkan state untuk admin ${username} (Socket ID: ${socketId})`);
        for (const chatId in pickedChats) {
            if (pickedChats[chatId] === username) {
                clearAutoReleaseTimer(chatId);
                delete pickedChats[chatId];
                io.emit('update_pick_status', { chatId: chatId, pickedBy: null });
                console.log(`Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            }
        }
        delete adminSockets[socketId];
        delete usernameToSocketId[username];
        io.emit('update_online_admins', getOnlineAdminUsernames());
        return username;
    }
    return null;
}

// Fungsi untuk memastikan chatId dalam format lengkap
function normalizeChatId(chatId) {
  if (!chatId) return null;
  if (chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@g.us')) {
    return chatId;
  }
  return `${chatId}@s.whatsapp.net`;
}

// Fungsi untuk decode kunci jika diperlukan
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

// Fungsi untuk mengecek apakah admin adalah Super Admin
function isSuperAdmin(username) {
    // Ambil role dari data 'admins' yang dimuat dari Firebase
    return username && admins[username]?.role === 'superadmin';
}


// --- Setup Express & Server ---

// Muat data awal saat server mulai
loadDataFromFirebase().then(() => {
    console.log("Data Firebase siap. Memulai koneksi WhatsApp dan Server HTTP.");
     connectToWhatsApp().catch(err => {
      console.error("Gagal memulai koneksi WhatsApp awal:", err);
      // Mungkin perlu keluar atau mencoba lagi dengan strategi berbeda
    });

    server.listen(PORT, () => {
      console.log(`Server Helpdesk berjalan di http://localhost:${PORT}`);
      console.log(`Versi Aplikasi: ${config.version || 'N/A'}`);
    });

}).catch(err => {
    console.error("Gagal memuat data awal dari Firebase. Server tidak dapat dimulai.", err);
    process.exit(1);
});


expressApp.use(express.static(__dirname));
expressApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

expressApp.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: config.cookieSecure || false }
}));

const PORT = config.serverPort || 3000;


// --- Koneksi WhatsApp (Baileys) ---

async function connectToWhatsApp() {
  console.log("Mencoba menghubungkan ke WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.baileysOptions?.printQRInTerminal ?? true,
    browser: Browsers.macOS('Desktop'),
    logger: logger,
    getMessage: async (key) => {
        const encodedChatId = encodeFirebaseKey(key.remoteJid);
        const msg = chatHistory[encodedChatId]?.messages?.find(m => m.id === key.id);
        console.warn(`Baileys meminta pesan ${key.id} dari ${key.remoteJid}. Ditemukan: ${!!msg}`);
        // Returning undefined means Baileys won't be able to retrieve this message
        // for operations like quoting/replying. This might break some features.
        // A proper solution would involve saving the raw Baileys message object.
        return undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isOnline, isConnecting } = update;

    if (qr && !qrDisplayed) { // qrDisplayed diakses di sini
      qrDisplayed = true; // qrDisplayed diakses di sini
      console.log('QR Code diterima, pindai dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
      io.emit('whatsapp_qr', qr);
    }

    if (connection === 'close') {
      qrDisplayed = false; // qrDisplayed diakses di sini
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = ![401, 403, 411, 419, 500].includes(statusCode);
      console.error(`Koneksi WhatsApp terputus: ${lastDisconnect?.error?.message || 'Alasan tidak diketahui'} (Code: ${statusCode || 'N/A'}), Mencoba menyambung kembali: ${shouldReconnect}`);
      io.emit('whatsapp_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode });
      if (shouldReconnect) {
        console.log("Mencoba menyambung kembali dalam 15 detik...");
        setTimeout(connectToWhatsApp, 15000);
      } else {
        console.error("Tidak dapat menyambung kembali secara otomatis. Periksa folder auth_info_baileys, hapus jika sesi invalid, atau scan ulang QR.");
        io.emit('whatsapp_fatal_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode, message: 'Fatal disconnection, manual intervention needed.' });
      }
    } else if (connection === 'open') {
      console.log('Berhasil terhubung ke WhatsApp!');
      qrDisplayed = false; // qrDisplayed diakses di sini
      io.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
    } else {
        console.log(`Status koneksi WhatsApp: ${connection} ${isConnecting ? '(connecting)' : ''} ${isOnline ? '(online)' : ''}`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
      if (message.key.fromMe) {
        continue;
      }

      const chatId = normalizeChatId(message.key.remoteJid);

       if (chatId === 'status@broadcast' || (sock?.user?.id && chatId === sock.user.id)) {
           continue;
       }

      let messageContent = null;
      let mediaData = null;
      let mediaType = null;
      let fileName = null;

      const messageType = message.message ? Object.keys(message.message)[0] : null;
      const isMedia = messageType ? ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType) : false;

      if (isMedia && message.message[messageType]) {
        try {
          const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
          mediaData = buffer.toString('base64');
          mediaType = messageType;
          const mediaProps = message.message[messageType];
          fileName = mediaProps.fileName || mediaProps.caption || `${messageType}`;
          messageContent = mediaProps.caption || `[${messageType.replace('Message', '')}]`;
        } catch (error) {
          console.error(`Gagal mengunduh media dari ${chatId}:`, error);
          messageContent = `[Gagal memuat media ${messageType.replace('Message', '')}]`;
        }
      } else if (messageType === 'conversation') {
        messageContent = message.message.conversation;
      } else if (messageType === 'extendedTextMessage' && message.message.extendedTextMessage.text) {
        messageContent = message.message.extendedTextMessage.text;
      } else if (messageType === 'imageMessage' && message.message.imageMessage.caption) {
         messageContent = message.message.imageMessage.caption;
      }
      else {
         messageContent = `[Pesan tidak dikenal atau kosong: ${messageType || 'N/A'}]`;
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
        type: 'incoming'
      };

      const encodedChatId = encodeFirebaseKey(chatId);
      if (!encodedChatId) {
          console.error('Gagal meng-encode chatId:', chatId, 'mengabaikan pesan masuk.');
          continue;
      }

      // Initialize chat entry if it doesn't exist, include status
      if (!chatHistory[encodedChatId]) {
        chatHistory[encodedChatId] = { status: 'open', messages: [] }; // Default status 'open'
         console.log(`Membuat entri baru untuk chat ${chatId} dengan status 'open'.`);
      } else if (!chatHistory[encodedChatId].messages) {
           // Handle old structure without messages array
           console.warn(`Mengkonversi struktur chat history lama untuk ${chatId}. Menambahkan array 'messages'.`);
           chatHistory[encodedChatId] = { status: chatHistory[encodedChatId].status || 'open', messages: chatHistory[encodedChatId] }; // Asumsi data lama adalah array messages
      }
       // Ensure status exists even if chat existed but had no status
       if (!chatHistory[encodedChatId].status) {
            chatHistory[encodedChatId].status = 'open';
       }


      // Add message to the messages array, deduplicate
      if (!chatHistory[encodedChatId].messages.some(m => m.id === messageData.id)) {
        console.log(`Menambahkan pesan masuk baru (ID: ${messageData.id}) ke chat ${chatId}`);
        chatHistory[encodedChatId].messages.push(messageData);
        saveChatHistoryToFirebase();

        io.emit('new_message', { ...messageData, chatId: chatId, chatStatus: chatHistory[encodedChatId].status }); // Include status

        const pickedBy = pickedChats[chatId];
        io.emit('notification', {
          title: `Pesan Baru (${chatId.split('@')[0]})`,
          body: messageContent || `[${mediaType || 'Media'}]`,
          icon: '/favicon.ico',
          chatId: chatId
        });
      } else {
         // console.log(`Pesan duplikat terdeteksi di upsert (ID: ${messageData.id}), diabaikan.`);
      }
    }
  });
}


// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`Admin terhubung: ${socket.id}`);

  socket.emit('registered_admins', admins);
  socket.emit('update_online_admins', getOnlineAdminUsernames());

  socket.emit('initial_pick_status', pickedChats);
  socket.emit('update_online_admins', getOnlineAdminUsernames());
  if (sock?.user) {
      socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
  } else {
      socket.emit('whatsapp_disconnected', { reason: 'Connecting...', statusCode: 'N/A' });
  }


  socket.on('request_initial_data', () => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (adminInfo) {
      console.log(`Admin ${adminInfo.username} meminta data awal.`);
      const decodedChatHistory = {};
      for (const encodedKey in chatHistory) {
        const decodedKey = decodeFirebaseKey(encodedKey);
         if (decodedKey && chatHistory[encodedKey]?.messages) { // Pastikan messages array ada
            decodedChatHistory[decodedKey] = {
                status: chatHistory[encodedKey].status || 'open', // Default status
                messages: chatHistory[encodedKey].messages.map((message) => ({
                    ...message,
                    chatId: decodedKey
                }))
            };
         } else if (decodedKey) {
              // Handle case where chat entry exists but has no messages (e.g., after conversion)
               decodedChatHistory[decodedKey] = {
                   status: chatHistory[encodedKey]?.status || 'open',
                   messages: []
               };
         }
      }
      socket.emit('initial_data', { chatHistory: decodedChatHistory, admins: admins, currentUserRole: adminInfo.role });
      socket.emit('initial_pick_status', pickedChats);
      io.emit('update_online_admins', getOnlineAdminUsernames());
    } else {
      console.warn(`Socket ${socket.id} meminta data awal sebelum login.`);
      socket.emit('request_login');
    }
  });

  socket.on('get_chat_history', (chatId) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (adminInfo && chatId) {
      const normalizedChatId = normalizeChatId(chatId);
      const encodedChatId = encodeFirebaseKey(normalizedChatId);

      if (!encodedChatId) {
          console.error('Gagal meng-encode chatId untuk get_chat_history:', chatId);
          return socket.emit('chat_history_error', { chatId, message: 'Chat ID tidak valid.' });
      }

      const chatEntry = chatHistory[encodedChatId];
      const history = chatEntry?.messages?.map((message) => ({ // Check messages array exists
        ...message,
        chatId: normalizedChatId
      })) || [];
      const status = chatEntry?.status || 'open';

      socket.emit('chat_history', { chatId: normalizedChatId, messages: history, status: status });
    } else {
        socket.emit('chat_history_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
    }
  });

  socket.on('admin_login', ({ username, password }) => {
    const adminUser = admins[username];
    if (adminUser && adminUser.password === password) { // Basic password check
      if (usernameToSocketId[username]) {
         console.warn(`Login gagal: Admin ${username} sudah login dari socket ${usernameToSocketId[username]}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain.' });
         return;
      }
      console.log(`Login berhasil: ${username} (Socket ID: ${socket.id})`);
      adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
      usernameToSocketId[username] = socket.id;

      socket.emit('login_success', { username: username, initials: adminUser.initials, role: adminUser.role || 'admin' });
      socket.emit('initial_pick_status', pickedChats);
      io.emit('update_online_admins', getOnlineAdminUsernames());
    } else {
      console.log(`Login gagal untuk username: ${username}.`);
      socket.emit('login_failed', { message: 'Username atau password salah.' });
    }
  });

  socket.on('admin_reconnect', ({ username }) => {
    const adminUser = admins[username];
    if (adminUser) {
        const existingSocketId = usernameToSocketId[username];
        if (existingSocketId && existingSocketId !== socket.id && io.sockets.sockets.get(existingSocketId)) {
             console.warn(`Admin ${username} mereconnect. Disconnecting old socket ${existingSocketId}.`);
             io.sockets.sockets.get(existingSocketId)?.disconnect(true);
        }

        console.log(`Reconnect successful for ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
        usernameToSocketId[username] = socket.id;
        socket.emit('reconnect_success', { username: username, currentPicks: pickedChats, role: adminUser.role || 'admin' });
        io.emit('update_online_admins', getOnlineAdminUsernames());
        socket.emit('initial_pick_status', pickedChats);
    } else {
        console.warn(`Reconnect failed: Admin ${username} not found.`);
        socket.emit('reconnect_failed');
    }
  });


  socket.on('admin_logout', () => {
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`Admin ${username} logout.`);
        socket.emit('logout_success');
    } else {
         socket.emit('logout_failed', { message: 'Not logged in.' });
    }
  });

  socket.on('pick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
    const username = adminInfo.username;
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

     const encodedChatId = encodeFirebaseKey(normalizedChatId);
     // Cek status chat, jangan biarkan diambil jika sudah closed
     if (chatHistory[encodedChatId]?.status === 'closed') {
         return socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
     }


    if (pickedChats[normalizedChatId] && pickedChats[normalizedChatId] !== username) {
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedChats[normalizedChatId]}.` });
    } else if (!pickedChats[normalizedChatId]) {
      pickedChats[normalizedChatId] = username;
      console.log(`Admin ${username} mengambil chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username });
      startAutoReleaseTimer(normalizedChatId, username);
       const encodedChatId = encodeFirebaseKey(normalizedChatId);
       if (encodedChatId && chatHistory[encodedChatId]?.messages) {
           let changed = false;
           for (let i = chatHistory[encodedChatId].messages.length - 1; i >= 0; i--) {
                if (chatHistory[encodedChatId].messages[i].type === 'incoming' && chatHistory[encodedChatId].messages[i].unread) {
                    chatHistory[encodedChatId].messages[i].unread = false;
                    changed = true;
                } else if (chatHistory[encodedChatId].messages[i].type === 'outgoing') {
                    break;
                }
           }
           if (changed) {
               saveChatHistoryToFirebase();
               io.emit('update_chat_read_status', { chatId: normalizedChatId });
           }
       }
    } else {
      console.log(`Admin ${username} mengklik pick lagi untuk ${normalizedChatId}, restart timer.`);
      startAutoReleaseTimer(normalizedChatId, username);
      socket.emit('pick_info', { chatId: normalizedChatId, message: 'Timer direset.' });
    }
  });

  socket.on('unpick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
     const username = adminInfo.username;
     const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });


    if (pickedChats[normalizedChatId] === username) {
      clearAutoReleaseTimer(normalizedChatId);
      delete pickedChats[normalizedChatId];
      console.log(`Admin ${username} melepas chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
    } else if (pickedChats[normalizedChatId]) {
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedChats[normalizedChatId]} yang bisa melepas chat ini.` });
    } else {
       socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
    }
  });

  socket.on('delegate_chat', ({ chatId, targetAdminUsername }) => {
      const adminInfo = getAdminInfoBySocketId(socket.id);
      if (!adminInfo) return socket.emit('delegate_error', { chatId, message: 'Login diperlukan.' });
      const senderAdminUsername = adminInfo.username;

      const normalizedChatId = normalizeChatId(chatId);

      if (!normalizedChatId || !targetAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Data tidak lengkap.' });
      if (pickedChats[normalizedChatId] !== senderAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Anda tidak memegang chat ini.' });
      if (senderAdminUsername === targetAdminUsername) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      // Cek apakah target admin valid (ada di daftar admin)
      if (!admins[targetAdminUsername]) return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Admin target tidak ditemukan.' });

       // Cek status chat, jangan biarkan didelegasikan jika sudah closed
      const encodedChatId = encodeFirebaseKey(normalizedChatId);
      if (chatHistory[encodedChatId]?.status === 'closed') {
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
      }


      console.log(`Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId);
      pickedChats[normalizedChatId] = targetAdminUsername;
      startAutoReleaseTimer(normalizedChatId, targetAdminUsername);

      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername });

      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId) {
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0]} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
          });
      }

      socket.emit('delegate_success', { chatId: normalizedChatId, targetAdminUsername });
  });


  socket.on('reply_message', async ({ to, text, media }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('send_error', { to: to, text, message: 'Login diperlukan.' });
    const username = adminInfo.username;

    const chatId = normalizeChatId(to);
    if (!chatId || (!text && !media)) return socket.emit('send_error', { to: chatId, text, message: 'Data tidak lengkap.' });
    if (!sock) return socket.emit('send_error', { to: chatId, text, message: 'Koneksi WhatsApp belum siap.' });

    if (!pickedChats[chatId]) {
      return socket.emit('send_error', { to: chatId, text, message: 'Ambil chat ini terlebih dahulu.' });
    }
    if (pickedChats[chatId] !== username) {
      return socket.emit('send_error', { to: chatId, text, message: `Sedang ditangani oleh ${pickedChats[chatId]}.` });
    }

     const encodedChatId = encodeFirebaseKey(chatId);
     if (chatHistory[encodedChatId]?.status === 'closed') {
        return socket.emit('send_error', { to: chatId, text, message: 'Chat sudah ditutup. Tidak bisa mengirim balasan.' });
    }


    try {
      const adminInfoFromAdmins = admins[username];
      const adminInitials = adminInfoFromAdmins?.initials || username.substring(0, 2).toUpperCase();
      const textWithInitials = text ? `${text.trim()}

_${adminInitials}_` : `_${adminInitials}_`;

      let sentMsgResult;

      if (media) {
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const mediaOptions = {
          mimetype: media.type,
          fileName: media.name || 'file',
          caption: (text || media.type.startsWith('audio/')) ? textWithInitials : undefined
        };

        if (media.type.startsWith('image/')) {
          sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, caption: textWithInitials, ...mediaOptions });
        } else if (media.type.startsWith('video/')) {
          sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, caption: textWithInitials, ...mediaOptions });
        } else if (media.type.startsWith('audio/')) {
           sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: media.type, ptt: true });

           if (textWithInitials && textWithInitials.trim().length > 0) {
              await sock.sendMessage(chatId, { text: textWithInitials });
           }
        } else if (media.type === 'application/pdf' || media.type.startsWith('document/')) {
          sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, caption: textWithInitials, ...mediaOptions });
        } else {
          console.warn(`Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to: chatId, text, media, message: 'Tipe media tidak didukung.' });
          return;
        }

      } else {
        if (textWithInitials.trim().length > 0) {
           sentMsgResult = await sock.sendMessage(chatId, { text: textWithInitials });
        } else {
            socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten untuk dikirim.' });
            return;
        }
      }

      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.');
          socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          return;
      }

      const outgoingMessageData = {
        id: sentMsg.key.id,
        from: username,
        to: chatId,
        text: text?.trim() || null,
        mediaType: media?.type || null,
        mediaData: media?.data || null,
        fileName: media?.name || null,
        initials: adminInfoFromAdmins?.initials || username.substring(0, 2).toUpperCase(), // Use initials from loaded admins
        timestamp: sentMsg.messageTimestamp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        type: 'outgoing'
      };

      const encodedChatId = encodeFirebaseKey(chatId);
      if (!encodedChatId) {
           console.error('Gagal meng-encode chatId untuk menyimpan pesan keluar:', chatId);
           return socket.emit('send_error', { to: chatId, text, media, message: 'Kesalahan internal saat menyimpan history.' });
      }

      // Ensure chat entry and messages array exist before pushing
      if (!chatHistory[encodedChatId]) {
           chatHistory[encodedChatId] = { status: 'open', messages: [] };
      }
      if (!chatHistory[encodedChatId].messages) {
           chatHistory[encodedChatId].messages = [];
      }

      if (!chatHistory[encodedChatId].messages.some(m => m.id === outgoingMessageData.id)) {
        chatHistory[encodedChatId].messages.push(outgoingMessageData);
        saveChatHistoryToFirebase();
      } else {
          console.warn(`Pesan keluar dengan ID ${outgoingMessageData.id} sudah ada di history.`);
      }

      io.emit('new_message', { ...outgoingMessageData, chatId: chatId, chatStatus: chatHistory[encodedChatId].status });

      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.to
      });

      startAutoReleaseTimer(chatId, username);


    } catch (error) {
      console.error(`Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  socket.on('mark_as_read', ({ chatId }) => {
     const adminInfo = getAdminInfoBySocketId(socket.id);
     if (!adminInfo || !chatId) return;

     const normalizedChatId = normalizeChatId(chatId);
     const encodedChatId = encodeFirebaseKey(normalizedChatId);

     if (!encodedChatId) {
         console.error('Gagal meng-encode chatId untuk mark_as_read:', chatId);
         return;
     }

     const pickedBy = pickedChats[normalizedChatId];
     if (!pickedBy || pickedBy === adminInfo.username) {
         if (chatHistory[encodedChatId]?.messages) {
              let changed = false;
              for (let i = chatHistory[encodedChatId].messages.length - 1; i >= 0; i--) {
                   if (chatHistory[encodedChatId].messages[i].type === 'incoming' && chatHistory[encodedChatId].messages[i].unread) {
                       chatHistory[encodedChatId].messages[i].unread = false;
                       changed = true;
                   } else if (chatHistory[encodedChatId].messages[i].type === 'outgoing') {
                       break;
                   }
              }
              if (changed) {
                  saveChatHistoryToFirebase();
                  io.emit('update_chat_read_status', { chatId: normalizedChatId });
              }
         }
     } else {
          // console.log(`Event mark_as_read untuk ${normalizedChatId} dari ${adminInfo.username} diabaikan (diambil ${pickedBy}).`);
     }
   });

    // --- Super Admin Fungsi ---

    socket.on('delete_chat', async ({ chatId }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus chat ${chatId}.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus chat.' });
        }

        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
            return socket.emit('superadmin_error', { message: 'Chat ID tidak valid.' });
        }
        const encodedChatId = encodeFirebaseKey(normalizedChatId);

        console.log(`Super Admin ${adminInfo.username} menghapus chat history untuk ${normalizedChatId}`);

        if (chatHistory[encodedChatId]) {
            delete chatHistory[encodedChatId];
            if (pickedChats[normalizedChatId]) {
                clearAutoReleaseTimer(normalizedChatId);
                delete pickedChats[normalizedChatId];
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
            }

            const success = await deleteChatHistoryFromFirebase(encodedChatId);

            if (success) {
                io.emit('chat_history_deleted', { chatId: normalizedChatId });
                socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0]} berhasil dihapus.` });
            } else {
                 if (!chatHistory[encodedChatId]) chatHistory[encodedChatId] = { status: 'open', messages: [] };
                 socket.emit('superadmin_error', { message: 'Gagal menghapus chat dari Firebase.' });
            }
        } else {
             socket.emit('superadmin_error', { message: 'Chat tidak ditemukan dalam history.' });
        }
    });

     socket.on('delete_all_chats', async () => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus semua chat.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus semua chat.' });
        }

         console.log(`Super Admin ${adminInfo.username} menghapus SEMUA chat history.`);

         chatHistory = {};
         for (const chatId in pickedChats) {
             clearAutoReleaseTimer(chatId);
         }
         pickedChats = {};

         const success = await deleteAllChatHistoryFromFirebase();

         if (success) {
             io.emit('all_chat_history_deleted');
             io.emit('initial_pick_status', pickedChats); // Broadcast status picks kosong
             socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus.' });
         } else {
             socket.emit('superadmin_error', { message: 'Gagal menghapus semua chat dari Firebase.' });
         }
     });

     socket.on('add_admin', ({ username, password, initials, role }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`Akses ditolak: Admin ${adminInfo?.username} mencoba menambah admin.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menambah admin.' });
        }

        if (!username || !password || !initials) {
            return socket.emit('superadmin_error', { message: 'Username, password, dan initials harus diisi.' });
        }
        if (admins[username]) {
            return socket.emit('superadmin_error', { message: `Admin dengan username '${username}' sudah ada.` });
        }
         // Allow role 'admin' or 'superadmin' for the new admin
         const validRoles = ['admin', 'superadmin'];
         if (!role || !validRoles.includes(role)) {
              return socket.emit('superadmin_error', { message: 'Role admin tidak valid. Gunakan "admin" atau "superadmin".' });
         }
         // Only Super Admin can create another Super Admin
         if (role === 'superadmin' && adminInfo.role !== 'superadmin') {
              // This check should technically be redundant due to the main superadmin check,
              // but it adds a layer of safety if logic changes.
              return socket.emit('superadmin_error', { message: 'Hanya Super Admin yang bisa membuat Super Admin baru.' });
         }


        console.log(`Super Admin ${adminInfo.username} menambah admin baru: ${username} (${role})`);

        admins[username] = {
            password: password, // Consider hashing
            initials: initials,
            role: role
        };

        saveAdminsToFirebase(); // This will trigger 'registered_admins' broadcast

        socket.emit('superadmin_success', { message: `Admin '${username}' berhasil ditambahkan.` });
     });

     socket.on('close_chat', ({ chatId }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !chatId) {
             return socket.emit('chat_status_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
        }
        const username = adminInfo.username;
        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
            return socket.emit('chat_status_error', { chatId, message: 'Chat ID tidak valid.' });
        }

        const encodedChatId = encodeFirebaseKey(normalizedChatId);
        if (!chatHistory[encodedChatId]) {
             return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan.' });
        }

        const pickedBy = pickedChats[normalizedChatId];
        // Allow closing if Super Admin OR if admin who picked it
        if (isSuperAdmin(username) || pickedBy === username) {
            if (chatHistory[encodedChatId].status === 'closed') {
                 return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
            }

            console.log(`Admin ${username} menutup chat ${normalizedChatId}`);
            chatHistory[encodedChatId].status = 'closed';

            if (pickedBy) {
                 clearAutoReleaseTimer(normalizedChatId);
                 delete pickedChats[normalizedChatId];
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
            }

            saveChatHistoryToFirebase();

            io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' });
            socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0]} berhasil ditutup.` });

        } else {
             const errorMsg = pickedBy ? `Hanya ${pickedBy} atau Super Admin yang bisa menutup chat ini.` : `Hanya Super Admin yang bisa menutup chat yang tidak diambil.`;
            socket.emit('chat_status_error', { chatId: normalizedChatId, message: errorMsg });
        }
     });

      socket.on('open_chat', ({ chatId }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`Akses ditolak: Admin ${adminInfo?.username} mencoba membuka kembali chat.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa membuka kembali chat.' });
        }

        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
            return socket.emit('superadmin_error', { message: 'Chat ID tidak valid.' });
        }
        const encodedChatId = encodeFirebaseKey(normalizedChatId);
        if (!chatHistory[encodedChatId]) {
             return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan.' });
        }

         if (chatHistory[encodedChatId].status === 'open') {
              return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat sudah terbuka.' });
         }


        console.log(`Super Admin ${adminInfo.username} membuka kembali chat ${normalizedChatId}`);
        chatHistory[encodedChatId].status = 'open';

        saveChatHistoryToFirebase();

        io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' });
        socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0]} berhasil dibuka kembali.` });

     });


  socket.on('disconnect', (reason) => {
    const username = cleanupAdminState(socket.id);
    if (username) {
      console.log(`Admin ${username} terputus (${socket.id}). Alasan: ${reason}`);
    } else {
       console.log(`Koneksi socket ${socket.id} terputus (belum login). Alasan: ${reason}`);
    }
  });

  // --- Other Socket Events (like auto complete) ---
  // "Auto Complete Chat" interpreted as "Mark as Closed" is already added as 'close_chat'
});


process.on('SIGINT', async () => {
  console.log('Menerima SIGINT (Ctrl+C). Membersihkan...');
  if (sock) {
    console.log('Menutup koneksi WhatsApp...');
    sock.end(new Error('Server Shutdown'));
  }
  console.log('Server dimatikan.');
  process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Menerima SIGTERM. Membersihkan...');
    if (sock) {
       console.log('Menutup koneksi WhatsApp...');
       sock.end(new Error('Server Shutdown'));
    }
    console.log('Server dimatikan.');
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});