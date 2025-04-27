// backend.js

import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } from 'baileys';
import express from 'express';
const expressApp = express({});
import http from 'http';
const server = http.createServer(expressApp);
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: "*", // Ganti dengan domain frontend spesifik Anda jika sudah production
        methods: ["GET", "POST"]
    }
});
import qrcode from 'qrcode-terminal';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import config from './config.js';
import { fileURLToPath } from 'url';

// SQLite Imports
import {
    initDatabase,
    closeDatabase,
    loadChatHistory,
    saveChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins,
    loadAdmins,
    saveQuickReplyTemplates, // Fungsi dari database.js untuk menyimpan ke DB
    loadQuickReplyTemplates, // Fungsi dari database.js untuk memuat dari DB
    getDb
} from './database.js';


// --- Konfigurasi & State ---
let admins = {};
let chatHistory = {};
let quickReplyTemplates = {}; // State backend: { shortcut: { id, shortcut, text } }

const adminSockets = {}; // socket ID -> { username: '...', role: '...' }
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId (normalized) -> username
const chatReleaseTimers = {}; // chatId (normalized) -> setTimeout ID
let reconnectTimer = null; // Timer untuk reconnect WhatsApp

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const superAdminUsername = config.superAdminUsername;

// Variabel state untuk koneksi WA (Baileys)
let sock; // Instance socket Baileys
let qrDisplayed = false; // Flag untuk menandai apakah QR sudah ditampilkan via kode kita
let currentQrCode = null; // Variabel untuk menyimpan QR code saat ini (string base64/URL)


// --- Logger ---
const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' });


// --- Fungsi Helper ---

// Memuat Data dari Database (History, Admins, Templates)
async function loadDataFromDatabase() {
    console.log("[DATABASE] Memuat data dari SQLite...");

    try {
        await initDatabase(); // Akan membuka koneksi jika belum ada

        console.log('[DATABASE] Mencoba memuat riwayat chat...');
        chatHistory = await loadChatHistory();
        console.log(`[DATABASE] Riwayat chat berhasil dimuat dari database. Total chat: ${Object.keys(chatHistory).length}`);

        console.log('[DATABASE] Mencoba memuat data admin...');
        const loadedAdmins = await loadAdmins();
        if (!loadedAdmins || Object.keys(loadedAdmins).length === 0) {
            console.warn('[DATABASE] Tidak ada data admin di database. Menggunakan dari config.js.');
            admins = config.admins || {};
            if (Object.keys(admins).length > 0) {
                console.log('[DATABASE] Menyimpan admin dari config.js ke database.');
                await saveAdmins(admins);
            } else {
                console.error('[DATABASE] TIDAK ADA DATA ADMIN DITEMUKAN DI CONFIG.JS ATAU DATABASE!');
            }
        } else {
            admins = loadedAdmins;
            console.log(`[DATABASE] Data admin berhasil dimuat dari database. Total admin: ${Object.keys(admins).length}`);
        }
        validateSuperAdmin(admins);

        console.log('[DATABASE] Mencoba memuat quick reply templates...');
        const loadedQuickReplyTemplates = await loadQuickReplyTemplates();
        quickReplyTemplates = loadedQuickReplyTemplates || {};
        if (Object.keys(quickReplyTemplates).length > 0) {
            console.log(`[DATABASE] ${Object.keys(quickReplyTemplates).length} quick reply templates berhasil dimuat dari database.`);
        } else {
            console.log('[DATABASE] Tidak ada quick reply templates di database.');
        }

    } catch (error) {
        console.error('[DATABASE] Gagal memuat data awal:', {
            message: error.message,
            stack: error.stack
        });
        throw error; // Lempar kembali error fatal
    }
}

function validateSuperAdmin(adminsData) {
    const superAdminsInDb = [];
    for (const [user, adminData] of Object.entries(adminsData)) {
        if (adminData?.role === 'superadmin') {
            superAdminsInDb.push(user);
        }
    }

    if (!adminsData[superAdminUsername] || adminsData[superAdminUsername].role !== 'superadmin') {
        console.warn(`[ADMIN] PERINGATAN: Super Admin username '${superAdminUsername}' yang dikonfigurasi tidak valid atau tidak memiliki role 'superadmin'.`);

        if (superAdminsInDb.length === 0) {
            console.error('[ADMIN] TIDAK ADA SUPER ADMIN DITEMUKAN DI DATABASE!');
             console.error('[ADMIN] Anda perlu menambah Super Admin secara manual ke database atau via script terpisah.');
        } else if (superAdminsInDb.length === 1) {
            console.warn(`[ADMIN] Super Admin aktif saat ini: '${superAdminsInDb[0]}'`);
        } else {
            console.warn(`[ADMIN] Beberapa Super Admin ditemukan: ${superAdminsInDb.join(', ')}`);
        }
    } else if (superAdminsInDb.length > 1) {
        console.warn(`[ADMIN] PERINGATAN: Beberapa Super Admin ditemukan, termasuk yang dikonfigurasi ('${superAdminUsername}').`);
    }
}


// Menyimpan Chat History ke Database (async, fire-and-forget)
async function saveChatHistoryToDatabase() {
    try {
        await saveChatHistory(chatHistory); // Gunakan objek chatHistory dari memory
        // console.log('[DATABASE] Riwayat chat berhasil disimpan ke database.'); // Verbose logging
    } catch (error) {
        console.error('[DATABASE] Gagal menyimpan riwayat chat ke database:', error);
        // Jangan lempar error
    }
}


// Menyimpan Quick Reply Templates ke Database DAN memberi tahu klien via Socket.IO
async function saveAndEmitQuickReplyTemplates(templates) {
    try {
        // Panggil fungsi save yang sebenarnya ada di database.js
        await saveQuickReplyTemplates(templates);
        console.log('[DATABASE] Quick reply templates berhasil disimpan ke database (via wrapper).');

        // Kirim data quick reply templates terbaru ke semua klien Socket.IO
        // Convert backend object state (templates) to array for frontend
        const quickReplyTemplatesArray = Object.values(templates); // Gunakan objek templates yang baru saja disimpan/diperbarui
        console.log(`[SOCKET] Mengirim update quick reply templates (${quickReplyTemplatesArray.length}) ke semua klien.`);
        io.emit('quick_reply_templates_updated', quickReplyTemplatesArray); // <-- EMIT EVENT BARU DI SINI

    } catch (error) {
        console.error('[DATABASE] Gagal menyimpan quick reply templates ke database (via wrapper):', error);
        throw error; // Lempar error agar handler socket bisa menangkapnya
    }
}


// Menghapus Chat History dari Database (fungsi diimport dari database.js)
// async function deleteChatHistory(chatId) { ... }

// Menghapus Semua Chat History dari Database (fungsi diimport dari database.js)
// async function deleteAllChatHistory() { ... }


// Membatalkan timer auto-release
function clearAutoReleaseTimer(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
   if (!normalizedChatId) return;

  if (chatReleaseTimers[normalizedChatId]) {
    clearTimeout(chatReleaseTimers[normalizedChatId]);
    delete chatReleaseTimers[normalizedChatId];
  }
}

