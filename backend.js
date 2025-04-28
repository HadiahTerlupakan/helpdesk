// backend.js

import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } from 'baileys';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet'; // <-- Tambahkan impor helmet
const expressApp = express({});
import http from 'http';
const server = http.createServer(expressApp);
import { Server } from 'socket.io';
const io = new Server(server, {
    cors: {
        origin: config.corsAllowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
     maxHttpBufferSize: 5e7 // Tambahkan ini jika mengirim/menerima media besar via socket (50MB)
});
import qrcode from 'qrcode-terminal';
import session from 'express-session';
import fs from 'fs'; // <-- Impor modul file system
import path from 'path'; // <-- Impor modul path
import pino from 'pino';
import config from './config.js';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto'; // Untuk nama file sementara jika perlu
import mime from 'mime-types'; // Untuk mendapatkan ekstensi dari mime type
import { Buffer } from 'buffer'; // Import Buffer
import bcrypt from 'bcrypt'; // <-- Tambahkan impor bcrypt

// Eksplisitkan Buffer ke global scope untuk kompatibilitas library
globalThis.Buffer = Buffer;

// SQLite Imports (perhatikan getDb, getMediaFilePathsForChat, getAllMediaFilePaths sekarang diimpor)
import {
    initDatabase,
    closeDatabase,
    loadChatHistory,
    saveChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins,
    loadAdmins,
    saveQuickReplyTemplates,
    loadQuickReplyTemplates,
    getDb, // <-- getDb diimpor untuk endpoint media
    getMediaFilePathsForChat, // <-- Import fungsi baru
    getAllMediaFilePaths // <-- Import fungsi baru
} from './database.js';


// --- Konfigurasi & State ---
let admins = {};
let chatHistory = {};
let quickReplyTemplates = {};

// Konfigurasi rate limiting
const apiLimiter = rateLimit(config.rateLimitConfig);

// Tambahkan middleware helmet
expressApp.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://cdnjs.cloudflare.com", "'unsafe-inline'"], // Izinkan self, cdnjs, dan inline script
        "img-src": ["'self'", "data:", "https://upload.wikimedia.org", "https://web.whatsapp.com"], // Izinkan self, data URI, wikimedia, dan whatsapp web
      },
    },
  })
); // <-- Konfigurasi helmet dengan CSP

const adminSockets = {};
const usernameToSocketId = {};
const pickedChats = {};
const chatReleaseTimers = {};
let reconnectTimer = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const superAdminUsername = config.superAdminUsername;
const mediaDir = path.join(__dirname, 'media'); // <-- Path ke folder media


// Variabel state untuk koneksi WA (Baileys)
let sock;
let qrDisplayed = false;
let currentQrCode = null;


// --- Logger ---
const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' });


// --- Fungsi Helper ---

// Memuat Data dari Database (History, Admins, Templates)
async function loadDataFromDatabase() {
    console.log("[DATABASE] Memuat data dari SQLite...");

    try {
        // initDatabase akan memastikan direktori data dan media ada,
        // serta membuka koneksi DB dan inisialisasi skema jika perlu.
        await initDatabase();
        console.log("[DATABASE] Database diinisialisasi/dibuka.");

        console.log('[DATABASE] Mencoba memuat riwayat chat...');
        // loadChatHistory sekarang akan memuat filePath, bukan mediaData
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
                console.error('[DATABASE] TIDAK ADA DATA ADMIN DITEMUKAN DI CONFIG.JS ATAU DATABASE! Fungsi admin mungkin tidak bekerja.');
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
        // Error di sini fatal, server tidak bisa jalan tanpa data admin/history
        throw error;
    }
}

function validateSuperAdmin(adminsData) {
    // ... (kode validasi superadmin dari backend.js asli) ...
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
        // saveChatHistory sekarang hanya menyimpan metadata dan filePath
        await saveChatHistory(chatHistory);
        // console.log('[DATABASE] Riwayat chat berhasil disimpan ke database.'); // Verbose logging
    } catch (error) {
        console.error('[DATABASE] Gagal menyimpan riwayat chat ke database:', error);
        // Jangan lempar error
    }
}

// Menyimpan Quick Reply Templates ke Database DAN memberi tahu klien via Socket.IO
async function saveAndEmitQuickReplyTemplates(templates) {
    // ... (kode saveAndEmitQuickReplyTemplates dari backend.js asli) ...
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

// ... (kode clearAutoReleaseTimer, startAutoReleaseTimer, getOnlineAdminUsernames,
//      getAdminInfoBySocketId, cleanupAdminState, normalizeChatId, isSuperAdmin dari backend.js asli) ...
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
function cleanupAdminState(socketId, socket) {
    const adminInfo = getAdminInfoBySocketId(socketId);
    if (adminInfo) {
        const username = adminInfo.username;
        // Check if socket object is available and valid before trying to access its properties
        if (!socket || !socket.id || typeof socket.id !== 'string') {
            console.error('[ADMIN] Error: Invalid socket object provided during state cleanup for admin', username);
            // Still proceed with cleanup if username is found via adminSockets[socketId]
        }
        console.log(`[ADMIN] Membersihkan state untuk admin ${username} (Socket ID: ${socket.id || 'N/A'})`);


        const chatsToRelease = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === username);
        for (const chatId of chatsToRelease) {
            clearAutoReleaseTimer(chatId);
            delete pickedChats[chatId];
            console.log(`[ADMIN] Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            io.emit('update_pick_status', { chatId: chatId, pickedBy: null });
        }

        delete adminSockets[socketId];
        // Also remove from usernameToSocketId mapping, but only if the stored socketId matches the current one
        // This prevents accidentally removing a *new* socketId if an admin rapidly reconnects.
        if(usernameToSocketId[username] === socketId) {
             delete usernameToSocketId[username];
        } else {
             console.warn(`[ADMIN] Did not remove usernameToSocketId mapping for ${username} as stored ID ${usernameToSocketId[username]} does not match disconnected ID ${socketId}.`);
        }


        io.emit('update_online_admins', getOnlineAdminUsernames());
        io.emit('initial_pick_status', pickedChats); // Send updated pick status
        return username;
    } else {
         console.warn(`[ADMIN] cleanupAdminState called for unknown socket ID ${socket.id || 'N/A'}.`);
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
  const otherValidCharsRegex = /^[a-zA-Z0-9._\-:]+$/; // Added more valid JID chars

  if (personalRegex.test(chatId) || groupRegex.test(chatId) || broadcastRegex.test(chatId) || statusRegex.test(chatId)) {
      return chatId;
  }

   // Attempt to normalize common patterns like just a number
   const cleanedForNumberPatterns = chatId.replace(/^\+/, '').replace(/[^\d\-]/g, ''); // Remove leading + and non-digits/hyphens

    if(/^\d+$/.test(cleanedForNumberPatterns)) {
         return `${cleanedForNumberPatterns}@s.whatsapp.net`;
    }
     if(/^\d+-\d+$/.test(cleanedForNumberPatterns)) {
          return `${cleanedForNumberPatterns}@g.us`;
     }


    if (otherValidCharsRegex.test(chatId)) {
         console.warn(`[NORMALIZE] Chat ID tidak cocok pola standar tapi hanya berisi karakter valid JID. Mengembalikan apa adanya: ${chatId}`);
         return chatId; // Return as is if it contains valid JID characters but not standard patterns
    }


  console.warn(`[NORMALIZE] Chat ID format tidak dikenali dan tidak dapat dinormalisasi: ${chatId}`);
  return null;
}


// Fungsi untuk mengecek apakah admin adalah Super Admin
function isSuperAdmin(username) {
     return admins[username]?.role === 'superadmin';
}

// Helper untuk mendapatkan ekstensi file dari mime type
function getFileExtension(mimeType) {
    const ext = mime.extension(mimeType);
    return ext ? `.${ext}` : '';
}


// --- Setup Express & Server ---

const PORT = config.serverPort || 3000;

async function startApp() {
    try {
        await loadDataFromDatabase();
        console.log("[SERVER] Data database siap. Memulai koneksi WhatsApp dan Server HTTP.");

        // Endpoint untuk melayani file media
        expressApp.get('/media/:filename', async (req, res) => {
             const requestedFilename = req.params.filename;
             if (!requestedFilename || requestedFilename.includes('..')) { // Basic check for directory traversal
                  console.warn(`[MEDIA] Permintaan media dengan nama file invalid: ${requestedFilename}`);
                  return res.status(400).send('Invalid filename.');
             }

             const fullPath = path.join(mediaDir, requestedFilename);

             // Keamanan: Pastikan file yang diminta benar-benar berada di dalam direktori media
             const resolvedMediaPath = path.resolve(mediaDir);
             const resolvedRequestedPath = path.resolve(fullPath);

             if (!resolvedRequestedPath.startsWith(resolvedMediaPath)) {
                  console.warn(`[MEDIA] Percobaan directory traversal: ${requestedFilename} -> ${resolvedRequestedPath}`);
                  return res.status(403).send('Access denied.');
             }

             try {
                 // Periksa apakah file ada sebelum mencoba mengirim
                 await fs.promises.access(fullPath, fs.constants.R_OK);
                 // Kirim file
                 console.log(`[MEDIA] Melayani file: ${fullPath}`);
                 res.sendFile(fullPath);
             } catch (error) {
                 if (error.code === 'ENOENT') {
                     console.warn(`[MEDIA] File tidak ditemukan: ${fullPath}`);
                     res.status(404).send('File not found.');
                 } else {
                     console.error(`[MEDIA] Error saat melayani file ${fullPath}:`, error);
                     res.status(500).send('Internal server error.');
                 }
             }
        });


        connectToWhatsApp().catch(err => {
            console.error("[WA] Gagal memulai koneksi WhatsApp awal:", err);
            // Ini tidak fatal karena server HTTP tetap jalan, admin bisa login dan lihat history
            // tapi status WA akan disconnected.
        });

        await new Promise(resolve => {
            server.listen(PORT, () => {
                console.log(`[SERVER] Server Helpdesk berjalan di http://localhost:${PORT}`);
                console.log(`[SERVER] Versi Aplikasi: ${config.version || 'N/A'}`);
                resolve();
            });
        });

    } catch (err) {
        console.error("[SERVER] Gagal memuat data awal dari database atau setup server. Server tidak dapat dimulai.", err);
        await closeDatabase().catch(dbErr => console.error('[DATABASE] Error closing DB after startup failure:', dbErr));
        process.exit(1);
    }
}

