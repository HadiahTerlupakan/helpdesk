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
const adminSockets = {}; // socket ID -> { username: '...', role: '...' } // Menyimpan info admin login
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId (normalized) -> username // State di backend untuk chat yang diambil
const chatReleaseTimers = {}; // chatId (normalized) -> setTimeout ID
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Struktur chatHistory: { encodedChatId: { status: 'open'|'closed', messages: [...] } }
let chatHistory = {};
const superAdminUsername = config.superAdminUsername; // Ambil superadmin username dari config

let sock; // Variabel global untuk instance socket Baileys
let qrDisplayed = false;

// --- Fungsi Helper ---

const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' });

// Memuat Data dari Firebase (History & Admins)
async function loadDataFromFirebase() {
    console.log("[FIREBASE] Memuat data dari Firebase...");
    const dbRef = ref(database); // Root reference

    try {
        // Muat Chat History
        const historySnapshot = await get(child(dbRef, 'chatHistory'));
        if (historySnapshot.exists()) {
            chatHistory = historySnapshot.val();
            console.log('[FIREBASE] Riwayat chat berhasil dimuat dari Firebase.');
             // Pastikan struktur history sesuai harapan jika dimuat
            for (const encodedChatId in chatHistory) {
                 if (chatHistory[encodedChatId]) {
                     // Handle data lama tanpa array messages atau status
                     if (!chatHistory[encodedChatId].messages) {
                        console.warn(`[FIREBASE] Mengkonversi struktur chat history lama untuk ${decodeFirebaseKey(encodedChatId)}: Menambahkan array 'messages'.`);
                        // Asumsi data lama adalah array messages langsung
                        chatHistory[encodedChatId] = { status: 'open', messages: chatHistory[encodedChatId] };
                     }
                     if (!chatHistory[encodedChatId].status) {
                        console.warn(`[FIREBASE] Menambahkan status default 'open' untuk chat ${decodeFirebaseKey(encodedChatId)}.`);
                        chatHistory[encodedChatId].status = 'open'; // Set status default jika tidak ada
                     }
                     // Clean up potentially invalid entries
                     if (!Array.isArray(chatHistory[encodedChatId].messages)) {
                         console.error(`[FIREBASE] Chat history untuk ${decodeFirebaseKey(encodedChatId)} memiliki struktur 'messages' yang tidak valid. Mengosongkan pesan.`);
                          chatHistory[encodedChatId].messages = [];
                     }
                 } else {
                     // Handle null or invalid entry at top level
                     console.warn(`[FIREBASE] Entri chat history tidak valid ditemukan dan dihapus: ${encodedChatId}`);
                     delete chatHistory[encodedChatId];
                 }
            }
        } else {
            console.log('[FIREBASE] Tidak ada riwayat chat di Firebase.');
            chatHistory = {};
        }

        // Muat Admins
        const adminsSnapshot = await get(child(dbRef, 'admins'));
        if (adminsSnapshot.exists()) {
            admins = adminsSnapshot.val();
            console.log('[FIREBASE] Data admin berhasil dimuat dari Firebase.');
             // Validasi dasar untuk superadmin
             if (!admins[superAdminUsername] || admins[superAdminUsername].role !== 'superadmin') {
                 console.warn(`[FIREBASE] PERINGATAN: Super Admin '${superAdminUsername}' tidak ditemukan atau tidak memiliki role 'superadmin' di Firebase. Beberapa fungsi mungkin tidak tersedia.`);
             }
        } else {
            console.warn('[FIREBASE] Tidak ada data admin di Firebase. Menggunakan data dari config.js sebagai default.');
            // Jika tidak ada admin di Firebase, gunakan yang dari config sebagai default
             admins = config.admins;
             console.log('[FIREBASE] Menggunakan admin dari config.js.');
             // Opsional: Simpan admin dari config ke Firebase untuk pertama kali
             saveAdminsToFirebase(); // Panggil ini sekali saat tidak ada admin di DB
        }

    } catch (error) {
        console.error('[FIREBASE] Gagal memuat data dari Firebase:', error);
        // Handle error - mungkin perlu keluar atau mencoba lagi
         throw error; // Lempar error agar proses start terhenti jika gagal muat data kritis
    }
}

// Menyimpan Chat History ke Firebase
function saveChatHistoryToFirebase() {
    const dbRef = ref(database, 'chatHistory');
    // Firebase tidak mengizinkan undefined, ubah menjadi null jika ada.
    // Gunakan replacer function untuk JSON.stringify.
    const sanitizedChatHistory = JSON.parse(JSON.stringify(chatHistory, (key, value) => value === undefined ? null : value));

    set(dbRef, sanitizedChatHistory)
        .then(() => {
            // console.log('[FIREBASE] Riwayat chat berhasil disimpan ke Firebase.');
        })
        .catch((error) => {
            console.error('[FIREBASE] Gagal menyimpan riwayat chat ke Firebase:', error);
        });
}

// Menyimpan Data Admin ke Firebase
function saveAdminsToFirebase() {
    const dbRef = ref(database, 'admins');
     // Firebase tidak mengizinkan undefined.
     const sanitizedAdmins = JSON.parse(JSON.stringify(admins, (key, value) => value === undefined ? null : value));
    set(dbRef, sanitizedAdmins)
        .then(() => {
            console.log('[FIREBASE] Data admin berhasil disimpan ke Firebase.');
            // Broadcast updated admin list to all clients
            io.emit('registered_admins', admins);
            // Also update online list as roles might affect who is considered 'online' if needed,
            // though getOnlineAdminUsernames uses adminSockets which already has role.
             io.emit('update_online_admins', getOnlineAdminUsernames());
        })
        .catch((error) => {
            console.error('[FIREBASE] Gagal menyimpan data admin ke Firebase:', error);
        });
}

// Menghapus Chat History dari Firebase
async function deleteChatHistoryFromFirebase(encodedChatId) {
    const dbRef = ref(database, `chatHistory/${encodedChatId}`);
    try {
        await remove(dbRef);
        console.log(`[FIREBASE] Chat history untuk ${decodeFirebaseKey(encodedChatId)} berhasil dihapus dari Firebase.`);
        return true;
    } catch (error) {
        console.error(`[FIREBASE] Gagal menghapus chat history untuk ${decodeFirebaseKey(encodedChatId)} dari Firebase:`, error);
        return false;
    }
}