// Memulai timer auto-release
function startAutoReleaseTimer(chatId, username) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) return;

  clearAutoReleaseTimer(normalizedChatId); // Bersihkan timer yang mungkin sudah ada

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
        io.emit('initial_pick_status', pickedChats);

        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
           io.to(targetSocketId).emit('auto_release_notification', { chatId: normalizedChatId, message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} dilepas otomatis (tidak aktif selama ${timeoutMinutes} menit).` });
        }

      } else {
          console.log(`[TIMER] Timer auto-release untuk ${normalizedChatId} oleh ${username} selesai, tetapi chat sudah tidak diambil oleh admin ini. Timer dibersihkan.`);
          delete chatReleaseTimers[normalizedChatId];
      }
    }, timeoutMs);
  }
}

// Mendapatkan daftar username admin yang sedang online
function getOnlineAdminUsernames() {
    return Object.values(adminSockets).map(adminInfo => adminInfo?.username).filter(Boolean);
}

// Mendapatkan info admin (termasuk role) berdasarkan Socket ID
function getAdminInfoBySocketId(socketId) {
    return adminSockets[socketId] && typeof adminSockets[socketId] === 'object' ? adminSockets[socketId] : null;
}

// Membersihkan state admin saat disconnect/logout
function cleanupAdminState(socketId) {
    const adminInfo = getAdminInfoBySocketId(socketId);
    if (adminInfo) {
        const username = adminInfo.username;
        console.log(`[ADMIN] Membersihkan state untuk admin ${username} (Socket ID: ${socketId})`);

        const chatsToRelease = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === username);
        for (const chatId of chatsToRelease) {
            clearAutoReleaseTimer(chatId);
            delete pickedChats[chatId];
            console.log(`[ADMIN] Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            io.emit('update_pick_status', { chatId: chatId, pickedBy: null });
        }

        delete adminSockets[socketId];
        delete usernameToSocketId[username];

        io.emit('update_online_admins', getOnlineAdminUsernames());
        io.emit('initial_pick_status', pickedChats);

        return username;
    }
    return null;
}

// Fungsi untuk memastikan chatId dalam format lengkap (normalized)
function normalizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null;

  const personalRegex = /^\d+@s\.whatsapp\.net$/;
  const groupRegex = /^\d+-\d+@g\.us$/;
  const broadcastRegex = /^\d+@broadcast$/;
  const statusRegex = /^status@broadcast$/;
  const otherValidCharsRegex = /^[a-zA-Z0-9._\-:]+$/;

  if (personalRegex.test(chatId) || groupRegex.test(chatId) || broadcastRegex.test(chatId) || statusRegex.test(chatId)) {
      return chatId;
  }

   const cleanedForNumberPatterns = chatId.replace(/^\+/, '').replace(/[^\d\-]/g, '');

    if(/^\d+$/.test(cleanedForNumberPatterns)) {
         return `${cleanedForNumberPatterns}@s.whatsapp.net`;
    }
     if(/^\d+-\d+$/.test(cleanedForNumberPatterns)) {
          return `${cleanedForNumberPatterns}@g.us`;
     }

    if (otherValidCharsRegex.test(chatId)) {
         console.warn(`[NORMALIZE] Chat ID tidak cocok pola standar tapi hanya berisi karakter valid JID. Mengembalikan apa adanya: ${chatId}`);
         return chatId;
    }

  console.warn(`[NORMALIZE] Chat ID format tidak dikenali dan tidak dapat dinormalisasi: ${chatId}`);
  return null;
}


// Fungsi untuk mengecek apakah admin adalah Super Admin
function isSuperAdmin(username) {
     return admins[username]?.role === 'superadmin';
}


// --- Setup Express & Server ---

const PORT = config.serverPort || 3000;

async function startApp() {
    try {
        await loadDataFromDatabase();
        console.log("[SERVER] Data database siap. Memulai koneksi WhatsApp dan Server HTTP.");

        connectToWhatsApp().catch(err => {
            console.error("[WA] Gagal memulai koneksi WhatsApp awal:", err);
        });

        await new Promise(resolve => {
            server.listen(PORT, () => {
                console.log(`[SERVER] Server Helpdesk berjalan di http://localhost:${PORT}`);
                console.log(`[SERVER] Versi Aplikasi: ${config.version || 'N/A'}`);
                resolve();
            });
        });

    } catch (err) {
        console.error("[SERVER] Gagal memuat data awal dari database. Server tidak dapat dimulai.", err);
        await closeDatabase().catch(dbErr => console.error('[DATABASE] Error closing DB after startup failure:', dbErr));
        process.exit(1);
    }
}

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

startApp().catch(err => {
     console.error("[SERVER] Error during application startup:", err);
     process.exit(1);
});


// --- Koneksi WhatsApp (Baileys) ---