expressApp.use(express.static(__dirname));

// Terapkan rate limiting pada semua API routes
expressApp.use('/api', apiLimiter);
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
        // Fungsi ini dipanggil oleh Baileys jika perlu mengambil pesan sebelumnya
        // Kita bisa coba ambil dari DB, tapi untuk meminimalkan kompleksitas awal, kita biarkan Baileys handle sendiri
        // atau biarkan null jika tidak mendukung sync penuh.
        const db = await getDb().catch(() => null);
        if (!db) return undefined; // Tidak bisa akses DB

        try {
            const messageRow = await db.get('SELECT * FROM messages WHERE id = ? AND chat_id = ?', [key.id, normalizeChatId(key.remoteJid)]);
            if (messageRow) {
                // Rekonstruksi pesan dari DB, termasuk memuat media jika filePath ada
                const message = {
                    key: {
                        remoteJid: messageRow.chat_id,
                        fromMe: messageRow.type === 'outgoing',
                        id: messageRow.id,
                        participant: messageRow.type === 'incoming' ? messageRow.sender : null // Participant for group messages maybe needed
                    },
                    messageTimestamp: messageRow.timestamp,
                    // Ini adalah struktur pesan Baileys, perlu rekonstruksi lebih detail
                    // Berdasarkan mediaType, mimeType, text, filePath, etc.
                    // Ini cukup kompleks dan mungkin tidak sepenuhnya akurat tanpa skema lengkap Baileys
                    // Contoh sederhana untuk teks:
                    message: messageRow.text ? { conversation: messageRow.text } :
                             (messageRow.mediaType === 'imageMessage' ? { imageMessage: { mimetype: messageRow.mimeType, caption: messageRow.text } /* Media data will be missing! */ } :
                              null) // Tambahkan tipe lain jika perlu
                     // Catatan: Media data sebenarnya TIDAK dimuat di sini dari file.
                     // Baileys biasanya mengelola unduhan media sendiri jika perlu sinkronisasi.
                     // Menyediakan hanya metadata mungkin cukup, atau mungkin tidak.
                     // Jika ini menyebabkan masalah, perlu strategi yang lebih canggih untuk getMessage.
                     // Untuk saat ini, biarkan sederhana dan mungkin media lama tidak muncul di WA jika resync.
                };
                console.log(`[WA:getMessage] Menemukan pesan ${key.id} di DB.`);
                // Warning: Objek pesan yang direkonstruksi mungkin tidak lengkap untuk kebutuhan internal Baileys, terutama media.
                // Ini adalah keterbatasan pendekatan sederhana ini.
                 return message;

            } else {
                 // console.log(`[WA:getMessage] Pesan ${key.id} tidak ditemukan di DB.`); // Terlalu verbose
                return undefined;
            }
        } catch (dbError) {
            console.error(`[WA:getMessage] Error saat mengambil pesan ${key.id} dari DB:`, dbError);
            return undefined;
        }

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
                    // Kirim QR sebagai string base64 ke frontend superadmin
                    // Frontend perlu mengubah string ini menjadi data URL (e.g., 'data:image/png;base64,...')
                    // Baileys memberikan QR string biasa, bukan base64 secara default, jadi kita perlu mengkonversinya jika ingin mengirim base64.
                    // qrcode.generate juga bisa menghasilkan string atau stream. Mari kita gunakan qrcode.toDataURL jika perlu base64 di frontend.
                    // Contoh menggunakan qrcode library untuk generate data URL:
                    qrcode.toDataURL(qr, { errorCorrectionLevel: 'H' }, function (err, url) {
                        if (err) {
                            console.error('[WA] Gagal generate QR data URL:', err);
                            io.to(socketId).emit('whatsapp_qr', 'Error generating QR'); // Kirim pesan error
                        } else {
                            io.to(socketId).emit('whatsapp_qr', url); // Kirim data URL
                        }
                    });
                 }
            }
       }
    } else if (qr && qrDisplayed) {
        // If QR is updated while still displayed, update superadmins
         console.log('[WA] QR Code diperbarui, mengirim ke Super Admin yang login.');
        const currentAdminSockets = { ...adminSockets };
       for (const socketId in currentAdminSockets) {
            if (Object.prototype.hasOwnProperty.call(currentAdminSockets, socketId) && currentAdminSockets[socketId]?.role === 'superadmin') {
                 if (io.sockets.sockets.get(socketId)) {
                     qrcode.toDataURL(qr, { errorCorrectionLevel: 'H' }, function (err, url) {
                        if (err) {
                            console.error('[WA] Gagal generate QR data URL (update):', err);
                            io.to(socketId).emit('whatsapp_qr', 'Error generating QR');
                        } else {
                            io.to(socketId).emit('whatsapp_qr', url);
                        }
                    });
                 }
            }
       }
        currentQrCode = qr; // Simpan QR string mentah juga jika perlu
    }


    if (connection === 'close') {
      qrDisplayed = false;
      currentQrCode = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Unknown';
      // Baileys guide suggests reconnecting on all errors except 401
      // https://github.com/whiskeysockets/baileys?tab=readme-nt-latest#reconnect-mode
      const shouldReconnect = (statusCode && statusCode !== 401) || !statusCode;


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
             : statusCode === 401
             ? 'Sesi tidak valid. Silakan hapus folder auth_info_baileys dan restart server untuk scan ulang QR.'
             : 'Sesi invalid atau konflik fatal. Silakan hubungi Super Admin untuk memulihkan.';

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
      // Ignore messages from self, status updates, or broadcast
      if (message.key.fromMe || message.key.remoteJid === 'status@broadcast' || (sock?.user?.id && message.key.remoteJid === sock.user.id)) {
           // Jika pesan dari diri sendiri, cek apakah itu pesan outgoing yang baru saja kita kirim
           // dan belum mendapatkan status terkirim/terbaca.
           // Baileys akan mengupsert pesan fromMe yang baru dikirim.
           // Kita perlu memastikan pesan ini sudah ada di history_state dan terupdate (misalnya timestamp).
           // Kita tidak perlu menambahkannya lagi jika sudah ada by ID.
           // Logika penambahan/update history outgoing sudah ada di handler reply_message.
           // Jadi, kita bisa abaikan upsert pesan fromMe di sini.
            continue;
       }


      const chatId = normalizeChatId(message.key.remoteJid);
       if (!chatId) {
           console.error('[WA] Invalid chatId received:', message.key.remoteJid);
           continue;
       }

      const dbChatId = chatId;

      let messageContent = null;
      let mediaDataForFrontend = null; // <-- Ini akan null jika media disimpan di file
      let filePath = null; // <-- Path file media di server (nama file)
      let mediaType = null;
      let mimeType = null;
      let fileName = null; // Original filename for display in UI
      let messageTextSnippet = '';

      const messageBaileysType = message.message ? Object.keys(message.message)[0] : null;
      const messageProps = message.message?.[messageBaileysType];

        // Declare buffer outside the try/catch block
        let buffer = null; // <-- Deklarasikan di sini dan inisialisasi null

       switch (messageBaileysType) {
           case 'conversation':
           case 'extendedTextMessage':
               messageContent = messageProps?.text || messageProps?.conversation || '';
               messageTextSnippet = messageContent.substring(0, 100) + (messageContent.length > 100 ? '...' : '');
               mediaType = 'text';
               break;
           case 'imageMessage':
           case 'videoMessage':
           case 'audioMessage': // Includes Voice Notes
           case 'documentMessage':
           case 'stickerMessage':
               mediaType = messageBaileysType;
               mimeType = messageProps?.mimetype;
               // Use original filename if available, otherwise fallback
               fileName = messageProps?.fileName || messageProps?.caption || `${mediaType.replace('Message', '')}_file`;
               if (mediaType === 'audioMessage' && messageProps?.ptt) fileName = 'Voice Note'; // Label voice notes

               messageContent = messageProps?.caption || `[${mediaType.replace('Message', '')}]`;
               messageTextSnippet = messageProps?.caption ? messageProps.caption.substring(0, 100) + (messageProps.caption.length > 100 ? '...' : '') : `[${mediaType.replace('Message', '')}]`;

               try {
                 // downloadMediaMessage atau internal Baileys di sini mungkin memerlukan Buffer
                 buffer = await downloadMediaMessage(message, 'buffer', {}, { logger }); // <--- Ini baris tempat error buffer sebelumnya
                 if (buffer) {
                     // Dapatkan ekstensi dari mimeType atau tebak jika tidak ada
                     const fileExtension = getFileExtension(mimeType);
                     // Buat nama file unik menggunakan ID pesan
                     const uniqueFilename = `${message.key.id}${fileExtension}`;
                     const fullFilePath = path.join(mediaDir, uniqueFilename);

                     // Simpan buffer ke file
                     await fs.promises.writeFile(fullFilePath, buffer);
                     console.log(`[MEDIA] Pesan masuk media disimpan: ${uniqueFilename}`);

                     filePath = uniqueFilename; // Simpan hanya nama file relatif ke folder media
                     // mediaDataForFrontend tetap null di sini, akan diisi di bawah JIKA buffer valid
                 } else {
                     console.warn(`[WA] Gagal mengunduh media (buffer kosong) dari ${chatId} untuk pesan ${message.key.id}`);
                     messageContent = `[Gagal mengunduh media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                     messageTextSnippet = `[Gagal unduh media ${mediaType.replace('Message', '')}]`;
                     filePath = null;
                     buffer = null; // Ensure buffer is null if download failed
                 }
               } catch (error) {
                 console.error(`[WA] Error mengunduh atau menyimpan media dari ${chatId} untuk pesan ${message.key.id}:`, error);
                 messageContent = `[Gagal memuat media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                 messageTextSnippet = `[Error media ${mediaType.replace('Message', '')}]`;
                 filePath = null;
                 buffer = null; // Ensure buffer is null if error occurred
               }
               break;
            case 'locationMessage':
                messageContent = `[Lokasi: ${messageProps?.degreesLatitude}, ${messageProps?.degreesLongitude}]`;
                messageTextSnippet = '[Lokasi]';
                mediaType = 'location';
                // Lokasi biasanya tidak perlu disimpan file, data ada di props message
                break;
            case 'contactMessage':
                messageContent = `[Kontak: ${messageProps?.displayName || 'Nama tidak diketahui'}]`;
                 messageTextSnippet = `[Kontak]`;
                 mediaType = 'contact';
                 // Kontak biasanya tidak perlu disimpan file
                 break;
            case 'liveLocationMessage':
                 messageContent = '[Live Lokasi]';
                 messageTextSnippet = '[Live Lokasi]';
                 mediaType = 'liveLocation';
                 // Live Lokasi tidak perlu disimpan file
                 break;
            case 'protocolMessage':
            case 'reactionMessage':
            case 'senderKeyDistributionMessage':
            case 'editedMessage':
            case 'keepalive':
                 continue; // Abaikan tipe pesan ini
            default:
                console.warn(`[WA] Menerima pesan dengan tipe tidak dikenal atau tidak ditangani: ${messageBaileysType || 'N/A'} dari ${chatId}`);
                messageContent = `[Pesan tidak dikenal: ${messageBaileysType || 'N/A'}]`;
                messageTextSnippet = `[${messageBaileysType || 'Unknown'}]`;
                mediaType = 'unknown';
       }

      // Objek pesan untuk disimpan ke state memory dan database
      const messageDataForHistory = {
        id: message.key.id,
        chatId: chatId, // Normalisasi chatId untuk penyimpanan konsisten
        from: chatId, // Pengirim adalah customer (JID)
        text: messageContent || null,
        // mediaData: null, // <-- Tidak lagi menyimpan base64
        filePath: filePath, // <-- Simpan path file jika ada
        mediaType: mediaType,
        mimeType: mimeType,
        fileName: fileName,
        snippet: messageTextSnippet || null,
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        unread: true, // Pesan masuk default unread
        type: 'incoming'
      };

      // Objek pesan untuk dikirim ke frontend (mungkin perlu mediaData untuk display instan?)
      // Kirim mediaData (Base64) ke frontend HANYA untuk pesan masuk yang baru saja tiba DAN berhasil diunduh.
      // Untuk pesan lama yang dimuat dari DB, frontend akan menggunakan filePath.
      // Gunakan variabel 'buffer' yang sudah dideklarasikan di luar try/catch.
      const messageDataForFrontend = {
          ...messageDataForHistory,
          // Hanya sertakan mediaData jika buffer ada DAN valid.
          // filePath juga disertakan untuk frontend.
          mediaData: buffer && Buffer.isBuffer(buffer) ? buffer.toString('base64') : null,
      };


      if (!chatHistory[dbChatId] || !Array.isArray(chatHistory[dbChatId].messages)) {
        console.log(`[HISTORY] Membuat/memperbaiki entri baru untuk chat ${chatId}.`);
        chatHistory[dbChatId] = { status: chatHistory[dbChatId]?.status || 'open', messages: [] };
      }
       if (!chatHistory[dbChatId].status) {
           chatHistory[dbChatId].status = 'open';
       }

      // Cek apakah pesan sudah ada di history state
      const existingMessageIndex = chatHistory[dbChatId].messages.findIndex(m => m && typeof m === 'object' && m.id === messageDataForHistory.id);

      if (existingMessageIndex === -1) {
        console.log(`[HISTORY] Menambahkan pesan masuk baru (ID: ${messageDataForHistory.id}, Type: ${messageDataForHistory.mediaType}) ke chat ${chatId}`);
        chatHistory[dbChatId].messages.push(messageDataForHistory); // Simpan ke state memory (tanpa base64 mediaData, hanya filePath)
        saveChatHistoryToDatabase(); // Simpan ke DB (juga tanpa base64 mediaData)

        // Kirim pesan baru ke semua klien
        io.emit('new_message', {
             ...messageDataForFrontend, // Kirim objek yang ada base64-nya untuk tampilan instan (jika ada)
             chatId: chatId,
             chatStatus: chatHistory[dbChatId].status
         });

        // Kirim notifikasi ke admin yang tidak sedang menangani chat
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
         // Pesan sudah ada (misal dari sync atau duplikasi upsert)
         // Mungkin perlu update jika ada info tambahan, tapi umumnya diabaikan.
         // Contoh: update status pesan dari pending ke sent/delivered/read (tapi Baileys handle this di event lain)
          // console.log(`[WA] Duplicate message detected in upsert (ID: ${messageDataForHistory.id}), ignored adding to history.`);
      }
    }
  });

  // Baileys events for message status updates might be handled here if needed
  // e.g., 'messages.update' to update status (sent, delivered, read)
  // sock.ev.on('messages.update', (messages) => { ... });


}


// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`[SOCKET] Admin terhubung: ${socket.id}`);

  // --- START: PENGECEKAN DEFENSIF SAAT KONEKSI AWAL ---
  if (sock === undefined || qrDisplayed === undefined || currentQrCode === undefined) {
       console.warn(`[SOCKET] Early connection (${socket.id}) received before WA variables fully initialized. Deferring initial status update.`);
       socket.emit('whatsapp_connecting', { message: 'Menunggu status WhatsApp...' });
       socket.emit('registered_admins', admins);
       io.emit('update_online_admins', getOnlineAdminUsernames());
       socket.emit('initial_pick_status', pickedChats);
       io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates));

       return;
  }
  // --- END: PENGECEKAN DEFENSIF ---


  // Jika pengecekan di atas lolos, lanjutkan dengan logika pengiriman status WA awal yang lebih detail
  socket.emit('registered_admins', admins);
  io.emit('update_online_admins', getOnlineAdminUsernames());
  socket.emit('initial_pick_status', pickedChats);
  io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates));


  if (sock?.ws?.readyState === sock.ws.OPEN) {
       socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
  } else if (sock?.ws?.readyState === sock.ws.CONNECTING) {
       socket.emit('whatsapp_connecting', {});
  } else if (qrDisplayed && currentQrCode) {
       socket.emit('whatsapp_fatal_disconnected', { message: 'Sesi invalid. Menunggu QR Code baru...' });
       if (getAdminInfoBySocketId(socket.id)?.role === 'superadmin') {
            // Generate dan kirim QR data URL saat ada superadmin login dan QR tersedia
             qrcode.toDataURL(currentQrCode, { errorCorrectionLevel: 'H' }, function (err, url) {
                if (err) {
                    console.error('[WA] Gagal generate QR data URL saat admin login:', err);
                    io.to(socketId).emit('whatsapp_qr', 'Error generating QR'); // Kirim pesan error
                } else {
                    io.to(socketId).emit('whatsapp_qr', url); // Kirim data URL
                }
            });
       }
  } else {
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
             // Saat mengirim ke frontend, pesan media hanya memiliki filePath, BUKAN mediaData
            chatHistoryForClient[chatId] = {
                status: chatEntry.status || 'open',
                messages: chatEntry.messages.map((message) => ({
                    ...message,
                    chatId: chatId,
                    mediaData: null // Pastikan mediaData null saat dikirim dari history
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
       // Kirim data awal termasuk chat history (dengan filePath, tanpa mediaData untuk pesan lama), admin, role, dan template
      socket.emit('initial_data', {
          chatHistory: chatHistoryForClient,
          admins: admins,
          currentUserRole: adminInfo.role,
          quickReplies: Object.values(quickReplyTemplates)
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
    // Saat mengirim history spesifik ke frontend, pesan media hanya memiliki filePath, BUKAN mediaData
    const history = Array.isArray(chatEntry?.messages) ? chatEntry.messages.map((message) => ({
      ...message,
      chatId: normalizedChatId,
      mediaData: null // Pastikan mediaData null saat dikirim dari history
    })) : [];
    const status = chatEntry?.status || 'open';

    console.log(`[SOCKET] Mengirim history untuk chat ${normalizedChatId} (${history.length} pesan) ke admin ${adminInfo.username}.`);
    socket.emit('chat_history', { chatId: normalizedChatId, messages: history, status: status });
  });

  // ... (kode admin_login, admin_reconnect, admin_logout, pick_chat, unpick_chat, delegate_chat dari backend.js asli) ...
  socket.on('admin_login', async ({ username, password }) => { // <-- Tambahkan async
      console.log(`[ADMIN] Menerima percobaan login untuk: ${username}`);
    const adminUser = admins[username];
    // Gunakan bcrypt.compare untuk membandingkan password yang dimasukkan dengan hash di database
    if (adminUser && await bcrypt.compare(password, adminUser.password)) { // <-- Gunakan bcrypt.compare
      const existingSocketId = usernameToSocketId[username];
      if (existingSocketId && io.sockets.sockets.get(existingSocketId)) {
         console.warn(`[ADMIN] Login gagal: Admin ${username} sudah login dari socket ${existingSocketId}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain.' });
         return;
      }
       if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
            console.log(`[ADMIN] Admin ${username} login. Membersihkan state socket lama ${existingSocketId} yang sudah tidak aktif.`);
            // Pass socket object for proper cleanup logic within the helper
            cleanupAdminState(existingSocketId, io.sockets.sockets.get(existingSocketId)); // Pass the old socket object if available
       }

      console.log(`[ADMIN] Login berhasil: ${username} (Socket ID: ${socket.id})`);
      adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
      usernameToSocketId[username] = socket.id;

      socket.emit('login_success', { username: username, initials: adminUser.initials, role: adminUser.role || 'admin', currentPicks: pickedChats });
      io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Emit templates
      io.emit('admin_online', { username, role: adminUser.role }); // Beri tahu klien lain
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Update daftar admin online untuk semua

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
             // Pass socket object for proper cleanup logic within the helper
             cleanupAdminState(existingSocketId, io.sockets.sockets.get(existingSocketId)); // Pass the old socket object
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
              // Pass null for socket object since it's gone
              cleanupAdminState(usernameToSocketId[username], null);
        }

        console.log(`[ADMIN] Reconnect berhasil untuk ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
        usernameToSocketId[username] = socket.id;

        socket.emit('reconnect_success', { username: username, currentPicks: pickedChats, role: adminUser.role || 'admin' });
        io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Emit templates
        io.emit('admin_online', { username, role: adminUser.role }); // Beri tahu klien lain
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Update daftar admin online untuk semua

    } else {
        console.warn(`[ADMIN] Reconnect failed: Admin ${username} not found in registered admins.`);
        socket.emit('reconnect_failed');
    }
  });


  socket.on('admin_logout', () => {
    const username = cleanupAdminState(socket.id, socket); // Pass socket object to cleanup
    if (username) {
        console.log(`[ADMIN] Admin ${username} logout dari socket ${socket.id}.`);
        socket.emit('clear_cache'); // Signal frontend to clear cache and reload
        // socket.emit('logout_success'); // No need, clear_cache will trigger reload
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
           // No need to save to DB here, save happens when messages are added or status changes
           // saveChatHistoryToDatabase();
      }

    if (pickedBy && pickedBy !== username) {
      console.warn(`[PICK] Admin ${username} mencoba mengambil chat ${normalizedChatId} yang sudah diambil oleh ${pickedBy}`);
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedBy}.` });
    } else {
      pickedChats[normalizedChatId] = username;
      console.log(`[PICK] Admin ${username} mengambil/mereset pick chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username });
      io.emit('initial_pick_status', pickedChats); // Broadcast the full pick status state


      if (config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(normalizedChatId, username);
      }

       // Mark incoming messages as read for this chat IF the current user picks it
       const updatedChatEntry = chatHistory[normalizedChatId];
       if (updatedChatEntry?.messages) {
           let changed = false;
           // Iterate backwards from the end
           for (let i = updatedChatEntry.messages.length - 1; i >= 0; i--) {
                if (!updatedChatEntry.messages[i] || typeof updatedChatEntry.messages[i] !== 'object') continue;

                // Only mark incoming and unread messages
                if (updatedChatEntry.messages[i].type === 'incoming' && updatedChatEntry.messages[i].unread) {
                    updatedChatEntry.messages[i].unread = false; // Mark as read in state
                    changed = true; // Mark that changes occurred
                } else if (updatedChatEntry.messages[i].type === 'outgoing') {
                     // Optimization: If we hit an outgoing message, all messages before it must have been read previously
                     // in this chat's history context (unless imported). We can stop here.
                     break;
                }
           }
           // Only save to DB and emit update if there were actual changes
           if (changed) {
               console.log(`[MARK] Menandai pesan masuk sebagai dibaca untuk chat ${normalizedChatId} oleh ${adminInfo.username} setelah pick.`);
               saveChatHistoryToDatabase(); // Save updated state to DB (async)
               io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Notify frontend(s)
           } else {
               console.log(`[MARK] Tidak ada pesan masuk yang belum dibaca untuk ditandai di chat ${normalizedChatId}.`);
           }
       } else {
            console.warn(`[PICK] Chat ${normalizedChatId} history not found or invalid during pick read marking.`);
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
    // Allow release if picked by current user OR Super Admin
    if (pickedBy === username || isSuperAdmin(username)) {
        if (pickedBy) { // Only try to release if it's actually picked
            clearAutoReleaseTimer(normalizedChatId); // Clear timer
            delete pickedChats[normalizedChatId]; // Remove from state
            console.log(`[PICK] Admin ${username} melepas chat ${normalizedChatId}`);
            io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Notify clients of status change
             io.emit('initial_pick_status', pickedChats); // Broadcast the full pick status state (redundant but safe)
            socket.emit('pick_success', { chatId: normalizedChatId, pickedBy: null, message: 'Chat berhasil dilepas.' });
        } else {
            console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil.`);
             // If Super Admin tries to unpick a chat that isn't picked, treat as success (just clean up timer if any)
             if (isSuperAdmin(username)) {
                  clearAutoReleaseTimer(normalizedChatId);
                  console.log(`[PICK] Super Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil. Membersihkan timer jika ada.`);
                   // No status change to emit if it wasn't picked by anyone
                  socket.emit('pick_success', { chatId: normalizedChatId, pickedBy: null, message: 'Chat berhasil dilepas (tidak diambil oleh siapa pun).' });
             } else {
                  // Normal admin tries to unpick unpicked chat -> error
                  socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil oleh Anda.' });
             }
        }
    } else if (pickedBy) {
       console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang diambil oleh ${pickedBy}. Akses ditolak.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedBy} atau Super Admin yang bisa melepas chat ini.` });
    } else {
          // Normal admin tries to unpick unpicked chat (handled in the first branch now)
          // This else block might be redundant but kept for clarity if logic changes
          // console.warn(`[PICK] Admin ${username} (not Super Admin) tried to unpick unpicked chat ${normalizedChatId}.`);
          // socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil oleh siapa pun.' });
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
      // Only sender admin or Super Admin can delegate a picked chat.
      // Super Admin can delegate *any* open chat.
      const chatEntry = chatHistory[normalizedChatId];
      const chatStatus = chatEntry?.status || 'open';

       if (chatStatus === 'closed') {
           console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan chat tertutup ${normalizedChatId}`);
           return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa didelegasikan.' });
       }

      // Check if user is authorized to delegate this specific chat
      // User must be Super Admin OR (user must be the current picker AND chat is open)
      const isAuthorizedToDelegate = isSuperAdmin(senderAdminUsername) || (currentPickedBy === senderAdminUsername && chatStatus === 'open');

      if (!isAuthorizedToDelegate) {
           const errorMsg = currentPickedBy ? `Hanya ${currentPickedBy} atau Super Admin yang bisa mendelegasikan chat ini.` : 'Ambil chat ini terlebih dahulu atau pastikan Anda Super Admin.';
           console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi chat ${normalizedChatId} yang diambil oleh ${currentPickedBy || 'tidak ada'}. Akses ditolak.`);
           return socket.emit('delegate_error', { chatId: normalizedChatId, message: errorMsg });
      }


       if (!chatEntry) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat baru ${normalizedChatId} yang belum ada di history state.`);
           // Create minimal entry if it doesn't exist
           chatHistory[normalizedChatId] = { status: 'open', messages: [] };
           // Save to DB to ensure the chat_history entry exists for the delegate process
           saveChatHistoryToDatabase(); // Async save
      }

      const targetAdminInfo = admins[targetAdminUsername];
      if (!targetAdminInfo) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke admin target tidak dikenal: ${targetAdminUsername}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: `Admin target '${targetAdminUsername}' tidak ditemukan.` });
      }
       if (senderAdminUsername === targetAdminUsername) {
           console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke diri sendiri.`);
           return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
       }


      console.log(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId); // Clear old timer
      pickedChats[normalizedChatId] = targetAdminUsername; // Update state

      if (config.chatAutoReleaseTimeoutMinutes > 0) {
          startAutoReleaseTimer(normalizedChatId, targetAdminUsername); // Start new timer for target admin
      }

      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername }); // Notify clients of status change
      io.emit('initial_pick_status', pickedChats); // Broadcast the full pick status state


      // Notify target admin if they are online
      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} didelegasikan kepada Anda oleh ${senderAdminUsername}.`
          });
      } else {
           console.warn(`[DELEGATE] Target admin ${targetAdminUsername} offline or socket disconnected, not sending delegation notification via Socket.IO.`);
           // Optionally send a message to the sender admin indicating target is offline
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
    if (!chatId) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan dengan ID chat tidak valid.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Chat ID tidak valid.' });
    }
     // Only allow sending if text or media data is actually present
     if (!text?.trim() && (!media || !media.data)) {
         console.warn(`[REPLY] Admin ${username} mencoba kirim pesan kosong ke ${chatId}.`);
         return socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten valid untuk dikirim.' });
     }


    if (!sock || sock.ws?.readyState !== sock.ws.OPEN) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan, tapi koneksi WA tidak siap.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Koneksi WhatsApp belum siap. Silakan coba lagi nanti.' });
    }

    const pickedBy = pickedChats[chatId];
    // Allow reply if picked by current user OR is Super Admin
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
          // No need to save to DB here, save happens after message is sent/added
          // saveChatHistoryToDatabase();
      }

    let sentMsgResult;
    let sentMediaType = null;
    let sentMimeType = null;
    let sentFileName = null;
    let sentFilePath = null; // <-- Simpan filePath untuk pesan keluar
    let sentTextContentForHistory = text?.trim() || ''; // Original text from frontend without initials

    try {
      const adminInfoFromAdmins = admins[username];
      const adminInitials = (adminInfoFromAdmins?.initials || username.substring(0, 3).toUpperCase()).substring(0,3);

      // Append initials to the text sent to WhatsApp ONLY if text exists OR if sending media with *no* caption
      const textForSendingToWA = sentTextContentForHistory.length > 0
        ? `${sentTextContentForHistory}\n\n-${adminInitials}`
        : (media && !sentTextContentForHistory ? `-${adminInitials}` : ''); // Only add initials if media but no caption


      let mediaBuffer = null;
      if (media?.data) {
           try {
               mediaBuffer = Buffer.from(media.data, 'base64');
               sentMimeType = media.mimeType || media.type;
               sentFileName = media.name || 'file';
               sentMediaType = media.type.startsWith('image/') ? 'imageMessage' :
                               media.type.startsWith('video/') ? 'videoMessage' :
                               media.type.startsWith('audio/') ? 'audioMessage' :
                               media.type === 'application/pdf' || media.type.startsWith('application/') || media.type.startsWith('text/') ? 'documentMessage' :
                               'unknown';

               if (sentMediaType === 'unknown') {
                    console.warn(`[REPLY] Tipe media tidak didukung untuk dikirim: ${media.type}`);
                    socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Tipe media tidak didukung.' });
                    return;
               }

           } catch (bufferError) {
               console.error('[REPLY] Gagal membuat buffer dari Base64 media:', bufferError);
               socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Gagal memproses data media.' });
               return;
           }
      }


      if (mediaBuffer) {
        const mediaOptions = {
          mimetype: sentMimeType,
          fileName: sentFileName,
          // Caption is added to the textForSendingToWA variable, include it if not empty
          caption: textForSendingToWA.length > 0 ? textForSendingToWA : undefined
        };

        console.log(`[WA] Mengirim media (${sentMimeType}) ke ${chatId} oleh ${username}...`);

        if (sentMediaType === 'imageMessage') {
             sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, ...mediaOptions });
        } else if (sentMediaType === 'videoMessage') {
             sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, ...mediaOptions });
        } else if (sentMediaType === 'audioMessage') {
           // Check if it's intended as a voice note based on client hint or mime type
           const isVoiceNote = media.isVoiceNote || mediaOptions.mimetype === 'audio/ogg; codecs=opus'; // Common VN MIME

            if (isVoiceNote) {
                 // For Voice Notes, typically no caption attached. Send PTT audio.
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: true });
                 sentFileName = 'Voice Note'; // Override filename for VN display
                 // If there was original text content, send it as a separate message
                 if (sentTextContentForHistory && sentTextContentForHistory.length > 0) {
                      console.log(`[WA] Mengirim teks caption VN terpisah ke ${chatId}`);
                     // Send original text + initials as a separate text message
                     await sock.sendMessage(chatId, { text: `${sentTextContentForHistory}\n\n-${adminInitials}` });
                     // Note: This separate text message is currently NOT added to history here.
                     // It will be added to history if Baileys upserts it later.
                 }
                 sentTextContentForHistory = null; // Clear text for the media message history entry

            } else {
                 // For normal audio files, send with caption if available
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: false, caption: mediaOptions.caption });
            }

        } else if (sentMediaType === 'documentMessage') {
             sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, ...mediaOptions });
        } else if (sentMediaType === 'stickerMessage') {
             // Stickers usually have no caption. Send without text.
             sentMsgResult = await sock.sendMessage(chatId, { sticker: mediaBuffer });
              sentFileName = 'Stiker'; // Override filename for display
              sentTextContentForHistory = null; // Stickers don't have text content in history often
        }
         // Tidak perlu case default lagi karena sudah dicek di atas
      } else if (textForSendingToWA.trim().length > 0) {
        // If no mediaBuffer or mediaBuffer processing failed, send only text
        // Use textForSendingToWA which includes initials
           console.log(`[WA] Mengirim teks ke ${chatId} oleh ${username}...`);
           sentMsgResult = await sock.sendMessage(chatId, { text: textForSendingToWA });
            sentMediaType = 'conversation';
            sentMimeType = 'text/plain';
            sentFileName = null;
            // sentTextContentForHistory remains the original text
      } else {
          // This case should be caught by the initial check (!text?.trim() && (!media || !media.data)),
          // but as a fallback:
           console.warn(`[REPLY] Admin ${username} mencoba kirim pesan kosong (catch-all).`);
           socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Tidak ada konten valid untuk dikirim.' });
           return;
      }


      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('[WA] sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.', sentMsgResult);
          socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          return;
      }

      // If the message sent was media AND buffer was successfully created/obtained
      // we need to save the buffer to a file on the server for history display later.
      // This happens *after* successful sending via sock.sendMessage to get the Baileys message ID.
      // Validasi ekstensi dan mime type sebelum memproses file
      const allowedMimeTypes = [
        'image/jpeg', 
        'image/png', 
        'image/gif', 
        'application/pdf', 
        'text/plain',
        'audio/mpeg', // MP3
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // Excel (.xlsx)
        'application/vnd.ms-excel', // Excel (.xls lama)
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // Word (.docx)
        'application/msword', // Word (.doc lama)
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', // PowerPoint (.pptx)
        'application/vnd.ms-powerpoint', // PowerPoint (.ppt lama)
        'video/mp4' // MP4
      ];
      
      const allowedExtensions = [
        '.jpg', 
        '.jpeg', 
        '.png', 
        '.gif', 
        '.pdf', 
        '.txt',
        '.mp3', 
        '.xlsx', 
        '.xls', 
        '.docx', 
        '.doc', 
        '.pptx', 
        '.ppt',
        '.mp4' // MP4
      ];
      // Fungsi untuk mendapatkan ekstensi file dari mime typ      
      
      if (mediaBuffer && sentMediaType !== 'unknown') {
          // Validasi mime type
          if (!allowedMimeTypes.includes(sentMimeType)) {
              console.warn(`[MEDIA] Mime type tidak diizinkan: ${sentMimeType}`);
              return socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Tipe file tidak diizinkan.' });
          }
          
          // Validasi ekstensi file
          const fileExtension = getFileExtension(sentMimeType);
          if (!allowedExtensions.includes(fileExtension.toLowerCase())) {
              console.warn(`[MEDIA] Ekstensi file tidak diizinkan: ${fileExtension}`);
              return socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Ekstensi file tidak diizinkan.' });
          }
          
          try {
              // Buat nama file unik menggunakan ID pesan Baileys yang baru saja didapat
              const uniqueFilename = `${sentMsg.key.id}${fileExtension}`;
              const fullFilePath = path.join(mediaDir, uniqueFilename);

               // Simpan buffer media keluar ke file
               await fs.promises.writeFile(fullFilePath, mediaBuffer);
               console.log(`[MEDIA] Pesan keluar media disimpan: ${uniqueFilename}`);
               sentFilePath = uniqueFilename; // Simpan hanya nama file relatif

           } catch (fileSaveError) {
               console.error(`[MEDIA] Gagal menyimpan file media keluar untuk pesan ${sentMsg.key.id}:`, fileSaveError);
               // File gagal disimpan, tapi pesan sudah terkirim di WA.
               // Lanjutkan, tapi log error dan set filePath ke null.
               sentFilePath = null;
               // Ini akan menyebabkan media tidak muncul di history UI jika dimuat dari DB.
               // Media yang baru dikirim juga tidak bisa dibuka di modal karena tidak ada path.
               // Frontend logic might need adjustment to handle this case (e.g., show error placeholder for media).
           }
      } else if (sentMediaType === 'conversation' || sentMediaType === 'text') {
           // If it was a text message, ensure filePath is explicitly null
           sentFilePath = null;
      }


      // Objek pesan untuk disimpan ke state memory dan database
      const outgoingMessageData = {
        id: sentMsg.key.id,
        chatId: chatId,
        from: username, // Pengirim adalah username admin
        text: sentTextContentForHistory || null, // Teks asli dari frontend, bukan yang ditambah inisial
        mediaType: sentMediaType,
        mimeType: sentMimeType,
        // mediaData: null, // Tidak lagi menyimpan base64 di state/DB
        filePath: sentFilePath, // Simpan path file jika ada dan berhasil disimpan
        fileName: sentFileName, // Original filename for display
        initials: adminInitials, // Simpan inisial admin
        timestamp: sentMsg.messageTimestamp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        type: 'outgoing',
        unread: false, // Pesan keluar tidak perlu unread
        snippet: sentTextContentForHistory?.substring(0, 100) + (sentTextContentForHistory?.length > 100 ? '...' : '')
                 || sentFileName
                 || (sentMediaType && sentMediaType !== 'text' ? `[${sentMediaType?.replace('Message', '') || 'Media'}]` : '')
                 || '[Pesan Keluar]', // Fallback snippet
      };

      const dbChatId = chatId;

      if (!chatHistory[dbChatId] || !Array.isArray(chatHistory[dbChatId].messages)) {
           console.log(`[HISTORY] Membuat/memperbaiki entri chat ${chatId} untuk pesan keluar.`);
           chatHistory[dbChatId] = { status: chatHistory[dbChatId]?.status || 'open', messages: [] };
       }

       // Tambahkan pesan keluar ke history state dan database
       // Cek duplikasi berdasarkan ID
       const existingMessageIndex = chatHistory[dbChatId].messages.findIndex(m => m && typeof m === 'object' && m.id === outgoingMessageData.id);

       if (existingMessageIndex === -1) {
            console.log(`[HISTORY] Menambahkan pesan keluar baru (ID: ${outgoingMessageData.id}, Type: ${outgoingMessageData.mediaType}) ke chat ${chatId}`);
            chatHistory[dbChatId].messages.push(outgoingMessageData); // Simpan ke state memory (dan database)
            saveChatHistoryToDatabase(); // Simpan ke DB (juga tanpa base64 mediaData)
       } else {
           // Pesan keluar sudah ada (misal dari upsert Baileys setelah kita kirim), update info yang mungkin baru didapat (misal timestamp, status)
           console.log(`[HISTORY] Mengupdate pesan keluar (ID: ${outgoingMessageData.id}) di chat ${chatId}.`);
           // Perbarui objek yang sudah ada di state dengan data terbaru
           chatHistory[dbChatId].messages[existingMessageIndex] = {
               ...chatHistory[dbChatId].messages[existingMessageIndex], // Pertahankan properti yang mungkin belum ada di outgoingMessageData
               ...outgoingMessageData // Timpa dengan data terbaru
               // Mungkin perlu logika lebih canggih jika status pesan perlu diupdate (delivered, read)
           };
           saveChatHistoryToDatabase(); // Simpan update ke DB
       }


      // Kirim pesan keluar yang baru ke semua klien
      // Pesan keluar ke frontend juga hanya akan punya filePath, BUKAN mediaData
      io.emit('new_message', {
          ...outgoingMessageData,
          chatId: chatId,
          chatStatus: chatHistory[dbChatId]?.status || 'open',
          mediaData: null // Pastikan mediaData null saat dikirim ke frontend (kecuali untuk pesan masuk baru)
      });

      // Kirim konfirmasi berhasil kirim ke pengirim
      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.chatId
      });

      // Reset timer auto-release jika diaktifkan dan admin yang mengirim adalah picker
      if (pickedChats[chatId] === username && config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(chatId, username);
      }

    } catch (error) {
      console.error(`[REPLY] Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  // ... (kode mark_as_read, add_admin, delete_admin,
  //      close_chat, open_chat, template handlers) ...

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
     // Allow marking as read if picked by current user OR Super Admin
     if (isSuperAdmin(adminInfo.username) || pickedBy === adminInfo.username) {
         const chatEntry = chatHistory[dbChatId];
         if (chatEntry?.messages) {
              let changed = false;
              for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                   if (!chatEntry.messages[i] || typeof chatEntry.messages[i] !== 'object') continue;

                   if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                       chatEntry.messages[i].unread = false; // Mark as read in state
                       changed = true; // Mark that changes occurred
                   } else if (chatEntry.messages[i].type === 'outgoing') {
                        // Optimization: Stop marking unread once we hit an outgoing message
                        break;
                   }
              }
              // Only save to DB and emit update if there were actual changes
              if (changed) {
                  console.log(`[MARK] Menandai pesan masuk sebagai dibaca untuk chat ${normalizedChatId} oleh ${adminInfo.username}.`);
                  saveChatHistoryToDatabase(); // Save updated state to DB (async)
                  io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Notify frontend(s)
              } else {
                  console.log(`[MARK] Tidak ada pesan masuk yang belum dibaca untuk ditandai di chat ${normalizedChatId}.`);
              }
         } else {
             console.warn(`[MARK] Chat ${normalizedChatId} not found in state or has no messages to mark as read.`);
         }
     } else {
         console.warn(`[MARK] Admin ${adminInfo.username} attempted mark_as_read on chat ${normalizedChatId} not handled by them. Access denied.`);
     }
   });

    // --- START: MODIFIED delete_chat HANDLER ---
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

        // --- START: Delete associated media files ---
        try {
            // 1. Ambil daftar file paths dari database sebelum menghapus catatan pesan
            const filePathsToDelete = await getMediaFilePathsForChat(normalizedChatId);
            console.log(`[SUPERADMIN] Menemukan ${filePathsToDelete.length} file media untuk dihapus untuk chat ${normalizedChatId}.`);

            // 2. Hapus file-file tersebut dari sistem file
            for (const filename of filePathsToDelete) {
                // Tambahkan validasi dasar untuk nama file
                if (!filename || typeof filename !== 'string' || filename.includes('..')) {
                    console.warn(`[SUPERADMIN] Melewati penghapusan file media dengan nama invalid: ${filename}`);
                    continue;
                }
                const fullPath = path.join(mediaDir, filename);
                try {
                    // Gunakan fs.promises.unlink untuk menghapus file
                    await fs.promises.unlink(fullPath);
                    console.log(`[SUPERADMIN] File media berhasil dihapus: ${filename}`);
                } catch (fileError) {
                    // Tangani jika file tidak ditemukan atau error lainnya
                    if (fileError.code === 'ENOENT') {
                        console.warn(`[SUPERADMIN] File media tidak ditemukan saat mencoba menghapus: ${fullPath} (mungkin sudah terhapus?)`);
                    } else {
                        console.error(`[SUPERADMIN] Gagal menghapus file media ${fullPath}:`, fileError);
                    }
                    // Lanjutkan meskipun satu file gagal dihapus
                }
            }
            console.log(`[SUPERADMIN] Proses penghapusan file media untuk chat ${normalizedChatId} selesai.`);
        } catch (queryError) {
            console.error(`[SUPERADMIN] Gagal mengambil filePaths untuk dihapus untuk chat ${normalizedChatId}:`, queryError);
            // Log error saat query, tetapi tetap lanjutkan dengan penghapusan database
            // karena record database tetap perlu dihapus.
        }
        // --- END: Delete associated media files ---


        // Lanjutkan dengan penghapusan dari state memory dan database
        if (chatHistory[normalizedChatId]) {
            // Hapus dari state memory frontend
            delete chatHistory[normalizedChatId];
            // Hapus pick status jika chat ini diambil
            if (pickedChats[normalizedChatId]) {
                clearAutoReleaseTimer(normalizedChatId);
                delete pickedChats[normalizedChatId];
            }

            try {
                // 3. Hapus record dari database (ini juga akan menghapus messages terkait karena ON DELETE CASCADE)
                const success = await deleteChatHistory(normalizedChatId);

                if (success) {
                    // Beri tahu klien bahwa chat dihapus
                    io.emit('chat_history_deleted', { chatId: normalizedChatId });
                    io.emit('initial_pick_status', pickedChats); // Update status pick di semua klien
                    socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dihapus (termasuk media file).` }); // Update success message
                } else {
                     console.warn(`[SUPERADMIN] Chat ${normalizedChatId} not found in DB for deletion, but removed from state. Media files were processed.`);
                     io.emit('chat_history_deleted', { chatId: normalizedChatId }); // Tetap beri tahu klien jika dihapus dari state
                     io.emit('initial_pick_status', pickedChats); // Update status pick
                     // It's okay to report success if state and files are gone, database might have been inconsistent anyway.
                     socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dihapus (dari state & media file). DB mungkin tidak konsisten.` }); // Update success message
                }
            } catch (error) {
                 console.error(`[SUPERADMIN] Gagal menghapus chat ${normalizedChatId} dari database:`, error);
                 socket.emit('superadmin_error', { message: 'Gagal menghapus chat dari database.' });
            }
        } else {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus chat ${normalizedChatId} yang tidak ditemukan di state.`);
             socket.emit('superadmin_error', { message: 'Chat tidak ditemukan dalam history state.' });
        }
    });
    // --- END: MODIFIED delete_chat HANDLER ---

    // --- START: MODIFIED delete_all_chats HANDLER ---
     socket.on('delete_all_chats', async () => {
      const adminInfo = getAdminInfoBySocketId(socket.id);
      if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
           console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus semua chat.`);
          return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus semua chat.' });
      }

       console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus SEMUA chat history.`);

       // --- START: Delete ALL media files ---
       try {
          // 1. Ambil daftar SEMUA file paths dari database sebelum menghapus semua catatan pesan
          const allFilePathsToDelete = await getAllMediaFilePaths();
          console.log(`[SUPERADMIN] Menemukan ${allFilePathsToDelete.length} file media untuk dihapus (SEMUA).`);

          // 2. Hapus file-file tersebut dari sistem file
          for (const filename of allFilePathsToDelete) {
               // Tambahkan validasi dasar untuk nama file
               if (!filename || typeof filename !== 'string' || filename.includes('..')) {
                   console.warn(`[SUPERADMIN] Melewati penghapusan file media dengan nama invalid: ${filename}`);
                   continue;
               }
              const fullPath = path.join(mediaDir, filename);
              try {
                  // Gunakan fs.promises.unlink untuk menghapus file
                   // Periksa dulu apakah file ada untuk menghindari error jika sudah terhapus
                   await fs.promises.access(fullPath, fs.constants.F_OK);
                  await fs.promises.unlink(fullPath);
                  console.log(`[SUPERADMIN] File media berhasil dihapus: ${filename}`);
              } catch (fileError) {
                   if (fileError.code === 'ENOENT') {
                       console.warn(`[SUPERADMIN] File media tidak ditemukan saat mencoba menghapus: ${fullPath} (mungkin sudah terhapus?)`);
                   } else {
                       console.error(`[SUPERADMIN] Gagal menghapus file media ${fullPath}:`, fileError);
                   }
                   // Lanjutkan meskipun satu file gagal dihapus
              }
          }
          console.log(`[SUPERADMIN] Proses penghapusan SEMUA file media selesai.`);
       } catch (queryError) {
           console.error(`[SUPERADMIN] Gagal mengambil SEMUA filePaths untuk dihapus:`, queryError);
           // Log error saat query, tetapi tetap lanjutkan dengan penghapusan database
       }
       // --- END: Delete ALL media files ---

       // Bersihkan state memory (picked chats, chat history, timers)
       const chatIdsWithTimers = Object.keys(chatReleaseTimers);
       if (chatIdsWithTimers.length > 0) {
            console.log(`[TIMER] Membersihkan ${chatIdsWithTimers.length} timer auto-release tersisa sebelum menghapus semua chat history...`);
            for (const chatId of [...chatIdsWithTimers]) {
                 clearAutoReleaseTimer(chatId);
            }
       }
       Object.keys(pickedChats).forEach(key => delete pickedChats[key]);
       chatHistory = {}; // Reset entire chat history state


       try {
          // 3. Hapus semua record dari database (ini juga akan menghapus messages terkait karena ON DELETE CASCADE)
          const success = await deleteAllChatHistory();

          if (success) {
              // Beri tahu klien bahwa semua chat dihapus
              io.emit('all_chat_history_deleted');
              io.emit('initial_pick_status', pickedChats); // Update status pick
              socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus (metadata & media file).' }); // Update success message
          } else {
               console.error(`[SUPERADMIN] Gagal menghapus semua chat dari database.`);
               // It's okay to report success if state and files are gone, database might have been inconsistent anyway.
               io.emit('all_chat_history_deleted'); // Still signal frontend to clear UI
               io.emit('initial_pick_status', pickedChats); // Update status pick
               socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus (dari state & media file). DB mungkin tidak konsisten.' }); // Update success message
          }
       } catch (error) {
           console.error(`[SUPERADMIN] Error saat menghapus semua chat dari database:`, error);
           socket.emit('superadmin_error', { message: 'Error saat menghapus semua chat dari database.' });
       }
   });
   // --- END: MODIFIED delete_all_chats HANDLER ---


     socket.on('add_admin', async ({ username, password, initials, role }) => { // Pastikan async sudah ada atau tambahkan
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
                 password: await bcrypt.hash(password, 10), // <-- Hash password sebelum menyimpan
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
                cleanupAdminState(targetSocketId, io.sockets.sockets.get(targetSocketId)); // Pass socket object
                 try {
                     // Give frontend a moment to receive cleanup state before disconnecting
                     setTimeout(() => {
                         const oldSocket = io.sockets.sockets.get(targetSocketId);
                         if(oldSocket) oldSocket.disconnect(true);
                         console.log(`[SUPERADMIN] Socket lama ${targetSocketId} disconnected.`);
                     }, 100); // Short delay
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
               console.log(`[SUPERADMIN] Admin ${usernameToDelete} tidak online dan tidak ada state aktif. Melanjutkan penghapusan.`);
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
        // Allow close if picked by current user OR Super Admin
        if (isSuperAdmin(username) || pickedBy === username) {
            if (chatEntry.status === 'closed') {
                 console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang sudah tertutup.`);
                 return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
            }

            console.log(`[CHAT STATUS] Admin ${username} menutup chat ${normalizedChatId}`);
            chatEntry.status = 'closed'; // Update state in memory

            if (pickedBy) { // If the chat was picked, release it and update pick status
                 clearAutoReleaseTimer(normalizedChatId);
                 delete pickedChats[normalizedChatId];
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
                 io.emit('initial_pick_status', pickedChats); // Broadcast the full pick status state
            }

             try {
                const db = await getDb();
                const result = await db.run('UPDATE chat_history SET status = ? WHERE chat_id = ?', ['closed', normalizedChatId]);

                if (result.changes > 0) {
                    console.log(`[DATABASE] Status chat ${normalizedChatId} berhasil diupdate ke 'closed' di database.`);
                    io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' }); // Notify clients of status change
                    socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil ditutup.` });
                } else {
                     console.warn(`[DATABASE] Tidak ada baris yang terupdate saat mencoba set status 'closed' untuk ${normalizedChatId}. Mungkin chat_id tidak ada di chat_history.`);
                     // If DB record wasn't updated, it might be a new chat not yet saved?
                     // But the chatEntry check above should prevent this.
                     // Still emit update and report success based on memory state change.
                     io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' }); // Notify clients anyway
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
        // Only Super Admin can reopen a closed chat
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
        chatEntry.status = 'open'; // Update state in memory

         try {
             const db = await getDb();
             const result = await db.run('UPDATE chat_history SET status = ? WHERE chat_id = ?', ['open', normalizedChatId]);

             if (result.changes > 0) {
                console.log(`[DATABASE] Status chat ${normalizedChatId} berhasil diupdate ke 'open' di database.`);
                io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' }); // Notify clients
                socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali.` });
            } else {
                 console.warn(`[DATABASE] Tidak ada baris yang terupdate saat mencoba set status 'open' untuk ${normalizedChatId}. Mungkin chat_id tidak ada di chat_history.`);
                 io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' }); // Notify clients anyway
                 socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali (state memory). DB mungkin tidak konsisten.` });
            }

         } catch (error) {
            console.error(`[DATABASE] Gagal update status chat ${normalizedChatId} ke 'open' di database:`, error);
            socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Gagal menyimpan status chat ke database.' });
         }
     });


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

        const templateId = cleanedShortcut; // Use shortcut as the unique ID

        const updatedTemplates = {
            ...quickReplyTemplates,
             [cleanedShortcut]: {
                 id: templateId,
                 shortcut: cleanedShortcut,
                 text: text.trim()
             }
         };

        try {
             quickReplyTemplates = updatedTemplates; // Update state immediately
             await saveAndEmitQuickReplyTemplates(quickReplyTemplates); // Save to DB and emit update
             console.log('[TEMPLATES] State quickReplyTemplates backend updated after add.');
             socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil ditambahkan.` });
        } catch (error) {
             console.error('[TEMPLATES] Gagal menyimpan template setelah menambah:', error);
             // Revert state if DB save failed? Or let next loadDataFromDatabase handle it?
             // Reverting state is safer but requires fetching the list again or careful state management.
             // For now, rely on next load to correct state if DB failed.
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

         const oldShortcut = id; // In this design, id is the old shortcut

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
             quickReplyTemplates = updatedTemplates; // Update state immediately
             await saveAndEmitQuickReplyTemplates(quickReplyTemplates); // Save to DB and emit update
              console.log('[TEMPLATES] State quickReplyTemplates backend updated after update.');
              socket.emit('superadmin_success', { message: `Template '${oldShortcut}' berhasil diupdate menjadi '${cleanedShortcut}'.` }); // More specific success message
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

        const shortcutToDelete = id; // In this design, id is the shortcut

        if (!quickReplyTemplates[shortcutToDelete]) {
            console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${shortcutToDelete}) tidak ditemukan untuk dihapus oleh ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
        }

        const deletedShortcut = quickReplyTemplates[shortcutToDelete].shortcut; // Get shortcut before deleting from state
        const updatedTemplates = { ...quickReplyTemplates };
        delete updatedTemplates[shortcutToDelete]; // Delete from state immediately

         try {
             quickReplyTemplates = updatedTemplates; // Update state
             await saveAndEmitQuickReplyTemplates(quickReplyTemplates); // Save to DB and emit update
              console.log('[TEMPLATES] State quickReplyTemplates backend updated after delete.');
              socket.emit('superadmin_success', { message: `Template '${deletedShortcut}' berhasil dihapus.` }); // Use deleted shortcut in message
         } catch (error) {
              console.error('[TEMPLATES] Gagal menyimpan template setelah menghapus:', error);
              socket.emit('superadmin_error', { message: `Gagal menghapus template '${deletedShortcut}' dari database.` });
         }
    });


  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] Socket ${socket.id} terputus. Alasan: ${reason}`);
    const username = cleanupAdminState(socket.id, socket); // Pass socket object to cleanup
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
             // Pass the actual socket object if available, otherwise null
             cleanupAdminState(socketId, io.sockets.sockets.get(socketId));
             const currentSocket = io.sockets.sockets.get(socketId);
             if (currentSocket) {
                  try {
                      // Force close socket, ignore errors
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
             // io.close() takes an optional callback
             io.close(() => {
                console.log('[SOCKET] Callback penutupan server Socket.IO terpicu.');
                 // Check if server is still listening before closing HTTP server
                 if (server.listening) {
                     console.log('[SERVER] Menutup server HTTP setelah Socket.IO...');
                     server.close((err) => {
                          if (err) {
                             console.error('[SERVER] Error saat menutup server HTTP:', err);
                          } else {
                             console.log('[SERVER] Server HTTP tertutup.');
                          }
                          resolve(); // Resolve the promise after HTTP server closes
                     });
                 } else {
                     console.log('[SERVER] Server HTTP sudah tidak mendengarkan.');
                     resolve(); // Resolve immediately if HTTP server wasn't listening
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
            // Use Promise.race with a timeout for a more robust shutdown
            await Promise.race([
                sock.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp logout timed out')), 5000)) // 5 seconds timeout
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
        await closeDatabase(); // Menunggu koneksi DB ditutup
        console.log('[DATABASE] Koneksi database berhasil ditutup.');
    } catch (e) {
         console.error('[DATABASE] Error saat menutup database:', e);
    }

    console.log('[SERVER] Server dimatikan.');
    process.exit(0); // Exit successfully
};

server.on('close', () => {
    console.log('[SERVER] Event Server HTTP close terpicu.');
});

// Added safety checks to ensure process.exit doesn't happen multiple times
let shuttingDown = false;
const initiateShutdown = async (signal) => {
    if (shuttingDown) {
        console.warn(`[SERVER] Shutdown already in progress. Ignoring signal ${signal}.`);
        return;
    }
    shuttingDown = true;
    try {
        await shutdownHandler(signal);
    } catch (err) {
        console.error(`[SERVER] Error during shutdown handler for ${signal}:`, err);
        process.exit(1); // Exit with error code if handler fails
    }
};


process.on('SIGINT', () => initiateShutdown('SIGINT').catch(console.error));
process.on('SIGTERM', () => initiateShutdown('SIGTERM').catch(console.error));

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
   // Give it a moment before attempting shutdown to log the error fully
   // Don't initiate shutdown immediately if already shutting down
   if (!shuttingDown) {
        setTimeout(() => {
            console.error('[SERVER] Mencoba shutdown karena unhandled rejection...');
            initiateShutdown('unhandledRejection').catch(console.error);
        }, 1000); // 1 second delay
   } else {
       console.warn('[SERVER] Unhandled Rejection occurred during shutdown process.');
   }
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err);
   // Give it a moment before attempting shutdown
    // Don't initiate shutdown immediately if already shutting down
   if (!shuttingDown) {
        setTimeout(() => {
           console.error('[SERVER] Mencoba shutdown karena uncaught exception...');
           initiateShutdown('uncaughtException').catch(console.error);
        }, 1000); // 1 second delay
   } else {
       console.warn('[SERVER] Uncaught Exception occurred during shutdown process.');
   }
});