// Menghapus Semua Chat History dari Firebase
async function deleteAllChatHistoryFromFirebase() {
    const dbRef = ref(database, 'chatHistory');
    try {
        await remove(dbRef);
        console.log('[FIREBASE] Semua chat history berhasil dihapus dari Firebase.');
        return true;
    } catch (error) {
        console.error('[FIREBASE] Gagal menghapus semua chat history dari Firebase:', error);
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
    console.log(`[TIMER] Memulai timer auto-release ${timeoutMinutes} menit untuk chat ${normalizedChatId} oleh ${username}.`);

    chatReleaseTimers[normalizedChatId] = setTimeout(() => {
      if (pickedChats[normalizedChatId] === username) {
        console.log(`[TIMER] Timer auto-release habis untuk chat ${normalizedChatId} (diambil ${username}). Melepas chat.`);
        delete pickedChats[normalizedChatId];
        delete chatReleaseTimers[normalizedChatId];
        io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
        io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick
        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId) {
          io.to(targetSocketId).emit('auto_release_notification', { chatId: normalizedChatId, message: `Chat ${normalizedChatId.split('@')[0]} dilepas otomatis (tidak aktif).` });
        }
      } else {
          // Jika chat sudah tidak diambil oleh admin ini (mungkin diambil admin lain/manual unpick), timer ini sudah kadaluarsa
          console.log(`[TIMER] Timer auto-release untuk ${normalizedChatId} oleh ${username} habis, tetapi chat sudah tidak diambil oleh admin ini. Timer dibersihkan.`);
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
        console.log(`[ADMIN] Membersihkan state untuk admin ${username} (Socket ID: ${socketId})`);
        // Lepas semua chat yang diambil oleh admin ini
        const chatsToRelease = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === username);
        chatsToRelease.forEach(chatId => {
            clearAutoReleaseTimer(chatId);
            delete pickedChats[chatId];
            console.log(`[ADMIN] Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            io.emit('update_pick_status', { chatId: chatId, pickedBy: null }); // Beri tahu semua klien bahwa chat dilepas
        });

        delete adminSockets[socketId];
        delete usernameToSocketId[username];
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Beri tahu semua klien status online admin terbaru
        io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick terbaru
        return username;
    }
    return null;
}

// Fungsi untuk memastikan chatId dalam format lengkap
function normalizeChatId(chatId) {
  if (!chatId) return null;
  // Tambahkan cek apakah sudah format lengkap, jika tidak, asumsikan itu adalah JID
  if (!chatId.includes('@')) {
       return `${chatId}@s.whatsapp.net`;
  }
  // Untuk group chats, pastikan formatnya @g.us jika belum
  if (chatId.endsWith('-') && !chatId.endsWith('@g.us')) {
       // Asumsi group JID format number-timestamp@g.us
       return `${chatId}g.us`;
  }
  return chatId; // Sudah dalam format lengkap
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
    console.log("[SERVER] Data Firebase siap. Memulai koneksi WhatsApp dan Server HTTP.");
     connectToWhatsApp().catch(err => {
      console.error("[WA] Gagal memulai koneksi WhatsApp awal:", err);
      // Mungkin perlu keluar atau mencoba lagi dengan strategi berbeda
    });

    server.listen(PORT, () => {
      console.log(`[SERVER] Server Helpdesk berjalan di http://localhost:${PORT}`);
      console.log(`[SERVER] Versi Aplikasi: ${config.version || 'N/A'}`);
    });

}).catch(err => {
    console.error("[SERVER] Gagal memuat data awal dari Firebase. Server tidak dapat dimulai.", err);
    process.exit(1); // Keluar jika gagal memuat data penting
});


expressApp.use(express.static(__dirname));
expressApp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Configure session middleware (jika diperlukan untuk hal lain, saat ini tidak banyak dipakai)
expressApp.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: config.cookieSecure || false }
}));

const PORT = config.serverPort || 3000;


// --- Koneksi WhatsApp (Baileys) ---