async function connectToWhatsApp() {
  console.log("[WA] Mencoba menghubungkan ke WhatsApp...");
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    logger: logger,
    syncFullHistory: false,
    getMessage: async (key) => {
        return undefined;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isOnline, isConnecting } = update;

    if (qr && !qrDisplayed) {
      qrDisplayed = true;
      currentQrCode = qr;
      console.log('[WA] QR Code diterima, pindai dengan WhatsApp Anda.');
      qrcode.generate(qr, { small: true });
       const currentAdminSockets = { ...adminSockets };
       for (const socketId in currentAdminSockets) {
            if (Object.prototype.hasOwnProperty.call(currentAdminSockets, socketId) && currentAdminSockets[socketId]?.role === 'superadmin') {
                 if (io.sockets.sockets.get(socketId)) {
                    io.to(socketId).emit('whatsapp_qr', qr);
                 }
            }
       }
    }

    if (connection === 'close') {
      qrDisplayed = false;
      currentQrCode = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Unknown';
      const shouldReconnect = ![401, 403, 411, 419, 440].includes(statusCode);

      console.error(`[WA] Koneksi WhatsApp terputus: ${reason} (Code: ${statusCode || 'N/A'}), Mencoba menyambung kembali: ${shouldReconnect}`);
      io.emit('whatsapp_disconnected', { reason: reason, statusCode, message: reason });

      if (shouldReconnect) {
        console.log("[WA] Mencoba menyambung kembali dalam 10 detik...");
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectToWhatsApp, 10000);
      } else {
        console.error("[WA] Tidak dapat menyambung kembali otomatis. Mungkin sesi invalid atau konflik. Perlu scan ulang QR.");
        const fatalMessage = statusCode === 440
            ? 'Sesi digunakan di tempat lain. Tutup WhatsApp di perangkat lain atau scan ulang QR.'
            : 'Sesi invalid atau konflik. Silakan hubungi Super Admin untuk menampilkan QR untuk memulihkan (perlu scan ulang).';

        const currentAdminSockets = { ...adminSockets };
        for (const socketId in currentAdminSockets) {
             if (Object.prototype.hasOwnProperty.call(currentAdminSockets, socketId)) {
                 if (currentAdminSockets[socketId]?.role === 'superadmin') {
                     if (io.sockets.sockets.get(socketId)) {
                          io.to(socketId).emit('whatsapp_fatal_disconnected', { reason, statusCode, message: fatalMessage });
                     }
                 } else {
                      if (io.sockets.sockets.get(socketId)) {
                         io.to(socketId).emit('whatsapp_disconnected', { reason, statusCode, message: 'Koneksi WhatsApp terputus secara fatal. Hubungi Super Admin untuk memulihkan.' });
                      }
                 }
             }
        }
      }
    } else if (connection === 'open') {
      console.log('[WA] Berhasil terhubung ke WhatsApp!');
      qrDisplayed = false;
      currentQrCode = null;
      if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
      }
      io.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
    } else {
        console.log(`[WA] Status koneksi WhatsApp: ${connection} ${isConnecting ? '(connecting)' : ''} ${isOnline ? '(online)' : ''}`);
        if (connection === 'connecting') {
            io.emit('whatsapp_connecting', {});
        }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
      if (message.key.fromMe || message.key.remoteJid === 'status@broadcast' || (sock?.user?.id && message.key.remoteJid === sock.user.id)) {
        continue;
      }

      const chatId = normalizeChatId(message.key.remoteJid);
       if (!chatId) {
           console.error('[WA] Invalid chatId received:', message.key.remoteJid);
           continue;
       }

      const dbChatId = chatId;

      let messageContent = null;
      let mediaData = null;
      let mediaType = null;
      let mimeType = null;
      let fileName = null;
      let messageTextSnippet = '';

      const messageBaileysType = message.message ? Object.keys(message.message)[0] : null;
      const messageProps = message.message?.[messageBaileysType];

       switch (messageBaileysType) {
           case 'conversation':
           case 'extendedTextMessage':
               messageContent = messageProps?.text || messageProps?.conversation || '';
               messageTextSnippet = messageContent.substring(0, 100) + (messageContent.length > 100 ? '...' : '');
               mediaType = 'text';
               break;
           case 'imageMessage':
           case 'videoMessage':
           case 'audioMessage':
           case 'documentMessage':
           case 'stickerMessage':
               mediaType = messageBaileysType;
               mimeType = messageProps?.mimetype;
               fileName = messageProps?.fileName || messageProps?.caption || `${mediaType.replace('Message', '')}_file`;
               if (mediaType === 'audioMessage' && messageProps?.ptt) fileName = 'Voice Note';

               messageContent = messageProps?.caption || `[${mediaType.replace('Message', '')}]`;
               messageTextSnippet = messageProps?.caption ? messageProps.caption.substring(0, 100) + (messageProps.caption.length > 100 ? '...' : '') : `[${mediaType.replace('Message', '')}]`;

               try {
                 const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
                 if (buffer) {
                     mediaData = buffer.toString('base64');
                 } else {
                     console.warn(`[WA] Gagal mengunduh media (buffer kosong) dari ${chatId} untuk pesan ${message.key.id}`);
                     messageContent = `[Gagal mengunduh media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                     messageTextSnippet = `[Gagal unduh media ${mediaType.replace('Message', '')}]`;
                     mediaData = null;
                 }
               } catch (error) {
                 console.error(`[WA] Error mengunduh media dari ${chatId} untuk pesan ${message.key.id}:`, error);
                 messageContent = `[Gagal memuat media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                 messageTextSnippet = `[Error media ${mediaType.replace('Message', '')}]`;
                 mediaData = null;
               }
               break;
            case 'locationMessage':
                messageContent = `[Lokasi: ${messageProps?.degreesLatitude}, ${messageProps?.degreesLongitude}]`;
                messageTextSnippet = '[Lokasi]';
                mediaType = 'location';
                break;
            case 'contactMessage':
                messageContent = `[Kontak: ${messageProps?.displayName || 'Nama tidak diketahui'}]`;
                 messageTextSnippet = `[Kontak]`;
                 mediaType = 'contact';
                 break;
            case 'liveLocationMessage':
                 messageContent = '[Live Lokasi]';
                 messageTextSnippet = '[Live Lokasi]';
                 mediaType = 'liveLocation';
                 break;
            case 'protocolMessage':
            case 'reactionMessage':
            case 'senderKeyDistributionMessage':
            case 'editedMessage':
            case 'keepalive':
                 continue;
            default:
                console.warn(`[WA] Menerima pesan dengan tipe tidak dikenal atau tidak ditangani: ${messageBaileysType || 'N/A'} dari ${chatId}`);
                messageContent = `[Pesan tidak dikenal: ${messageBaileysType || 'N/A'}]`;
                messageTextSnippet = `[${messageBaileysType || 'Unknown'}]`;
                mediaType = 'unknown';
       }

      const messageData = {
        id: message.key.id,
        chatId: chatId,
        from: chatId,
        text: messageContent || null,
        mediaData: mediaData,
        mediaType: mediaType,
        mimeType: mimeType,
        fileName: fileName,
        snippet: messageTextSnippet || null,
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        unread: true,
        type: 'incoming'
      };

      if (!chatHistory[dbChatId] || !Array.isArray(chatHistory[dbChatId].messages)) {
        console.log(`[HISTORY] Membuat/memperbaiki entri baru untuk chat ${chatId}.`);
        chatHistory[dbChatId] = { status: chatHistory[dbChatId]?.status || 'open', messages: [] };
      }
       if (!chatHistory[dbChatId].status) {
           chatHistory[dbChatId].status = 'open';
       }

      if (!chatHistory[dbChatId].messages.some(m => m && typeof m === 'object' && m.id === messageData.id)) {
        console.log(`[HISTORY] Menambahkan pesan masuk baru (ID: ${messageData.id}) ke chat ${chatId}`);
        chatHistory[dbChatId].messages.push(messageData);
        saveChatHistoryToDatabase();

        io.emit('new_message', {
             ...messageData,
             chatId: chatId,
             chatStatus: chatHistory[dbChatId].status
         });

        const pickedBy = pickedChats[chatId];
        const onlineAdmins = getOnlineAdminUsernames();
        onlineAdmins.forEach(adminUsername => {
            const adminSocketId = usernameToSocketId[adminUsername];
            if (adminSocketId && pickedBy !== adminUsername && chatHistory[dbChatId].status === 'open') {
                if (io.sockets.sockets.get(adminSocketId)) {
                      const notificationBody = messageTextSnippet || '[Pesan Baru]';
                     io.to(adminSocketId).emit('notification', {
                        title: `Pesan Baru (${chatId.split('@')[0] || chatId})`,
                        body: notificationBody,
                        icon: '/favicon.ico',
                        chatId: chatId
                     });
                }
            }
        });

      } else {
         // console.log(`[WA] Duplicate message detected in upsert (ID: ${messageData.id}), ignored.`);
      }
    }
  });

}


// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`[SOCKET] Admin terhubung: ${socket.id}`);

  // --- START: PENGECEKAN DEFENSIF SAAT KONEKSI AWAL ---
  // Memastikan variabel WA Baileys sudah terdefinisi sebelum mengirim status awal
  if (sock === undefined || qrDisplayed === undefined || currentQrCode === undefined) {
       console.warn(`[SOCKET] Early connection (${socket.id}) received before WA variables fully initialized. Deferring initial status update.`);
       // Kirim status connecting yang aman dan biarkan WA event handler mengupdate nanti
       socket.emit('whatsapp_connecting', { message: 'Menunggu status WhatsApp...' });
       // Masih kirim data awal lain yang tidak bergantung pada state WA
       socket.emit('registered_admins', admins);
       io.emit('update_online_admins', getOnlineAdminUsernames());
       socket.emit('initial_pick_status', pickedChats);
       io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Tetap kirim template

       return; // Keluar dari handler ini
  }
  // --- END: PENGECEKAN DEFENSIF ---


  // Jika pengecekan di atas lolos, lanjutkan dengan logika pengiriman status WA awal yang lebih detail

  // Kirim data awal yang diperlukan segera setelah koneksi (admins, status online, pick, template)
  socket.emit('registered_admins', admins);
  io.emit('update_online_admins', getOnlineAdminUsernames());
  socket.emit('initial_pick_status', pickedChats);
  io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Kirim template sebagai array


  // Kirim status WhatsApp saat ini pada koneksi
  if (sock?.ws?.readyState === sock.ws.OPEN) {
       socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
  } else if (sock?.ws?.readyState === sock.ws.CONNECTING) {
       socket.emit('whatsapp_connecting', {});
  } else if (qrDisplayed && currentQrCode) {
       socket.emit('whatsapp_fatal_disconnected', { message: 'Sesi invalid. Menunggu QR Code baru...' });
       if (getAdminInfoBySocketId(socket.id)?.role === 'superadmin') {
           socket.emit('whatsapp_qr', currentQrCode);
       }
  }
   else {
       socket.emit('whatsapp_disconnected', { reason: 'Not Connected', statusCode: 'N/A', message: 'Koneksi WhatsApp belum siap atau terputus.' });
  }


  socket.on('request_initial_data', () => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (adminInfo) {
      console.log(`[SOCKET] Admin ${adminInfo.username} meminta data awal.`);
      const chatHistoryForClient = {};
      for (const chatId in chatHistory) {
         if (!Object.prototype.hasOwnProperty.call(chatHistory, chatId)) continue;

        const chatEntry = chatHistory[chatId];
         if (chatEntry && Array.isArray(chatEntry.messages)) {
            chatHistoryForClient[chatId] = {
                status: chatEntry.status || 'open',
                messages: chatEntry.messages.map((message) => ({
                    ...message,
                    chatId: chatId
                }))
            };
         } else if (chatEntry) {
              chatHistoryForClient[chatId] = {
                   status: chatEntry.status || 'open',
                   messages: []
               };
              console.warn(`[SOCKET] Chat history untuk ${chatId} memiliki struktur pesan tidak valid.`);
         }
      }
       // Kirim data awal termasuk chat history, admin, role, dan template balasan cepat (sebagai array)
      socket.emit('initial_data', {
          chatHistory: chatHistoryForClient,
          admins: admins,
          currentUserRole: adminInfo.role,
          quickReplies: Object.values(quickReplyTemplates) // Kirim template sebagai array
      });
    } else {
      console.warn(`[SOCKET] Socket ${socket.id} meminta data awal sebelum login.`);
    }
  });

  socket.on('get_chat_history', (chatId) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[SOCKET] Socket ${socket.id} meminta history sebelum login.`);
        return socket.emit('chat_history_error', { chatId, message: 'Login diperlukan.' });
    }
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) {
         console.warn(`[SOCKET] Admin ${adminInfo?.username} meminta history dengan ID chat tidak valid: ${chatId}`);
         return socket.emit('chat_history_error', { chatId, message: 'Chat ID tidak valid.' });
    }

    const chatEntry = chatHistory[normalizedChatId];
    const history = Array.isArray(chatEntry?.messages) ? chatEntry.messages.map((message) => ({
      ...message,
      chatId: normalizedChatId
    })) : [];
    const status = chatEntry?.status || 'open';

    console.log(`[SOCKET] Mengirim history untuk chat ${normalizedChatId} (${history.length} pesan) ke admin ${adminInfo.username}.`);
    socket.emit('chat_history', { chatId: normalizedChatId, messages: history, status: status });
  });

  socket.on('admin_login', ({ username, password }) => {
      console.log(`[ADMIN] Menerima percobaan login untuk: ${username}`);
    const adminUser = admins[username];
    if (adminUser && adminUser.password === password) { // (CONSIDER HASHING PASSWORDS)
      const existingSocketId = usernameToSocketId[username];
      if (existingSocketId && io.sockets.sockets.get(existingSocketId)) {
         console.warn(`[ADMIN] Login gagal: Admin ${username} sudah login dari socket ${existingSocketId}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain.' });
         return;
      }
       if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
            console.log(`[ADMIN] Admin ${username} login. Membersihkan state socket lama ${existingSocketId} yang sudah tidak aktif.`);
            cleanupAdminState(existingSocketId);
       }

      console.log(`[ADMIN] Login berhasil: ${username} (Socket ID: ${socket.id})`);
      adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
      usernameToSocketId[username] = socket.id;

      socket.emit('login_success', { username: username, initials: adminUser.initials, role: adminUser.role || 'admin', currentPicks: pickedChats });
      io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Emit templates
      io.emit('update_online_admins', getOnlineAdminUsernames());

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
        if (existingSocketId && existingSocketId !== socket.id && io.sockets.sockets.get(existingSocketId)) {
             console.warn(`[ADMIN] Admin ${username} mereconnect. Menutup socket lama ${existingSocketId}.`);
             cleanupAdminState(existingSocketId);
             setTimeout(() => {
                  const oldSocket = io.sockets.sockets.get(existingSocketId);
                  if (oldSocket) {
                       try {
                           oldSocket.disconnect(true);
                           console.log(`[ADMIN] Socket lama ${existingSocketId} disconnected.`);
                       } catch (e) {
                           console.error(`[ADMIN] Error disconnecting old socket ${existingSocketId}:`, e);
                       }
                  } else {
                      console.log(`[ADMIN] Old socket ${existingSocketId} already gone.`);
                  }
             }, 100);
        } else if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
             console.log(`[ADMIN] Admin ${username} mereconnect. Socket lama ${existingSocketId} sudah tidak aktif. Membersihkan state lama.`);
              cleanupAdminState(usernameToSocketId[username]);
        }

        console.log(`[ADMIN] Reconnect berhasil untuk ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
        usernameToSocketId[username] = socket.id;

        socket.emit('reconnect_success', { username: username, currentPicks: pickedChats, role: adminUser.role || 'admin' });
        io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Emit templates
        io.emit('update_online_admins', getOnlineAdminUsernames());

    } else {
        console.warn(`[ADMIN] Reconnect failed: Admin ${username} not found in registered admins.`);
        socket.emit('reconnect_failed');
    }
  });


  socket.on('admin_logout', () => {
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} logout dari socket ${socket.id}.`);
        socket.emit('clear_cache');
        socket.emit('logout_success');
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

    const pickedBy = pickedChats[normalizedChatId];
    const chatEntry = chatHistory[normalizedChatId];
     if (chatEntry?.status === 'closed') {
         console.warn(`[PICK] Admin ${username} mencoba mengambil chat tertutup ${normalizedChatId}`);
         return socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa diambil.' });
     }
      if (!chatEntry) {
          console.warn(`[PICK] Admin ${username} mengambil chat baru ${normalizedChatId} yang belum ada di history state.`);
           chatHistory[normalizedChatId] = { status: 'open', messages: [] };
           saveChatHistoryToDatabase();
      }

    if (pickedBy && pickedBy !== username) {
      console.warn(`[PICK] Admin ${username} mencoba mengambil chat ${normalizedChatId} yang sudah diambil oleh ${pickedBy}`);
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedBy}.` });
    } else {
      pickedChats[normalizedChatId] = username;
      console.log(`[PICK] Admin ${username} mengambil/mereset pick chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username });
      io.emit('initial_pick_status', pickedChats);

      if (config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(normalizedChatId, username);
      }

       const updatedChatEntry = chatHistory[normalizedChatId];
       if (updatedChatEntry?.messages) {
           let changed = false;
           for (let i = updatedChatEntry.messages.length - 1; i >= 0; i--) {
                if (!updatedChatEntry.messages[i] || typeof updatedChatEntry.messages[i] !== 'object') continue;

                if (updatedChatEntry.messages[i].type === 'incoming' && updatedChatEntry.messages[i].unread) {
                    updatedChatEntry.messages[i].unread = false;
                    changed = true;
                } else if (updatedChatEntry.messages[i].type === 'outgoing') {
                    break;
                }
           }
           if (changed) {
               console.log(`[MARK] Menandai pesan masuk sebagai dibaca untuk chat ${normalizedChatId} oleh ${adminInfo.username}.`);
               saveChatHistoryToDatabase();
               io.emit('update_chat_read_status', { chatId: normalizedChatId });
           }
       }
    }
  });

  socket.on('unpick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
     const username = adminInfo.username;
     const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    const pickedBy = pickedChats[normalizedChatId];
    if (pickedBy === username || isSuperAdmin(username)) {
        if (pickedBy) {
            clearAutoReleaseTimer(normalizedChatId);
            delete pickedChats[normalizedChatId];
            console.log(`[PICK] Admin ${username} melepas chat ${normalizedChatId}`);
            io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
             io.emit('initial_pick_status', pickedChats);
            socket.emit('pick_success', { chatId: normalizedChatId, pickedBy: null, message: 'Chat berhasil dilepas.' });
        } else {
            console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil.`);
             socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
        }
    } else if (pickedBy) {
       console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang diambil oleh ${pickedBy}. Akses ditolak.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedBy} atau Super Admin yang bisa melepas chat ini.` });
    } else {
          if (isSuperAdmin(username)) {
              console.log(`[PICK] Super Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil. Membersihkan timer jika ada.`);
              clearAutoReleaseTimer(normalizedChatId);
              socket.emit('pick_success', { chatId: normalizedChatId, pickedBy: null, message: 'Chat berhasil dilepas (tidak diambil oleh siapa pun).' });
          } else {
               socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
          }
    }
  });

  socket.on('delegate_chat', async ({ chatId, targetAdminUsername }) => {
      console.log(`[DELEGATE] Permintaan delegasi chat ${chatId} ke ${targetAdminUsername}`);
      const adminInfo = getAdminInfoBySocketId(socket.id);
      if (!adminInfo) {
          console.warn(`[DELEGATE] Socket ${socket.id} mencoba delegasi sebelum login.`);
          return socket.emit('delegate_error', { chatId, message: 'Login diperlukan.' });
      }
      const senderAdminUsername = adminInfo.username;

      const normalizedChatId = normalizeChatId(chatId);
      if (!normalizedChatId) {
           console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi dengan ID chat tidak valid: ${chatId}.`);
           return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat ID tidak valid.' });
      }

      if (!targetAdminUsername || typeof targetAdminUsername !== 'string' || targetAdminUsername.trim().length === 0) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi dengan target admin tidak valid.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Username admin target tidak valid.' });
      }

      const currentPickedBy = pickedChats[normalizedChatId];
      if (currentPickedBy !== senderAdminUsername && !isSuperAdmin(senderAdminUsername)) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi chat ${normalizedChatId} yang diambil oleh ${currentPickedBy || 'tidak ada'}. Akses ditolak.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: currentPickedBy ? `Chat ini sedang ditangani oleh ${currentPickedBy}.` : 'Chat ini belum diambil oleh Anda.' });
      }
      if (senderAdminUsername === targetAdminUsername) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke diri sendiri.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      }
      const targetAdminInfo = admins[targetAdminUsername];
      if (!targetAdminInfo) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke admin target tidak dikenal: ${targetAdminUsername}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: `Admin target '${targetAdminUsername}' tidak ditemukan.` });
      }

      const chatEntry = chatHistory[normalizedChatId];
      if (chatEntry?.status === 'closed') {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan chat tertutup ${normalizedChatId}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa didelegasikan.' });
      }
      if (!chatEntry) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat baru ${normalizedChatId} yang belum ada di history state.`);
           chatHistory[normalizedChatId] = { status: 'open', messages: [] };
           saveChatHistoryToDatabase();
      }

      console.log(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId);
      pickedChats[normalizedChatId] = targetAdminUsername;

      if (config.chatAutoReleaseTimeoutMinutes > 0) {
          startAutoReleaseTimer(normalizedChatId, targetAdminUsername);
      }

      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername });
      io.emit('initial_pick_status', pickedChats);

      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
          });
      } else {
           console.warn(`[DELEGATE] Target admin ${targetAdminUsername} offline atau socket terputus, tidak mengirim notifikasi delegasi via Socket.IO.`);
           socket.emit('delegate_info', { chatId: normalizedChatId, targetAdminUsername, message: `Chat berhasil didelegasikan ke ${targetAdminUsername}, tetapi admin tersebut sedang offline.` });
      }

      socket.emit('delegate_success', { chatId: normalizedChatId, targetAdminUsername, message: `Chat berhasil didelegasikan ke ${targetAdminUsername}.` });
  });


  socket.on('reply_message', async ({ to, text, media }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[REPLY] Socket ${socket.id} mencoba kirim pesan sebelum login.`);
        return socket.emit('send_error', { to: to, text, message: 'Login diperlukan.' });
    }
    const username = adminInfo.username;

    const chatId = normalizeChatId(to);
    if (!chatId || (!text?.trim() && !media?.data)) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan dengan data tidak lengkap atau ID chat tidak valid.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Data tidak lengkap (ID chat, teks, atau media kosong) atau ID chat tidak valid.' });
    }
    if (!sock || sock.ws?.readyState !== sock.ws.OPEN) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan, tapi koneksi WA tidak siap.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Koneksi WhatsApp belum siap. Silakan coba lagi nanti.' });
    }

    const pickedBy = pickedChats[chatId];
    const canReply = pickedBy === username || isSuperAdmin(username);

    if (!canReply) {
         const errorMsg = pickedBy ? `Sedang ditangani oleh ${pickedBy}. Ambil alih chat ini terlebih dahulu.` : 'Ambil chat ini terlebih dahulu.';
         console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat ${chatId}. Akses ditolak: ${errorMsg}`);
        return socket.emit('send_error', { to: chatId, text, message: errorMsg });
    }

     const chatEntry = chatHistory[chatId];
     if (chatEntry?.status === 'closed') {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat tertutup ${chatId}.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Chat sudah ditutup. Tidak bisa mengirim balasan.' });
    }
     if (!chatEntry) {
          console.log(`[REPLY] Admin ${username} mengirim pesan ke chat baru ${chatId} yang belum ada di history state.`);
          chatHistory[chatId] = { status: 'open', messages: [] };
      }

    try {
      const adminInfoFromAdmins = admins[username];
      const adminInitials = (adminInfoFromAdmins?.initials || username.substring(0, 3).toUpperCase()).substring(0,3);

      const textContent = text?.trim() || '';
      const textForSendingToWA = textContent.length > 0
        ? `${textContent}\n\n-${adminInitials}`
        : (media ? `-${adminInitials}` : '');


      let sentMsgResult;
      let sentMediaType = null;
      let sentMimeType = null;
      let sentFileName = null;
      let sentTextContentForHistory = textContent;

      if (media) {
        if (!media.data || !media.type) {
             console.error(`[REPLY] Media data atau type kosong untuk chat ${chatId}`);
             return socket.emit('send_error', { to: chatId, text, media, message: 'Data media tidak valid.' });
        }
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const mediaMimeType = media.mimeType || media.type;

        const mediaOptions = {
          mimetype: mediaMimeType,
          fileName: media.name || 'file',
          caption: textForSendingToWA.length > 0 ? textForSendingToWA : undefined
        };

        console.log(`[WA] Mengirim media (${mediaMimeType}) ke ${chatId} oleh ${username}...`);

        if (media.type.startsWith('image/')) {
             sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, ...mediaOptions });
             sentMediaType = 'imageMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        } else if (media.type.startsWith('video/')) {
             sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, ...mediaOptions });
             sentMediaType = 'videoMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        } else if (media.type.startsWith('audio/')) {
           const isVoiceNote = mediaOptions.mimetype === 'audio/ogg; codecs=opus' || mediaOptions.mimetype === 'audio/mpeg' || mediaOptions.mimetype === 'audio/wav' || media.isVoiceNote;

            if (isVoiceNote) {
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: true });
                 sentMediaType = 'audioMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = 'Voice Note';
                 if (textContent.length > 0) {
                     console.log(`[WA] Mengirim teks caption VN terpisah ke ${chatId}`);
                     await sock.sendMessage(chatId, { text: `-${adminInitials}: ${textContent}` });
                 }
            } else {
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: false, caption: mediaOptions.caption });
                 sentMediaType = 'audioMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
            }

        } else if (media.type === 'application/pdf' || media.type.startsWith('application/') || media.type.startsWith('text/')) {
             sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, ...mediaOptions });
              sentMediaType = 'documentMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        }
        else {
          console.warn(`[REPLY] Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to: chatId, text, media, message: 'Tipe media tidak didukung.' });
          return;
        }

      } else {
        if (textForSendingToWA.trim().length > 0) {
           console.log(`[WA] Mengirim teks ke ${chatId} oleh ${username}...`);
           sentMsgResult = await sock.sendMessage(chatId, { text: textForSendingToWA });
            sentMediaType = 'conversation';
            sentMimeType = 'text/plain';
            sentFileName = null;
        } else {
            console.warn(`[REPLY] Admin ${username} mencoba kirim pesan kosong (hanya spasi?).`);
            socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten untuk dikirim.' });
            return;
        }
      }

      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('[WA] sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.', sentMsgResult);
          socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          return;
      }

      const outgoingMessageData = {
        id: sentMsg.key.id,
        chatId: chatId,
        from: username,
        text: sentTextContentForHistory || null,
        mediaType: sentMediaType,
        mimeType: sentMimeType,
        mediaData: media?.data || null,
        fileName: sentFileName,
        initials: adminInitials,
        timestamp: sentMsg.messageTimestamp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        type: 'outgoing',
        unread: false,
        snippet: sentTextContentForHistory?.substring(0, 100) + (sentTextContentForHistory?.length > 100 ? '...' : '') || sentFileName || `[${sentMediaType?.replace('Message', '') || 'Media'}]`
      };

      const dbChatId = chatId;

      if (!chatHistory[dbChatId] || !Array.isArray(chatHistory[dbChatId].messages)) {
           console.log(`[HISTORY] Membuat/memperbaiki entri chat ${chatId} untuk pesan keluar.`);
           chatHistory[dbChatId] = { status: chatHistory[dbChatId]?.status || 'open', messages: [] };
       }

       if (!chatHistory[dbChatId].messages.some(m => m && typeof m === 'object' && m.id === outgoingMessageData.id)) {
         console.log(`[HISTORY] Menambahkan pesan keluar baru (ID: ${outgoingMessageData.id}) ke chat ${chatId}`);
         chatHistory[dbChatId].messages.push(outgoingMessageData);
         saveChatHistoryToDatabase();
       } else {
           console.warn(`[HISTORY] Pesan keluar duplikat terdeteksi (ID: ${outgoingMessageData.id}), diabaikan penambahannya ke history state.`);
       }

      io.emit('new_message', {
          ...outgoingMessageData,
          chatId: chatId,
          chatStatus: chatHistory[dbChatId]?.status || 'open'
      });

      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.chatId
      });

      if (pickedChats[chatId] === username && config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(chatId, username);
      }

    } catch (error) {
      console.error(`[REPLY] Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      socket.emit('send_error', { to: chatId, text: textContent, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  socket.on('mark_as_read', ({ chatId }) => {
     const adminInfo = getAdminInfoBySocketId(socket.id);
     if (!adminInfo || !chatId || typeof chatId !== 'string') {
         console.warn(`[SOCKET] Permintaan mark_as_read tanpa login atau chat ID: Socket ${socket.id}`);
         return;
     }

     const normalizedChatId = normalizeChatId(chatId);
     if (!normalizedChatId) {
          console.warn(`[SOCKET] Admin ${adminInfo?.username} mencoba mark_as_read dengan ID chat tidak valid: ${chatId}`);
          return;
     }

     const dbChatId = normalizedChatId;

     const pickedBy = pickedChats[normalizedChatId];
     if (isSuperAdmin(adminInfo.username) || pickedBy === adminInfo.username) {
         const chatEntry = chatHistory[dbChatId];
         if (chatEntry?.messages) {
              let changed = false;
              for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                   if (!chatEntry.messages[i] || typeof chatEntry.messages[i] !== 'object') continue;

                   if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                       chatEntry.messages[i].unread = false;
                       changed = true;
                   } else if (chatEntry.messages[i].type === 'outgoing') {
                        break;
                   }
              }
              if (changed) {
                  console.log(`[MARK] Menandai pesan masuk sebagai dibaca untuk chat ${normalizedChatId} oleh ${adminInfo.username}.`);
                  saveChatHistoryToDatabase();
                  io.emit('update_chat_read_status', { chatId: normalizedChatId });
              }
         } else {
             console.warn(`[MARK] Chat ${normalizedChatId} not found in state or has no messages to mark as read.`);
         }
     } else {
         console.warn(`[MARK] Admin ${adminInfo.username} attempted mark_as_read on chat ${normalizedChatId} not handled by them. Access denied.`);
     }
   });

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

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus chat history untuk ${normalizedChatId}`);

        if (chatHistory[normalizedChatId]) {
            delete chatHistory[normalizedChatId];
            if (pickedChats[normalizedChatId]) {
                clearAutoReleaseTimer(normalizedChatId);
                delete pickedChats[normalizedChatId];
            }

            try {
                const success = await deleteChatHistory(normalizedChatId);

                if (success) {
                    io.emit('chat_history_deleted', { chatId: normalizedChatId });
                    io.emit('initial_pick_status', pickedChats);
                    socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dihapus.` });
                } else {
                     // Chat not found in DB but was in state. Log warning, proceed as deleted from state perspective.
                     console.warn(`[SUPERADMIN] Chat ${normalizedChatId} not found in DB for deletion, but removed from state.`);
                     io.emit('chat_history_deleted', { chatId: normalizedChatId });
                     io.emit('initial_pick_status', pickedChats);
                     socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dihapus (dari state).` });
                }
            } catch (error) {
                 console.error(`[SUPERADMIN] Gagal menghapus chat ${normalizedChatId} dari database:`, error);
                 // Attempt to restore state if DB delete failed? Complex. Just report error.
                 socket.emit('superadmin_error', { message: 'Gagal menghapus chat dari database.' });
            }
        } else {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus chat ${normalizedChatId} yang tidak ditemukan di state.`);
             socket.emit('superadmin_error', { message: 'Chat tidak ditemukan dalam history state.' });
        }
    });

     socket.on('delete_all_chats', async () => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus semua chat.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus semua chat.' });
        }

         console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus SEMUA chat history.`);

         const chatIdsWithTimers = Object.keys(chatReleaseTimers);
         if (chatIdsWithTimers.length > 0) {
              console.log(`[TIMER] Membersihkan ${chatIdsWithTimers.length} timer auto-release tersisa sebelum menghapus semua chat history...`);
              for (const chatId of [...chatIdsWithTimers]) {
                   clearAutoReleaseTimer(chatId);
              }
         }
         Object.keys(pickedChats).forEach(key => delete pickedChats[key]);

         chatHistory = {}; // Reset state

         try {
            const success = await deleteAllChatHistory();

            if (success) {
                io.emit('all_chat_history_deleted');
                io.emit('initial_pick_status', pickedChats);
                socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus.' });
            } else {
                 console.error(`[SUPERADMIN] Gagal menghapus semua chat dari database.`);
                 socket.emit('superadmin_error', { message: 'Gagal menghapus semua chat dari database.' });
            }
         } catch (error) {
             console.error(`[SUPERADMIN] Error menghapus semua chat dari database:`, error);
             socket.emit('superadmin_error', { message: 'Error saat menghapus semua chat dari database.' });
         }
     });

     socket.on('add_admin', async ({ username, password, initials, role }) => {
        console.log(`[SUPERADMIN] Menerima permintaan tambah admin: ${username}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah admin.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menambah admin.' });
        }

        if (!username?.trim() || !password?.trim() || !initials?.trim()) { // Added trim() and optional chaining
             console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} data tidak lengkap.`);
            return socket.emit('superadmin_error', { message: 'Username, password, dan initials harus diisi.' });
        }
         const cleanedInitials = initials.trim().toUpperCase();
         if (cleanedInitials.length === 0 || cleanedInitials.length > 3 || !/^[A-Z]+$/.test(cleanedInitials)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} initials tidak valid: '${initials}'.`);
              return socket.emit('superadmin_error', { message: 'Initials harus 1-3 karakter huruf A-Z.' });
         }

        if (admins[username]) {
            console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menambah admin '${username}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Admin dengan username '${username}' sudah ada.` });
        }
         const validRoles = ['admin', 'superadmin'];
         if (!role || typeof role !== 'string' || !validRoles.includes(role)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} role tidak valid: ${role}`);
              return socket.emit('superadmin_error', { message: 'Role admin tidak valid. Gunakan "admin" atau "superadmin".' });
         }
         if (role === 'superadmin' && !isSuperAdmin(adminInfo.username)) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} (role ${adminInfo.role}) mencoba menambah admin dengan role 'superadmin'. Akses ditolak.`);
              return socket.emit('superadmin_error', { message: 'Hanya Super Admin yang bisa membuat Super Admin baru.' });
         }

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menambah admin baru: ${username} (${role})`);

         const updatedAdmins = {
            ...admins,
             [username]: {
                 password: password,
                 initials: cleanedInitials,
                 role: role
             }
         };

        try {
            await saveAdmins(updatedAdmins);
            admins = updatedAdmins; // Update state HANYA jika save DB berhasil
            console.log('[SUPERADMIN] State admin dan DB berhasil diupdate.');
            io.emit('registered_admins', admins);
            socket.emit('superadmin_success', { message: `Admin '${username}' berhasil ditambahkan.` });
        } catch (error) {
             console.error('[SUPERADMIN] Gagal menyimpan admin setelah menambah:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan data admin '${username}' ke database.` });
        }
     });

      socket.on('delete_admin', async ({ usernameToDelete }) => {
          console.log(`[SUPERADMIN] Menerima permintaan hapus admin: ${usernameToDelete}`);
          const adminInfo = getAdminInfoBySocketId(socket.id);
          if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
              console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus admin.`);
              return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus admin.' });
          }

          if (!usernameToDelete?.trim()) { // Added trim() and optional chaining
               console.warn(`[SUPERADMIN] Permintaan hapus admin dari ${adminInfo.username} data tidak lengkap.`);
              return socket.emit('superadmin_error', { message: 'Username admin yang akan dihapus tidak valid.' });
          }
          if (usernameToDelete === adminInfo.username) {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus akun sendiri.`);
              return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus akun Anda sendiri.' });
          }
           const superAdminsList = Object.keys(admins).filter(user => admins[user]?.role === 'superadmin');
           if (superAdminsList.length <= 1 && superAdminsList.includes(usernameToDelete)) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus Super Admin terakhir: ${usernameToDelete}`);
               return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus Super Admin terakhir. Harus ada minimal satu Super Admin.' });
           }

          if (!admins[usernameToDelete]) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus admin '${usernameToDelete}' yang tidak ditemukan.`);
               return socket.emit('superadmin_error', { message: `Admin dengan username '${usernameToDelete}' tidak ditemukan.` });
          }

          console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus admin: ${usernameToDelete}`);

           const targetSocketId = usernameToSocketId[usernameToDelete];
           if(targetSocketId && io.sockets.sockets.get(targetSocketId)) {
                console.log(`[SUPERADMIN] Admin ${usernameToDelete} online, membersihkan state dan memutuskan koneksi socket ${targetSocketId}.`);
                cleanupAdminState(targetSocketId);
                 try {
                     io.sockets.sockets.get(targetSocketId).disconnect(true);
                 } catch (e) {
                     console.error(`[SUPERADMIN] Error disconnecting socket ${targetSocketId} for deleted admin ${usernameToDelete}:`, e);
                 }
           } else if (usernameToSocketId[usernameToDelete]) {
                console.log(`[SUPERADMIN] Admin ${usernameToDelete} offline atau socket sudah hilang. Membersihkan state.`);
                // Manual cleanup if socketId was recorded but socket is gone
                 const chatsPickedByDeletedAdmin = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === usernameToDelete);
                 chatsPickedByDeletedAdmin.forEach(chatId => {
                    clearAutoReleaseTimer(chatId);
                    delete pickedChats[chatId];
                    console.log(`[ADMIN] Chat ${chatId} dilepas karena admin ${usernameToDelete} dihapus.`);
                    io.emit('update_pick_status', { chatId: chatId, pickedBy: null });
                 });
                  delete usernameToSocketId[usernameToDelete]; // Clean up username mapping

                io.emit('update_online_admins', getOnlineAdminUsernames());
                io.emit('initial_pick_status', pickedChats);
           } else {
               console.log(`[SUPERADMIN] Admin ${usernameToDelete} tidak online. Melanjutkan penghapusan.`);
           }

           const updatedAdmins = { ...admins };
           delete updatedAdmins[usernameToDelete];

           try {
               await saveAdmins(updatedAdmins);
               admins = updatedAdmins; // Update state HANYA jika save DB berhasil
               console.log('[SUPERADMIN] State admin dan DB berhasil diupdate.');
               io.emit('registered_admins', admins);
               socket.emit('superadmin_success', { message: `Admin '${usernameToDelete}' berhasil dihapus.` });
           } catch (error) {
               console.error('[SUPERADMIN] Gagal menyimpan admin setelah menghapus:', error);
               socket.emit('superadmin_error', { message: `Gagal menghapus data admin '${usernameToDelete}' dari database.` });
           }
      });


     socket.on('close_chat', async ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan tutup chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !chatId?.trim()) {
             console.warn(`[CHAT STATUS] Socket ${socket.id} mencoba tutup chat tanpa login atau chat ID.`);
             return socket.emit('chat_status_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
        }
        const username = adminInfo.username;
        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) {
            console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat dengan ID tidak valid: ${chatId}`);
            return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat ID tidak valid.' });
        }

        const chatEntry = chatHistory[normalizedChatId];

        if (!chatEntry) {
             console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang tidak ditemukan di history state.`);
             return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan di memory state.' });
        }

        const pickedBy = pickedChats[normalizedChatId];
        if (isSuperAdmin(username) || pickedBy === username) {
            if (chatEntry.status === 'closed') {
                 console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang sudah tertutup.`);
                 return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
            }

            console.log(`[CHAT STATUS] Admin ${username} menutup chat ${normalizedChatId}`);
            chatEntry.status = 'closed'; // Update state

            if (pickedBy) {
                 clearAutoReleaseTimer(normalizedChatId);
                 delete pickedChats[normalizedChatId];
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
                 io.emit('initial_pick_status', pickedChats);
            }

             try {
                const db = await getDb();
                const result = await db.run('UPDATE chat_history SET status = ? WHERE chat_id = ?', ['closed', normalizedChatId]);

                if (result.changes > 0) {
                    console.log(`[DATABASE] Status chat ${normalizedChatId} berhasil diupdate ke 'closed' di database.`);
                    io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' });
                    socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil ditutup.` });
                } else {
                     console.warn(`[DATABASE] Tidak ada baris yang terupdate saat mencoba set status 'closed' untuk ${normalizedChatId}. Mungkin chat_id tidak ada di chat_history.`);
                     io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' });
                     socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil ditutup (state memory). DB mungkin tidak konsisten.` });
                }

             } catch (error) {
                console.error(`[DATABASE] Gagal update status chat ${normalizedChatId} ke 'closed' di database:`, error);
                socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Gagal menyimpan status chat ke database.' });
             }

        } else {
             const errorMsg = pickedBy ? `Hanya ${pickedBy} atau Super Admin yang bisa menutup chat ini.` : `Chat ini tidak diambil oleh siapa pun. Hanya Super Admin yang bisa menutup chat yang tidak diambil.`;
             console.warn(`[CHAT STATUS] Admin ${username} mencoba menutup chat ${normalizedChatId}. Akses ditolak: ${errorMsg}`);
            socket.emit('chat_status_error', { chatId: normalizedChatId, message: errorMsg });
        }
     });

      socket.on('open_chat', async ({ chatId }) => {
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

        const chatEntry = chatHistory[normalizedChatId];

        if (!chatEntry) {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang tidak ditemukan di history state.`);
             return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan di memory state.' });
        }

         if (chatEntry.status === 'open') {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang sudah terbuka.`);
              return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat sudah terbuka.' });
         }

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} membuka kembali chat ${normalizedChatId}`);
        chatEntry.status = 'open'; // Update state

         try {
             const db = await getDb();
             const result = await db.run('UPDATE chat_history SET status = ? WHERE chat_id = ?', ['open', normalizedChatId]);

             if (result.changes > 0) {
                console.log(`[DATABASE] Status chat ${normalizedChatId} berhasil diupdate ke 'open' di database.`);
                io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' });
                socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali.` });
            } else {
                 console.warn(`[DATABASE] Tidak ada baris yang terupdate saat mencoba set status 'open' untuk ${normalizedChatId}. Mungkin chat_id tidak ada di chat_history.`);
                 io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' });
                 socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali (state memory). DB mungkin tidak konsisten.` });
            }

         } catch (error) {
            console.error(`[DATABASE] Gagal update status chat ${normalizedChatId} ke 'open' di database:`, error);
            socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Gagal menyimpan status chat ke database.' });
         }
     });

    // --- QUICK REPLY TEMPLATES HANDLERS (SUPER ADMIN) ---
    socket.on('add_quick_reply', async ({ shortcut, text }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan tambah template dari Super Admin ${adminInfo.username}: ${shortcut}`);

        if (!shortcut?.trim() || !text?.trim()) {
            console.warn(`[TEMPLATES] Data template tidak lengkap dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Data template tidak lengkap (shortcut dan text diperlukan).' });
        }
        const cleanedShortcut = shortcut.trim().toLowerCase();

        const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
        if (!shortcutValidationRegex.test(cleanedShortcut)) {
             console.warn(`[TEMPLATES] Shortcut template tidak valid dari ${adminInfo.username}: '${shortcut}'. Tidak sesuai format.`);
             return socket.emit('superadmin_error', { message: 'Shortcut harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).' });
        }

        if (quickReplyTemplates[cleanedShortcut]) {
            console.warn(`[TEMPLATES] Admin ${adminInfo.username} mencoba menambah template '${cleanedShortcut}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Template dengan shortcut '${cleanedShortcut}' sudah ada.` });
        }

        const templateId = cleanedShortcut;

        const updatedTemplates = {
            ...quickReplyTemplates,
             [cleanedShortcut]: {
                 id: templateId,
                 shortcut: cleanedShortcut,
                 text: text.trim()
             }
         };

        try {
             await saveAndEmitQuickReplyTemplates(updatedTemplates);
             quickReplyTemplates = updatedTemplates; // Update state HANYA jika save DB berhasil
             console.log('[TEMPLATES] State quickReplyTemplates backend updated after add.');
             socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil ditambahkan.` });
        } catch (error) {
             console.error('[TEMPLATES] Gagal menyimpan template setelah menambah:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan template '${cleanedShortcut}' ke database.` });
        }
    });

    socket.on('update_quick_reply', async ({ id, shortcut, text }) => {
         const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba update template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan update template ID ${id} dari Super Admin ${adminInfo.username}`);

        if (!id?.trim() || !shortcut?.trim() || !text?.trim()) {
             console.warn(`[TEMPLATES] Data template update tidak lengkap dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Data template tidak lengkap.' });
        }
        const cleanedShortcut = shortcut.trim().toLowerCase();

        const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
        if (!shortcutValidationRegex.test(cleanedShortcut)) {
             console.warn(`[TEMPLATES] Shortcut template baru tidak valid dari ${adminInfo.username}: '${shortcut}'. Tidak sesuai format.`);
             return socket.emit('superadmin_error', { message: 'Shortcut baru harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).' });
        }

         const oldShortcut = id;

         if (!quickReplyTemplates[oldShortcut]) {
             console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${oldShortcut}) tidak ditemukan untuk diupdate oleh ${adminInfo.username}.`);
             return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
         }

         if (oldShortcut !== cleanedShortcut && quickReplyTemplates[cleanedShortcut]) {
             console.warn(`[TEMPLATES] Admin ${adminInfo.username} mencoba update template menjadi shortcut '${cleanedShortcut}' yang sudah ada.`);
             return socket.emit('superadmin_error', { message: `Template dengan shortcut '${cleanedShortcut}' sudah ada.` });
         }

        const updatedTemplates = { ...quickReplyTemplates };

        if (oldShortcut !== cleanedShortcut) {
             console.log(`[TEMPLATES] Shortcut template ID ${id} changed from '${oldShortcut}' to '${cleanedShortcut}'. Deleting old and adding new.`);
             delete updatedTemplates[oldShortcut];
             updatedTemplates[cleanedShortcut] = {
                 id: cleanedShortcut,
                 shortcut: cleanedShortcut,
                 text: text.trim()
             };
        } else {
             console.log(`[TEMPLATES] Shortcut template ID ${id} remains '${oldShortcut}'. Updating text.`);
             updatedTemplates[cleanedShortcut].text = text.trim();
        }

         try {
             await saveAndEmitQuickReplyTemplates(updatedTemplates);
              quickReplyTemplates = updatedTemplates; // Update state HANYA jika save DB berhasil
              console.log('[TEMPLATES] State quickReplyTemplates backend updated after update.');
              socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil diupdate.` });
         } catch (error) {
              console.error('[TEMPLATES] Gagal menyimpan template setelah update:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan template '${cleanedShortcut}' ke database.` });
         }
    });


    socket.on('delete_quick_reply', async ({ id }) => {
         const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan hapus template ID ${id} dari Super Admin ${adminInfo.username}`);

        if (!id?.trim()) {
             console.warn(`[TEMPLATES] Template ID tidak valid dari ${adminInfo.username} untuk dihapus.`);
            return socket.emit('superadmin_error', { message: 'Template ID tidak valid.' });
        }

        const shortcutToDelete = id;

        if (!quickReplyTemplates[shortcutToDelete]) {
            console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${shortcutToDelete}) tidak ditemukan untuk dihapus oleh ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
        }

        const updatedTemplates = { ...quickReplyTemplates };
        delete updatedTemplates[shortcutToDelete];

         try {
             await saveAndEmitQuickReplyTemplates(updatedTemplates);
              quickReplyTemplates = updatedTemplates; // Update state HANYA jika save DB berhasil
              console.log('[TEMPLATES] State quickReplyTemplates backend updated after delete.');
              socket.emit('superadmin_success', { message: `Template '${shortcutToDelete}' berhasil dihapus.` });
         } catch (error) {
              console.error('[TEMPLATES] Gagal menyimpan template setelah menghapus:', error);
              socket.emit('superadmin_error', { message: `Gagal menghapus template '${shortcutToDelete}' dari database.` });
         }
    });
    // --- END QUICK REPLY TEMPLATES HANDLERS ---


  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] Socket ${socket.id} terputus. Alasan: ${reason}`);
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} state dibersihkan.`);
    }
  });

});


// --- Shutdown Handling ---
const shutdownHandler = async (signal) => {
    console.log(`[SERVER] Menerima ${signal}. Memulai proses pembersihan...`);

    const connectedSocketIds = Object.keys(adminSockets);
    for (const socketId of [...connectedSocketIds]) {
         const adminInfo = getAdminInfoBySocketId(socketId);
         if (adminInfo) {
             console.log(`[ADMIN] Membersihkan state untuk admin ${adminInfo.username} (Socket ID: ${socketId}) selama shutdown.`);
             cleanupAdminState(socketId);
             const currentSocket = io.sockets.sockets.get(socketId);
             if (currentSocket) {
                  try {
                      currentSocket.disconnect(true);
                      console.log(`[SOCKET] Forced disconnect for ${socketId}`);
                  } catch (e) {
                       console.error(`[SOCKET] Error forcing disconnect for ${socketId}:`, e);
                  }
             }
         }
    }
    console.log('[SOCKET] Menutup server Socket.IO...');
    try {
        await new Promise(resolve => {
             io.close(() => {
                console.log('[SOCKET] Callback penutupan server Socket.IO terpicu.');
                 if (server.listening) {
                     console.log('[SERVER] Menutup server HTTP setelah Socket.IO...');
                     server.close((err) => {
                          if (err) {
                             console.error('[SERVER] Error saat menutup server HTTP:', err);
                          } else {
                             console.log('[SERVER] Server HTTP tertutup.');
                          }
                          resolve();
                     });
                 } else {
                     console.log('[SERVER] Server HTTP sudah tidak mendengarkan.');
                     resolve();
                 }
            });
        });
        console.log('[SOCKET] Server Socket.IO dan HTTP tertutup.');
    } catch (e) {
         console.error('[SOCKET] Error saat menutup server Socket.IO atau HTTP:', e);
    }

    if (sock && sock.ws?.readyState !== sock.ws?.CLOSED && sock.ws?.readyState !== sock.ws?.CLOSING) {
        console.log('[WA] Menutup koneksi WhatsApp...');
        try {
            await Promise.race([
                sock.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp logout timed out')), 5000))
            ]);
            console.log('[WA] Koneksi WhatsApp ditutup dengan graceful.');
        } catch (e) {
             console.error('[WA] Error selama logout WhatsApp atau timeout, memaksa end:', e);
             try {
                 sock.end(new Error('Server Shutdown Forced'));
                 console.log('[WA] Koneksi WhatsApp force-ended.');
             } catch (endErr) {
                  console.error('[WA] Error saat memaksa akhir koneksi WhatsApp:', endErr);
             }
        }
     } else {
         console.log('[WA] Koneksi WhatsApp sudah tertutup atau belum diinisialisasi.');
     }

    console.log('[DATABASE] Menutup koneksi database...');
    try {
        await closeDatabase();
        console.log('[DATABASE] Koneksi database berhasil ditutup.');
    } catch (e) {
         console.error('[DATABASE] Error saat menutup database:', e);
    }

    console.log('[SERVER] Server dimatikan.');
    process.exit(0);
};

server.on('close', () => {
    console.log('[SERVER] Event Server HTTP close terpicu.');
});

process.on('SIGINT', () => shutdownHandler('SIGINT').catch(console.error));
process.on('SIGTERM', () => shutdownHandler('SIGTERM').catch(console.error));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
   setTimeout(() => {
      console.error('[SERVER] Mencoba shutdown karena unhandled rejection...');
      shutdownHandler('unhandledRejection').catch(console.error);
  }, 1000);
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err);
   setTimeout(() => {
       console.error('[SERVER] Mencoba shutdown karena uncaught exception...');
       shutdownHandler('uncaughtException').catch(console.error);
  }, 1000);
});