async function connectToWhatsApp() {
  console.log("[WA] Mencoba menghubungkan ke WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.baileysOptions?.printQRInTerminal ?? true,
    browser: Browsers.macOS('Desktop'), // Ganti jika perlu
    logger: logger,
     syncFullHistory: false, // Untuk history lama, atur true jika perlu sync semua
    getMessage: async (key) => {
        // Baileys mungkin meminta pesan lama (misal untuk quote/reply)
        // Implementasi ini mencoba mencarinya di chatHistory.
        // Catatan: chatHistory hanya menyimpan data esensial, BUKAN objek pesan Baileys penuh.
        // Ini mungkin tidak cukup untuk fitur Baileys yang kompleks seperti quoting.
        const encodedChatId = encodeFirebaseKey(key.remoteJid);
        const msg = chatHistory[encodedChatId]?.messages?.find(m => m.id === key.id);
        // console.warn(`[WA] Baileys meminta pesan ${key.id} dari ${key.remoteJid}. Ditemukan di history: ${!!msg}`);

         // Jika Anda menyimpan objek pesan Baileys utuh, Anda bisa mengembalikannya di sini.
         // Untuk saat ini, mengembalikan undefined agar Baileys tahu kita tidak punya.
         // Ini mungkin menyebabkan fitur reply/quote tidak berfungsi.
        return undefined; // Artinya tidak dapat diambil dari history kita
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isOnline, isConnecting } = update;

    if (qr && !qrDisplayed) {
      qrDisplayed = true;
      console.log('[WA] QR Code diterima, pindai dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
      io.emit('whatsapp_qr', qr);
    }

    if (connection === 'close') {
      qrDisplayed = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Reconnect jika bukan error autentikasi atau fatal lainnya
      const shouldReconnect = ![401, 403, 411, 419, 500, 515].includes(statusCode); // Tambah 515 (connection closed by remote)
      console.error(`[WA] Koneksi WhatsApp terputus: ${lastDisconnect?.error?.message || 'Alasan tidak diketahui'} (Code: ${statusCode || 'N/A'}), Mencoba menyambung kembali: ${shouldReconnect}`);
      io.emit('whatsapp_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode });

      if (shouldReconnect) {
        console.log("[WA] Mencoba menyambung kembali dalam 10 detik..."); // Kurangi delay sedikit
        setTimeout(connectToWhatsApp, 10000);
      } else {
        console.error("[WA] Tidak dapat menyambung kembali secara otomatis. Periksa folder auth_info_baileys, hapus jika sesi invalid, atau scan ulang QR.");
        io.emit('whatsapp_fatal_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode, message: 'Fatal disconnection, manual intervention needed.' });
      }
    } else if (connection === 'open') {
      console.log('[WA] Berhasil terhubung ke WhatsApp!');
      qrDisplayed = false;
      io.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
       // Setelah terhubung, mungkin perlu sync kontak atau chat terbaru jika syncFullHistory: false
       // sock.sendPresenceUpdate('available'); // Optional: Set status online
    } else {
        console.log(`[WA] Status koneksi WhatsApp: ${connection} ${isConnecting ? '(connecting)' : ''} ${isOnline ? '(online)' : ''}`);
        // Emit connecting status if needed
        if (connection === 'connecting') {
            io.emit('whatsapp_connecting', {});
        }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[WA] Pesan ${type} diterima: ${messages.length}`);
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
        // Abaikan pesan dari diri sendiri atau status broadcast
      if (message.key.fromMe || message.key.remoteJid === 'status@broadcast' || (sock?.user?.id && message.key.remoteJid === sock.user.id)) {
        continue;
      }

      const chatId = normalizeChatId(message.key.remoteJid);
       if (!chatId) {
           console.error('[WA] Invalid chatId received:', message.key.remoteJid);
           continue;
       }

      const encodedChatId = encodeFirebaseKey(chatId);
       if (!encodedChatId) {
           console.error('[FIREBASE] Gagal meng-encode chatId:', chatId, 'mengabaikan pesan masuk.');
           continue;
       }


      let messageContent = null;
      let mediaData = null;
      let mediaType = null; // Will store the Baileys message type string (e.g., 'imageMessage')
      let fileName = null;
       let mimeType = null; // Will store the actual MIME type from Baileys

      const messageType = message.message ? Object.keys(message.message)[0] : null; // e.g., 'imageMessage'
      const messageProps = message.message?.[messageType]; // Properties specific to the message type

      const isMedia = messageType ? ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType) : false;

      if (isMedia && messageProps) {
        try {
          const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
          if (buffer) {
              mediaData = buffer.toString('base64');
              mediaType = messageType; // Store the Baileys type string
              mimeType = messageProps.mimetype; // Use the actual mimetype if available
              fileName = messageProps.fileName || messageProps.caption || `${mediaType.replace('Message', '')}_file`;
              // For audio, if not voice note, fileName might be useful
              if (mediaType === 'audioMessage' && messageProps.ptt) fileName = 'Voice Note';

              messageContent = messageProps.caption || `[${mediaType.replace('Message', '')}]`;

          } else {
              console.warn(`[WA] Gagal mengunduh media (buffer kosong) dari ${chatId} untuk pesan ${message.key.id}`);
              messageContent = `[Gagal mengunduh media ${messageType.replace('Message', '')}]`;
          }
        } catch (error) {
          console.error(`[WA] Error mengunduh media dari ${chatId} untuk pesan ${message.key.id}:`, error);
          messageContent = `[Gagal memuat media ${messageType.replace('Message', '')}]`;
        }
      } else if (messageType === 'conversation') {
        messageContent = messageProps.conversation;
      } else if (messageType === 'extendedTextMessage' && messageProps.text) {
        messageContent = messageProps.text;
      } else if (messageType === 'imageMessage' && messageProps.caption) {
         messageContent = messageProps.caption;
      }
       // Add other message types you want to handle for text snippet
       else if (messageType === 'stickerMessage') {
           messageContent = '[Stiker]';
       } else if (messageType === 'locationMessage') {
           messageContent = '[Lokasi]';
       } else if (messageType === 'contactMessage') {
           messageContent = '[Kontak]';
       } else if (messageType === 'liveLocationMessage') {
            messageContent = '[Live Lokasi]';
       } else if (messageType === 'protocolMessage') {
           // These are often service messages, might ignore or log
           // console.log(`[WA] Protocol message skipped: ${chatId}`, message);
           continue; // Skip protocol messages from history/display
       } else if (messageType === 'reactionMessage') {
            // console.log(`[WA] Reaction message skipped: ${chatId}`, message);
            continue; // Skip reactions from history/display
       }
      else {
          // Fallback for unknown or empty message types
         messageContent = `[Pesan tidak dikenal: ${messageType || 'N/A'}]`;
      }

      const messageData = {
        id: message.key.id,
        from: chatId, // Store original sender (the customer)
        text: messageContent,
        mediaData: mediaData,
        mediaType: mediaType, // Store Baileys type string
        mimeType: mimeType, // Store actual MIME type from message
        fileName: fileName,
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        unread: true, // Mark incoming messages as unread by default
        type: 'incoming'
      };


      // Initialize chat entry if it doesn't exist or if messages array is missing
      if (!chatHistory[encodedChatId] || !chatHistory[encodedChatId].messages) {
        console.log(`[HISTORY] Membuat/memperbaiki entri baru untuk chat ${chatId}.`);
        chatHistory[encodedChatId] = { status: chatHistory[encodedChatId]?.status || 'open', messages: [] }; // Pertahankan status jika sudah ada, default open
      }
       // Ensure messages array exists
       if (!chatHistory[encodedChatId].messages) {
           chatHistory[encodedChatId].messages = [];
       }
        // Ensure status exists
       if (!chatHistory[encodedChatId].status) {
           chatHistory[encodedChatId].status = 'open';
       }


      // Add message to the messages array, deduplicate
      if (!chatHistory[encodedChatId].messages.some(m => m.id === messageData.id)) {
        console.log(`[HISTORY] Menambahkan pesan masuk baru (ID: ${messageData.id}) ke chat ${chatId}`);
        chatHistory[encodedChatId].messages.push(messageData);
        saveChatHistoryToFirebase(); // Save after adding message

        // Emit new message to all connected admin clients
        io.emit('new_message', { ...messageData, chatId: chatId, chatStatus: chatHistory[encodedChatId].status });

        // Send notification to admins if chat is not picked OR picked by someone else
        const pickedBy = pickedChats[chatId];
        // Filter who should get notification
        const onlineAdmins = getOnlineAdminUsernames();
        onlineAdmins.forEach(adminUsername => {
            const adminSocketId = usernameToSocketId[adminUsername];
            if (adminSocketId) {
                 const adminCurrentlyPicked = pickedChats[chatId];
                 // Notify if not picked by anyone OR picked by someone else
                 if (!adminCurrentlyPicked || adminCurrentlyPicked !== adminUsername) {
                      // Use the actual message content for the notification body
                      const notificationBody = messageContent || (mediaType ? `[${mediaType.replace('Message', '')}]` : '[Pesan Baru]');
                     io.to(adminSocketId).emit('notification', {
                        title: `Pesan Baru (${chatId.split('@')[0]})`,
                        body: notificationBody,
                        icon: '/favicon.ico', // Pastikan icon ada
                        chatId: chatId
                     });
                 }
            }
        });

      } else {
         // console.log(`[WA] Pesan duplikat terdeteksi di upsert (ID: ${messageData.id}), diabaikan.`);
      }
    }
  });

    // Handle message receipts/read status if needed, though not strictly part of the request
    // sock.ev.on('messages.update', (updates) => { /* ... */ });
    // sock.ev.on('message-status.update', (updates) => { /* ... */ });
}


// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`[SOCKET] Admin terhubung: ${socket.id}`);

  // Send initial state to the newly connected client
  socket.emit('registered_admins', admins);
  socket.emit('update_online_admins', getOnlineAdminUsernames());
  socket.emit('initial_pick_status', pickedChats); // Send current picked status

  if (sock?.user) {
      socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
  } else {
      socket.emit('whatsapp_disconnected', { reason: 'Connecting...', statusCode: 'N/A' });
  }


  socket.on('request_initial_data', () => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (adminInfo) {
      console.log(`[SOCKET] Admin ${adminInfo.username} meminta data awal.`);
      const decodedChatHistory = {};
      for (const encodedKey in chatHistory) {
        const decodedKey = decodeFirebaseKey(encodedKey);
         if (decodedKey && chatHistory[encodedKey]?.messages) { // Pastikan messages array ada
            decodedChatHistory[decodedKey] = {
                status: chatHistory[encodedKey].status || 'open', // Default status
                messages: chatHistory[encodedKey].messages.map((message) => ({
                    ...message,
                    chatId: decodedKey // Ensure chatId is added to each message object for frontend
                }))
            };
         } else if (decodedKey) {
              // Handle case where chat entry exists but has no messages
               decodedChatHistory[decodedKey] = {
                   status: chatHistory[encodedKey]?.status || 'open',
                   messages: [] // Ensure it's an empty array
               };
         }
      }
      socket.emit('initial_data', { chatHistory: decodedChatHistory, admins: admins, currentUserRole: adminInfo.role });
      // Redundant, initial_pick_status already sent on connect/reconnect_success
      // socket.emit('initial_pick_status', pickedChats);
      // io.emit('update_online_admins', getOnlineAdminUsernames()); // Redundant, already sent on login/reconnect
    } else {
      console.warn(`[SOCKET] Socket ${socket.id} meminta data awal sebelum login.`);
      socket.emit('request_login'); // Tell frontend to show login
    }
  });

  socket.on('get_chat_history', (chatId) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[SOCKET] Socket ${socket.id} meminta history sebelum login.`);
        return socket.emit('chat_history_error', { chatId, message: 'Login diperlukan.' });
    }
    if (!chatId) {
         console.warn(`[SOCKET] Admin ${adminInfo.username} meminta history dengan ID chat kosong.`);
         return socket.emit('chat_history_error', { chatId, message: 'Chat ID tidak valid.' });
    }

    const normalizedChatId = normalizeChatId(chatId);
    const encodedChatId = encodeFirebaseKey(normalizedChatId);

    if (!encodedChatId) {
        console.error(`[SOCKET] Gagal meng-encode chatId untuk get_chat_history: ${chatId}`);
        return socket.emit('chat_history_error', { chatId, message: 'Kesalahan internal: ID chat tidak valid.' });
    }

    const chatEntry = chatHistory[encodedChatId];
    const history = chatEntry?.messages?.map((message) => ({ // Check messages array exists
      ...message,
      chatId: normalizedChatId // Ensure chatId is added
    })) || []; // Provide empty array if no messages
    const status = chatEntry?.status || 'open';

    console.log(`[SOCKET] Mengirim history untuk chat ${normalizedChatId} ke admin ${adminInfo.username}.`);
    socket.emit('chat_history', { chatId: normalizedChatId, messages: history, status: status });
  });

  socket.on('admin_login', ({ username, password }) => {
      console.log(`[ADMIN] Menerima percobaan login untuk: ${username}`);
    const adminUser = admins[username];
    if (adminUser && adminUser.password === password) { // Basic password check (consider hashing in production)
      // Cek apakah admin sudah login dari socket lain
      const existingSocketId = usernameToSocketId[username];
      if (existingSocketId && io.sockets.sockets.get(existingSocketId)) {
         console.warn(`[ADMIN] Login gagal: Admin ${username} sudah login dari socket ${existingSocketId}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain. Silakan logout dari perangkat lain atau tunggu.' });
         return;
      }

      console.log(`[ADMIN] Login berhasil: ${username} (Socket ID: ${socket.id})`);
      adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
      usernameToSocketId[username] = socket.id;

      socket.emit('login_success', { username: username, initials: adminUser.initials, role: adminUser.role || 'admin', currentPicks: pickedChats }); // Send current picks on login
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Notify everyone about new online admin
       // initial data will be requested by frontend after login_success

    } else {
      console.log(`[ADMIN] Login gagal untuk username: ${username}. Username atau password salah.`);
      socket.emit('login_failed', { message: 'Username atau password salah.' });
    }
  });

  socket.on('admin_reconnect', ({ username }) => {
      console.log(`[ADMIN] Menerima percobaan reconnect untuk: ${username} (Socket ID: ${socket.id})`);
    const adminUser = admins[username];
    if (adminUser) {
        const existingSocketId = usernameToSocketId[username];
        // Jika ada socket lain yang terdaftar untuk username ini DAN socket tersebut masih aktif
        if (existingSocketId && existingSocketId !== socket.id && io.sockets.sockets.get(existingSocketId)) {
             console.warn(`[ADMIN] Admin ${username} mereconnect. Menutup socket lama ${existingSocketId}.`);
             // Cleanup state for the old socket first
             cleanupAdminState(existingSocketId);
             // Force disconnect the old socket (optional, cleanup might be enough)
             // io.sockets.sockets.get(existingSocketId)?.disconnect(true); // This might trigger disconnect handler again
        } else if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
             console.log(`[ADMIN] Admin ${username} mereconnect. Socket lama ${existingSocketId} sudah tidak aktif. Membersihkan state lama.`);
              cleanupAdminState(existingSocketId); // Ensure old state is clean
        }


        console.log(`[ADMIN] Reconnect berhasil untuk ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
        usernameToSocketId[username] = socket.id;
        socket.emit('reconnect_success', { username: username, currentPicks: pickedChats, role: adminUser.role || 'admin' }); // Send current picks on reconnect
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Notify everyone about online status
        // initial data will be requested by frontend after reconnect_success
    } else {
        console.warn(`[ADMIN] Reconnect failed: Admin ${username} not found in registered admins.`);
        socket.emit('reconnect_failed');
    }
  });


  socket.on('admin_logout', () => {
    const username = cleanupAdminState(socket.id); // Cleanup state and get username
    if (username) {
        console.log(`[ADMIN] Admin ${username} logout.`);
        socket.emit('logout_success');
        // cleanupAdminState already emits update_online_admins
    } else {
         console.warn(`[ADMIN] Socket ${socket.id} mencoba logout tapi tidak terdaftar sebagai admin login.`);
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
         console.warn(`[PICK] Admin ${username} mencoba mengambil chat tertutup ${normalizedChatId}`);
         return socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa diambil.' });
     }


    if (pickedChats[normalizedChatId] && pickedChats[normalizedChatId] !== username) {
      console.warn(`[PICK] Admin ${username} mencoba mengambil chat ${normalizedChatId} yang sudah diambil oleh ${pickedChats[normalizedChatId]}`);
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedChats[normalizedChatId]}.` });
    } else if (!pickedChats[normalizedChatId]) {
      // Chat belum diambil
      pickedChats[normalizedChatId] = username;
      console.log(`[PICK] Admin ${username} mengambil chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username }); // Broadcast status pick terbaru
      io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick

      startAutoReleaseTimer(normalizedChatId, username);

       // Mark incoming messages as read when picked
       const chatEntry = chatHistory[encodedChatId];
       if (chatEntry?.messages) {
           let changed = false;
           // Iterasi dari pesan terbaru ke belakang
           for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                // Hanya mark pesan incoming yang belum dibaca
                if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                    chatEntry.messages[i].unread = false;
                    changed = true;
                } else if (chatEntry.messages[i].type === 'outgoing') {
                     // Stop marking as read once we hit an outgoing message (sent by an admin)
                    break;
                }
           }
           if (changed) {
               console.log(`[MARK] Mark incoming messages as read for chat ${normalizedChatId} by ${adminInfo.username}.`);
               saveChatHistoryToFirebase();
               io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Notify clients to update unread indicator
           }
       }
    } else {
      // Chat sudah diambil oleh admin yang sama, mungkin hanya perlu restart timer
      console.log(`[PICK] Admin ${username} mengklik pick lagi untuk ${normalizedChatId}, mereset timer.`);
      startAutoReleaseTimer(normalizedChatId, username);
      socket.emit('pick_info', { chatId: normalizedChatId, message: 'Timer auto-release direset.' });
    }
  });

  socket.on('unpick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
     const username = adminInfo.username;
     const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    // Hanya admin yang mengambil atau Super Admin yang bisa unpick
    const pickedBy = pickedChats[normalizedChatId];
    if (pickedBy === username || isSuperAdmin(username)) {
        if (pickedBy) { // Pastikan memang sedang diambil
            clearAutoReleaseTimer(normalizedChatId);
            delete pickedChats[normalizedChatId];
            console.log(`[PICK] Admin ${username} melepas chat ${normalizedChatId}`);
            io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Broadcast status pick terbaru
             io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick
        } else {
            console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil.`);
             socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
        }
    } else if (pickedBy) {
       console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang diambil oleh ${pickedBy}. Akses ditolak.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedBy} atau Super Admin yang bisa melepas chat ini.` });
    } else {
        // Ini seharusnya ditangani oleh block pertama (jika pickedBy ada)
        // Tapi sebagai fallback jika logic agak kacau
         console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} dalam keadaan ambigu.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
    }
  });

  socket.on('delegate_chat', ({ chatId, targetAdminUsername }) => {
      console.log(`[DELEGATE] Permintaan delegasi chat ${chatId} ke ${targetAdminUsername}`);
      const adminInfo = getAdminInfoBySocketId(socket.id);
      if (!adminInfo) {
          console.warn(`[DELEGATE] Socket ${socket.id} mencoba delegasi sebelum login.`);
          return socket.emit('delegate_error', { chatId, message: 'Login diperlukan.' });
      }
      const senderAdminUsername = adminInfo.username;
      const senderAdminRole = adminInfo.role;

      const normalizedChatId = normalizeChatId(chatId);

      if (!normalizedChatId || !targetAdminUsername) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi dengan data tidak lengkap.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Data tidak lengkap (ID chat atau target admin kosong).' });
      }

      const currentPickedBy = pickedChats[normalizedChatId];
      // Cek apakah pengirim adalah admin yang mengambil chat ATAU Super Admin
      if (currentPickedBy !== senderAdminUsername && senderAdminRole !== 'superadmin') {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi chat ${normalizedChatId} yang diambil oleh ${currentPickedBy || 'tidak ada'}. Akses ditolak.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: currentPickedBy ? `Chat ini sedang ditangani oleh ${currentPickedBy}.` : 'Chat ini belum diambil oleh Anda.' });
      }
      if (senderAdminUsername === targetAdminUsername) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke diri sendiri.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      }
      // Cek apakah target admin valid (ada di daftar admin terdaftar)
      if (!admins[targetAdminUsername]) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke admin target tidak dikenal: ${targetAdminUsername}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: `Admin target '${targetAdminUsername}' tidak ditemukan.` });
      }

       // Cek status chat, jangan biarkan didelegasikan jika sudah closed
      const encodedChatId = encodeFirebaseKey(normalizedChatId);
      if (chatHistory[encodedChatId]?.status === 'closed') {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan chat tertutup ${normalizedChatId}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa didelegasikan.' });
      }


      console.log(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId);
      pickedChats[normalizedChatId] = targetAdminUsername; // Update state di backend
      startAutoReleaseTimer(normalizedChatId, targetAdminUsername); // Mulai timer untuk admin baru

      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername }); // Broadcast status pick terbaru
       io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick

      // Beri tahu admin target jika dia sedang online
      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId) {
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0]} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
          });
      }

      socket.emit('delegate_success', { chatId: normalizedChatId, targetAdminUsername }); // Konfirmasi ke pengirim
  });


  socket.on('reply_message', async ({ to, text, media }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[REPLY] Socket ${socket.id} mencoba kirim pesan sebelum login.`);
        return socket.emit('send_error', { to: to, text, message: 'Login diperlukan.' });
    }
    const username = adminInfo.username;

    const chatId = normalizeChatId(to);
    if (!chatId || (!text && !media)) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan dengan data tidak lengkap.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Data tidak lengkap (ID chat, teks, atau media kosong).' });
    }
    if (!sock || sock.ws.readyState !== sock.ws.OPEN) { // Cek koneksi WA siap
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan, tapi koneksi WA tidak siap.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Koneksi WhatsApp belum siap.' });
    }

    // Cek apakah chat diambil dan diambil oleh admin yang mengirim
    const pickedBy = pickedChats[chatId];
    if (!pickedBy) {
         console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat ${chatId} yang belum diambil.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Ambil chat ini terlebih dahulu.' });
    }
    if (pickedBy !== username) {
         console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat ${chatId} yang diambil oleh ${pickedBy}.`);
        return socket.emit('send_error', { to: chatId, text, message: `Sedang ditangani oleh ${pickedBy}.` });
    }

     const encodedChatId = encodeFirebaseKey(chatId);
     // Cek status chat
     if (chatHistory[encodedChatId]?.status === 'closed') {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat tertutup ${chatId}.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Chat sudah ditutup. Tidak bisa mengirim balasan.' });
    }


    try {
      const adminInfoFromAdmins = admins[username];
      // Ambil inisial, pastikan max 3 huruf dan selalu tambahkan strip di depan untuk format WA
      const adminInitials = (adminInfoFromAdmins?.initials || username.substring(0, 3).toUpperCase()).substring(0,3); // Max 3 chars
        // Append initials only if there is actual text or if it's an audio/media message without caption
      const textForSendingToWA = text ? `${text.trim()}

-${adminInitials}` : (media && !text ? `-${adminInitials}` : ''); // Add initials with '-' prefix and '_' suffix


      let sentMsgResult;

      if (media) {
        if (!media.data || !media.type) {
             console.error(`[REPLY] Media data atau type kosong untuk chat ${chatId}`);
             return socket.emit('send_error', { to: chatId, text, media, message: 'Data media tidak valid.' });
        }
        const mediaBuffer = Buffer.from(media.data, 'base64');
        // Determine the correct MIME type to send to Baileys if not explicitly provided
        const mediaMimeType = media.mimeType || media.type; // Prefer mimeType if available

        const mediaOptions = {
          mimetype: mediaMimeType,
          fileName: media.name || 'file',
           // Use textForSendingToWA as caption if it exists, otherwise undefined
          caption: textForSendingToWA || undefined
        };

        console.log(`[WA] Mengirim media (${mediaMimeType}) ke ${chatId} oleh ${username}...`);

        if (media.type.startsWith('image/')) { // Use media.type from frontend state for general category
          sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, ...mediaOptions });
        } else if (media.type.startsWith('video/')) {
          sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, ...mediaOptions });
        } else if (media.type.startsWith('audio/')) {
            // Baileys recommends ptt: true for voice notes, standard audio needs mimetype
            // If ptt is true, caption is usually ignored by WA clients
           const isVoiceNote = mediaOptions.mimetype === 'audio/ogg; codecs=opus' || mediaOptions.mimetype === 'audio/mpeg' || mediaOptions.mimetype === 'audio/wav'; // Common voice note mimetypes
           // Send text separately if it was provided as caption AND it's a voice note type where caption is ignored
           if (textForSendingToWA && textForSendingToWA.trim().length > 0 && isVoiceNote) {
               // Send audio first
               sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: true });
               // Then send text separately
               await sock.sendMessage(chatId, { text: textForSendingToWA });
           } else {
                // Send audio with potential caption (if supported by type)
               sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: isVoiceNote, caption: isVoiceNote ? undefined : mediaOptions.caption });
           }
        } else if (media.type === 'application/pdf' || media.type.startsWith('application/') || media.type.startsWith('text/')) { // Handle documents and text files
            // Use a generic file icon if the specific type is not handled
             if (media.type === 'application/pdf') {
                 // Specific handling for PDF? Unlikely needed at send time.
             }
             sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, ...mediaOptions });

        } else {
          console.warn(`[REPLY] Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to: chatId, text, media, message: 'Tipe media tidak didukung.' });
          return;
        }

      } else { // Only text message
        if (textForSendingToWA.trim().length > 0) {
           console.log(`[WA] Mengirim teks ke ${chatId} oleh ${username}...`);
           sentMsgResult = await sock.sendMessage(chatId, { text: textForSendingToWA });
        } else {
            console.warn(`[REPLY] Admin ${username} mencoba kirim pesan kosong.`);
            socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten untuk dikirim.' });
            return;
        }
      }

      // Baileys sendMessage can return an array or a single object
      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('[WA] sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.', sentMsgResult);
          socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          return;
      }

      // Store the outgoing message in history
      // IMPORTANT: Store the text *as it was sent to WA* (including initials) or store original text + initials separately.
      // Let's store original text + initials separately for clarity in history data structure,
      // and frontend will decide how to display it.
      const outgoingMessageData = {
        id: sentMsg.key.id,
        from: username, // Store admin username as sender for outgoing
        to: chatId,
        text: text?.trim() || null, // Store original text input
        mediaType: media?.type || null, // Store Baileys type string from frontend
        mimeType: media?.mimeType || media?.type || null, // Store MIME type if known
        mediaData: media?.data || null, // Store media data in history (Base64)
        fileName: media?.name || null,
        initials: adminInitials, // Store initials used
        timestamp: sentMsg.messageTimestamp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(), // Use WA timestamp if available
        type: 'outgoing'
      };


      if (!encodedChatId) {
           console.error('[FIREBASE] Gagal meng-encode chatId untuk menyimpan pesan keluar:', chatId);
           return socket.emit('send_error', { to: chatId, text, media, message: 'Kesalahan internal saat menyimpan history.' });
      }

      // Ensure chat entry and messages array exist before pushing
      if (!chatHistory[encodedChatId]) {
           chatHistory[encodedChatId] = { status: 'open', messages: [] }; // Should ideally exist already, but safer
      }
      if (!chatHistory[encodedChatId].messages) {
           chatHistory[encodedChatId].messages = []; // Ensure messages is an array
      }

      // Check for duplicates before adding to history (important for retries)
      if (!chatHistory[encodedChatId].messages.some(m => m.id === outgoingMessageData.id)) {
        console.log(`[HISTORY] Menambahkan pesan keluar baru (ID: ${outgoingMessageData.id}) ke chat ${chatId}`);
        chatHistory[encodedChatId].messages.push(outgoingMessageData);
        saveChatHistoryToFirebase(); // Save after adding message
      } else {
          console.warn(`[HISTORY] Pesan keluar dengan ID ${outgoingMessageData.id} sudah ada di history, diabaikan penambahannya.`);
      }

      // Emit the message data to all clients so they can display it
      // Include chatStatus in the emitted message data
      io.emit('new_message', { ...outgoingMessageData, chatId: chatId, chatStatus: chatHistory[encodedChatId].status });

      // Confirm sending success to the original sender's socket
      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.to
      });

      // Restart the auto-release timer for this chat
      startAutoReleaseTimer(chatId, username);


    } catch (error) {
      console.error(`[REPLY] Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  socket.on('mark_as_read', ({ chatId }) => {
     const adminInfo = getAdminInfoBySocketId(socket.id);
     if (!adminInfo || !chatId) {
         console.warn(`[SOCKET] Permintaan mark_as_read tanpa login atau chat ID: Socket ${socket.id}`);
         return;
     }

     const normalizedChatId = normalizeChatId(chatId);
     const encodedChatId = encodeFirebaseKey(normalizedChatId);

     if (!encodedChatId) {
         console.error(`[FIREBASE] Gagal meng-encode chatId untuk mark_as_read: ${chatId}`);
         return;
     }

     const pickedBy = pickedChats[normalizedChatId];
     // Allow marking as read if Super Admin OR if admin who picked it
     if (isSuperAdmin(adminInfo.username) || pickedBy === adminInfo.username) {
         const chatEntry = chatHistory[encodedChatId];
         if (chatEntry?.messages) {
              let changed = false;
              // Iterate from the latest message backwards
              for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                   // Only mark pesan incoming yang belum dibaca
                   if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                       chatEntry.messages[i].unread = false;
                       changed = true;
                   } else if (chatEntry.messages[i].type === 'outgoing') {
                        // Stop marking as read once we hit an outgoing message (sent by an admin)
                       break;
                   }
              }
              if (changed) {
                  console.log(`[MARK] Mark incoming messages as read for chat ${normalizedChatId} by ${adminInfo.username}.`);
                  saveChatHistoryToFirebase(); // Save changes
                  io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Notify clients
              }
         }
     } else {
          // console.log(`[MARK] Event mark_as_read untuk ${normalizedChatId} dari ${adminInfo.username} diabaikan (diambil ${pickedBy}).`);
          // Optionally emit an error back if this action requires pick/superadmin
          // socket.emit('mark_read_error', { chatId: normalizedChatId, message: 'Anda tidak memiliki izin untuk menandai chat ini sudah dibaca.' });
     }
   });

    // --- Super Admin Fungsi ---

    socket.on('delete_chat', async ({ chatId }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus chat ${chatId}.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus chat.' });
        }

        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
            console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus chat dengan ID tidak valid.`);
            return socket.emit('superadmin_error', { message: 'Chat ID tidak valid.' });
        }
        const encodedChatId = encodeFirebaseKey(normalizedChatId);

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus chat history untuk ${normalizedChatId}`);

        if (chatHistory[encodedChatId]) {
            // Hapus dari state backend
            delete chatHistory[encodedChatId];
            // Lepas chat jika sedang diambil
            if (pickedChats[normalizedChatId]) {
                clearAutoReleaseTimer(normalizedChatId);
                delete pickedChats[normalizedChatId];
                 // io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Broadcast pick status
                 // io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick
                 // update_pick_status dan initial_pick_status akan dikirim setelah berhasil dihapus dari firebase
            }

            // Hapus dari Firebase
            const success = await deleteChatHistoryFromFirebase(encodedChatId);

            if (success) {
                // Beri tahu semua klien bahwa chat dihapus
                io.emit('chat_history_deleted', { chatId: normalizedChatId });
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Ensure pick status is cleared everywhere
                 io.emit('initial_pick_status', pickedChats); // Ensure overall pick state is broadcast
                socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0]} berhasil dihapus.` });
            } else {
                 // Jika gagal hapus dari Firebase, kembalikan ke state backend (opsional, tergantung strategi error handling)
                 // chatHistory[encodedChatId] = { status: 'open', messages: [] }; // Example of basic revert
                 console.error(`[SUPERADMIN] Gagal menghapus chat ${normalizedChatId} dari Firebase.`);
                 socket.emit('superadmin_error', { message: 'Gagal menghapus chat dari Firebase.' });
            }
        } else {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus chat ${normalizedChatId} yang tidak ditemukan.`);
             socket.emit('superadmin_error', { message: 'Chat tidak ditemukan dalam history.' });
        }
    });

     socket.on('delete_all_chats', async () => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus semua chat.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus semua chat.' });
        }

         console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus SEMUA chat history.`);

         // Bersihkan state backend
         chatHistory = {};
         for (const chatId in pickedChats) {
             clearAutoReleaseTimer(chatId); // Batalkan semua timer
         }
         pickedChats = {}; // Bersihkan status pick

         // Hapus dari Firebase
         const success = await deleteAllChatHistoryFromFirebase();

         if (success) {
             // Beri tahu semua klien
             io.emit('all_chat_history_deleted');
             io.emit('initial_pick_status', pickedChats); // Broadcast status picks kosong
             socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus.' });
         } else {
              console.error(`[SUPERADMIN] Gagal menghapus semua chat dari Firebase.`);
             // Jika gagal hapus dari Firebase, state backend sudah kosong, tapi Firebase masih ada data.
             // Perlu strategi rekonsiliasi jika ini penting.
             socket.emit('superadmin_error', { message: 'Gagal menghapus semua chat dari Firebase.' });
         }
     });

     socket.on('add_admin', ({ username, password, initials, role }) => {
        console.log(`[SUPERADMIN] Menerima permintaan tambah admin: ${username}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah admin.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menambah admin.' });
        }

        if (!username || !password || !initials) {
             console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} data tidak lengkap.`);
            return socket.emit('superadmin_error', { message: 'Username, password, dan initials harus diisi.' });
        }
         // Server-side validation for initials length
         if (initials.length > 3) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} initials terlalu panjang.`);
              return socket.emit('superadmin_error', { message: 'Initials maksimal 3 karakter.' });
         }
        if (admins[username]) {
            console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menambah admin '${username}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Admin dengan username '${username}' sudah ada.` });
        }
         // Allow role 'admin' or 'superadmin' for the new admin
         const validRoles = ['admin', 'superadmin'];
         if (!role || !validRoles.includes(role)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} role tidak valid: ${role}`);
              return socket.emit('superadmin_error', { message: 'Role admin tidak valid. Gunakan "admin" atau "superadmin".' });
         }
         // Only Super Admin can create another Super Admin
         if (role === 'superadmin' && adminInfo.role !== 'superadmin') {
              // This check should technically be redundant due to the main superadmin check,
              // but it adds a layer of safety.
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} (role ${adminInfo.role}) mencoba menambah admin dengan role 'superadmin'. Akses ditolak.`);
              return socket.emit('superadmin_error', { message: 'Hanya Super Admin yang bisa membuat Super Admin baru.' });
         }


        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menambah admin baru: ${username} (${role})`);

        admins[username] = {
            password: password, // CONSIDER HASHING PASSWORDS IN A REAL APPLICATION!
            initials: initials, // Store raw initials
            role: role
        };

        saveAdminsToFirebase(); // This will trigger 'registered_admins' broadcast

        socket.emit('superadmin_success', { message: `Admin '${username}' berhasil ditambahkan.` });
     });

      socket.on('delete_admin', ({ usernameToDelete }) => {
          console.log(`[SUPERADMIN] Menerima permintaan hapus admin: ${usernameToDelete}`);
          const adminInfo = getAdminInfoBySocketId(socket.id);
          if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
              console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus admin.`);
              return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus admin.' });
          }

          if (!usernameToDelete) {
               console.warn(`[SUPERADMIN] Permintaan hapus admin dari ${adminInfo.username} data tidak lengkap.`);
              return socket.emit('superadmin_error', { message: 'Username admin yang akan dihapus tidak valid.' });
          }
          if (usernameToDelete === adminInfo.username) {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus akun sendiri.`);
              return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus akun Anda sendiri.' });
          }
           // Prevent deleting the LAST Super Admin account if there's only one
           const superAdmins = Object.keys(admins).filter(user => admins[user]?.role === 'superadmin');
           if (superAdmins.length === 1 && superAdmins[0] === usernameToDelete) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus Super Admin terakhir: ${usernameToDelete}`);
               return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus Super Admin terakhir.' });
           }


          if (!admins[usernameToDelete]) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus admin '${usernameToDelete}' yang tidak ditemukan.`);
               return socket.emit('superadmin_error', { message: `Admin dengan username '${usernameToDelete}' tidak ditemukan.` });
          }

          console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus admin: ${usernameToDelete}`);

           // Perform cleanup for the admin being deleted if they are online
           const targetSocketId = usernameToSocketId[usernameToDelete];
           if(targetSocketId) {
                console.log(`[SUPERADMIN] Admin ${usernameToDelete} online, membersihkan state dan memutuskan koneksi.`);
                cleanupAdminState(targetSocketId); // This also emits updates
                 // Explicitly disconnect the socket
                 io.sockets.sockets.get(targetSocketId)?.disconnect(true);
           } else {
               // If offline, just emit updates after deleting from data
               io.emit('update_online_admins', getOnlineAdminUsernames()); // Re-broadcast online list
               io.emit('initial_pick_status', pickedChats); // Re-broadcast pick status
           }


          delete admins[usernameToDelete]; // Delete from state

          saveAdminsToFirebase(); // Save changes to Firebase (broadcasts registered_admins)


          socket.emit('superadmin_success', { message: `Admin '${usernameToDelete}' berhasil dihapus.` });
      });


     socket.on('close_chat', ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan tutup chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !chatId) {
             console.warn(`[CHAT STATUS] Socket ${socket.id} mencoba tutup chat tanpa login atau chat ID.`);
             return socket.emit('chat_status_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
        }
        const username = adminInfo.username;
        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
            console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat dengan ID tidak valid.`);
            return socket.emit('chat_status_error', { chatId, message: 'Chat ID tidak valid.' });
        }

        const encodedChatId = encodeFirebaseKey(normalizedChatId);
        const chatEntry = chatHistory[encodedChatId];

        if (!chatEntry) {
             console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang tidak ditemukan di history.`);
             return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan.' });
        }

        const pickedBy = pickedChats[normalizedChatId];
        // Izinkan menutup chat jika Super Admin ATAU admin yang mengambil chat tersebut
        if (isSuperAdmin(username) || pickedBy === username) {
            if (chatEntry.status === 'closed') {
                 console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang sudah tertutup.`);
                 return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
            }

            console.log(`[CHAT STATUS] Admin ${username} menutup chat ${normalizedChatId}`);
            chatEntry.status = 'closed'; // Update status di state backend

            // Lepas chat jika sedang diambil
            if (pickedBy) {
                 clearAutoReleaseTimer(normalizedChatId);
                 delete pickedChats[normalizedChatId];
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Broadcast status pick terbaru
                 io.emit('initial_pick_status', pickedChats); // Broadcast seluruh status pick
            }

            saveChatHistoryToFirebase(); // Simpan perubahan status ke Firebase

            io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' }); // Beri tahu semua klien status terbaru
            socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0]} berhasil ditutup.` });

        } else {
             const errorMsg = pickedBy ? `Hanya ${pickedBy} atau Super Admin yang bisa menutup chat ini.` : `Chat ini tidak diambil oleh siapa pun. Hanya Super Admin yang bisa menutup chat yang tidak diambil.`;
             console.warn(`[CHAT STATUS] Admin ${username} mencoba menutup chat ${normalizedChatId}. Akses ditolak: ${errorMsg}`);
            socket.emit('chat_status_error', { chatId: normalizedChatId, message: errorMsg });
        }
     });

      socket.on('open_chat', ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan buka chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[CHAT STATUS] Akses ditolak: Admin ${adminInfo?.username} mencoba membuka kembali chat.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa membuka kembali chat.' });
        }

        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat dengan ID tidak valid.`);
            return socket.emit('superadmin_error', { message: 'Chat ID tidak valid.' });
        }
        const encodedChatId = encodeFirebaseKey(normalizedChatId);
        const chatEntry = chatHistory[encodedChatId];

        if (!chatEntry) {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang tidak ditemukan di history.`);
             return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan.' });
        }

         if (chatEntry.status === 'open') {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang sudah terbuka.`);
              return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat sudah terbuka.' });
         }


        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} membuka kembali chat ${normalizedChatId}`);
        chatEntry.status = 'open'; // Update status di state backend

        saveChatHistoryToFirebase(); // Simpan perubahan status ke Firebase

        io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' }); // Beri tahu semua klien status terbaru
        socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0]} berhasil dibuka kembali.` });

     });


  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] Socket ${socket.id} terputus. Alasan: ${reason}`);
    // Cleanup state for the disconnected socket
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} state dibersihkan.`);
    }
    // cleanupAdminState already emits update_online_admins and initial_pick_status
  });

  // --- Other Socket Events (like auto complete) ---
  // "Auto Complete Chat" interpreted as "Mark as Closed" is covered by 'close_chat'
});


process.on('SIGINT', async () => {
  console.log('[SERVER] Menerima SIGINT (Ctrl+C). Membersihkan...');
   // Lakukan cleanup state untuk semua admin yang terhubung
   for (const socketId in adminSockets) {
       // Pastikan adminInfo valid sebelum cleanup
       const adminInfo = adminSockets[socketId];
       if(adminInfo) {
            cleanupAdminState(socketId); // Ini akan memicu update_online_admins dan initial_pick_status
       } else {
            // Jika adminSockets[socketId] tidak valid, hapus saja dari adminSockets
            delete adminSockets[socketId];
       }
   }
   // Clear usernameToSocketId map
    for(const username in usernameToSocketId) {
        delete usernameToSocketId[username];
    }


   if (sock) {
    console.log('[WA] Menutup koneksi WhatsApp...');
    // Gunakan reason yang jelas agar client tahu ini server shutdown
    sock.end(new Error('Server Shutdown'));
  }
  console.log('[SERVER] Server dimatikan.');
  process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[SERVER] Menerima SIGTERM. Membersihkan...');
    // Lakukan cleanup state untuk semua admin yang terhubung
    for (const socketId in adminSockets) {
         // Pastikan adminInfo valid sebelum cleanup
       const adminInfo = adminSockets[socketId];
       if(adminInfo) {
            cleanupAdminState(socketId); // Ini akan memicu update_online_admins dan initial_pick_status
       } else {
            // Jika adminSockets[socketId] tidak valid, hapus saja dari adminSockets
            delete adminSockets[socketId];
       }
    }
     // Clear usernameToSocketId map
    for(const username in usernameToSocketId) {
        delete usernameToSocketId[username];
    }

    if (sock) {
       console.log('[WA] Menutup koneksi WhatsApp...');
       // Gunakan reason yang jelas
       sock.end(new Error('Server Shutdown'));
    }
    console.log('[SERVER] Server dimatikan.');
    process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[ERROR] Unhandled Rejection:', err);
  // Decide if you want to exit here or try to recover
  // process.exit(1); // Uncomment to exit on unhandled rejection
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err);
   // Decide if you want to exit here or try to recover
  // process.exit(1); // Uncomment to exit on uncaught exception
});