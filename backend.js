// backend.js

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
import config from './config.js';
import { fileURLToPath } from 'url';
// uuidv4 hanya perlu jika Anda ingin ID yang berbeda dari encoded shortcut,
// tapi untuk konsistensi, kita bisa gunakan encoded shortcut sebagai ID juga.
// import { v4 as uuidv4 } from 'uuid';

// Firebase Imports
import { getDatabase, ref, child, get, set, remove } from 'firebase/database';
import { app as firebaseApp, database } from './firebaseConfig.js';

// --- Konfigurasi & State ---
let admins = {}; // { username: { password, initials, role } } - Akan dimuat dari Firebase
const adminSockets = {}; // socket ID -> { username: '...', role: '...' } // Menyimpan info admin login
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId (normalized) -> username // State di backend untuk chat yang diambil
const chatReleaseTimers = {}; // chatId (normalized) -> setTimeout ID
const __filename = fileURLToPath(import.meta.url); // Menggunakan fileURLToPath yang benar
const __dirname = path.dirname(__filename);
// Struktur chatHistory: { encodedChatId: { status: 'open'|'closed', messages: [...] } }
let chatHistory = {};
const superAdminUsername = config.superAdminUsername; // Ambil superadmin username dari config

let sock; // Variabel global untuk instance socket Baileys
let qrDisplayed = false;

// --- QUICK REPLY TEMPLATES ---
// Struktur quickReplyTemplates: { shortcut: { id: string, text: string, shortcut: string } }
// Kunci map ini di backend adalah shortcut yang sebenarnya (sudah didecode), diawali '/'.
// ID template adalah versi encoded dari shortcut.
let quickReplyTemplates = {};
// --- END QUICK REPLY TEMPLATES ---


// --- Fungsi Helper ---

const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' });

// Memuat Data dari Firebase (History, Admins, Templates)
async function loadDataFromFirebase() {
    console.log("[FIREBASE] Memuat data dari Firebase...");
    const dbRef = ref(database); // Root reference

    try {
        // Muat Chat History
        console.log('[FIREBASE] Mencoba memuat riwayat chat...');
        const historySnapshot = await get(child(dbRef, 'chatHistory'));
        if (historySnapshot.exists()) {
            chatHistory = historySnapshot.val();
            console.log('[FIREBASE] Riwayat chat berhasil dimuat dari Firebase.');
             // Pastikan struktur history sesuai harapan jika dimuat
            for (const encodedChatId in chatHistory) {
                 // Tambahkan cek `hasOwnProperty` untuk menghindari properti prototipe
                 if (!Object.prototype.hasOwnProperty.call(chatHistory, encodedChatId)) continue;

                 if (chatHistory[encodedChatId]) {
                     const decodedChatId = decodeFirebaseKey(encodedChatId);
                      // Handle data lama tanpa array messages atau status
                     if (!chatHistory[encodedChatId].messages) {
                        console.warn(`[FIREBASE] Mengkonversi struktur chat history lama untuk ${decodedChatId}: Menambahkan array 'messages'.`);
                         // Coba konversi jika data lama adalah array pesan langsung (ini hanya tebakan, tergantung data Anda)
                        if (Array.isArray(chatHistory[encodedChatId])) {
                             chatHistory[encodedChatId] = { status: 'open', messages: chatHistory[encodedChatId] };
                             console.warn(`[FIREBASE] Data chat history ${decodedChatId} dikonversi dari array ke objek.`);
                        } else {
                            // Jika bukan array dan bukan objek dengan messages, kemungkinan data rusak
                             console.error(`[FIREBASE] Struktur data chat history untuk ${decodedChatId} tidak dikenali (bukan array atau objek dengan messages). Mengosongkan pesan.`);
                             chatHistory[encodedChatId].messages = []; // Kosongkan messages array saja
                             // delete chatHistory[encodedChatId]; // Opsi: hapus entri rusak total
                             // continue; // Lanjut ke chat berikutnya
                        }
                     }
                     if (!chatHistory[encodedChatId].status) {
                        console.warn(`[FIREBASE] Menambahkan status default 'open' untuk chat ${decodedChatId}.`);
                        chatHistory[encodedChatId].status = 'open'; // Set status default jika tidak ada
                     }
                     // Clean up potentially invalid entries if 'messages' is present but not array
                     if (!Array.isArray(chatHistory[encodedChatId].messages)) {
                         console.error(`[FIREBASE] Chat history untuk ${decodedChatId} memiliki struktur 'messages' yang tidak valid (bukan array). Mengosongkan pesan.`);
                          chatHistory[encodedChatId].messages = [];
                     }
                      // Pastikan setiap pesan di dalam array memiliki ID. Ini krusial untuk deduplikasi.
                      if (Array.isArray(chatHistory[encodedChatId].messages)) {
                          chatHistory[encodedChatId].messages = chatHistory[encodedChatId].messages.filter(msg => {
                               // Tambahkan cek untuk null/undefined message objek itu sendiri
                               if (!msg || typeof msg !== 'object' || !msg.id) {
                                   console.warn(`[FIREBASE] Pesan tidak valid (null/undefined atau tanpa ID) ditemukan di chat ${decodedChatId}. Menghapusnya dari memori.`);
                                   return false; // Filter out invalid messages
                               }
                               return true; // Keep valid messages
                          });
                      }

                 } else {
                     // Handle null or invalid entry at top level for a chat ID
                     const decodedKey = decodeFirebaseKey(encodedChatId);
                     console.warn(`[FIREBASE] Entri chat history tidak valid ditemukan dan dihapus: ${decodedKey} (Encoded: ${encodedChatId})`);
                     delete chatHistory[encodedChatId];
                 }
            }
             // Setelah semua divalidasi, bersihkan key Firebase yang mungkin invalid
             for (const encodedChatId in chatHistory) {
                  if (!Object.prototype.hasOwnProperty.call(chatHistory, encodedChatId)) continue;
                  const decodedChatId = decodeFirebaseKey(encodedChatId);
                   if (!decodedChatId) { // Jika decoding gagal, key-nya mungkin memang tidak valid
                        console.error(`[FIREBASE] Key Firebase chat history tidak valid saat decode: ${encodedChatId}. Menghapusnya.`);
                        delete chatHistory[encodedChatId];
                        continue; // Lanjut ke chat berikutnya
                   }
             }


        } else {
            console.log('[FIREBASE] Tidak ada riwayat chat di Firebase.');
            chatHistory = {}; // Pastikan chatHistory adalah objek kosong jika tidak ada data
        }

        // Muat Admins
        console.log('[FIREBASE] Mencoba memuat data admin...');
        const adminsSnapshot = await get(child(dbRef, 'admins'));
        if (adminsSnapshot.exists()) {
            admins = adminsSnapshot.val();
            console.log('[FIREBASE] Data admin berhasil dimuat dari Firebase.');
             // Validasi dasar untuk superadmin
             if (!admins || Object.keys(admins).length === 0) {
                 console.error('[FIREBASE] TIDAK ADA DATA ADMIN DITEMUKAN DI DATABASE! Silakan tambahkan Super Admin secara manual di Firebase DB atau gunakan config.js.');
                 admins = config.admins || {}; // Fallback to config if DB is empty
                  if (Object.keys(admins).length > 0) {
                       console.log('[FIREBASE] Menggunakan admin dari config.js sebagai fallback.');
                       saveAdminsToFirebase(); // Save config admins if DB was empty
                  }
             }

             if (!admins[superAdminUsername] || admins[superAdminUsername].role !== 'superadmin') {
                 console.warn(`[FIREBASE] PERINGATAN: Super Admin username '${superAdminUsername}' dari config.js tidak ditemukan atau tidak memiliki role 'superadmin' di Firebase admins yang dimuat.`);
                  const actualSuperAdmins = Object.keys(admins).filter(user => admins[user]?.role === 'superadmin');
                  if (actualSuperAdmins.length === 0) {
                       console.error('[FIREBASE] TIDAK ADA SUPER ADMIN DITEMUKAN DI DATABASE SETELAH MEMUAT! Fungsionalitas super admin tidak akan bekerja.');
                  } else if (actualSuperAdmins.length === 1) {
                       console.warn(`[FIREBASE] Super Admin aktif di database adalah '${actualSuperAdmins[0]}'. Pastikan config.superAdminUsername sesuai jika ingin menggunakan '${superAdminUsername}'.`);
                       // Update config.superAdminUsername in memory if there's exactly one superadmin and it doesn't match?
                       // No, better to warn and rely on the one in DB if config doesn't match a superadmin.
                  } else {
                       console.warn(`[FIREBASE] Beberapa Super Admin ditemukan di database: ${actualSuperAdmins.join(', ')}. config.superAdminUsername adalah '${superAdminUsername}'.`);
                  }

             }
        } else {
            console.warn('[FIREBASE] Tidak ada data admin di Firebase.');
             admins = config.admins || {}; // Fallback to config if DB is empty
              if (Object.keys(admins).length > 0) {
                 console.log('[FIREBASE] Menggunakan admin dari config.js.');
                 saveAdminsToFirebase(); // Simpan admin dari config ke Firebase untuk pertama kali jika DB kosong
              } else {
                  console.error('[FIREBASE] TIDAK ADA DATA ADMIN DITEMUKAN DI CONFIG.JS ATAU FIREBASE! Tidak ada admin yang bisa login.');
              }
        }

        // --- QUICK REPLY TEMPLATES ---
        // Muat Quick Reply Templates
        console.log('[FIREBASE] Mencoba memuat quick reply templates...');
        const templatesSnapshot = await get(child(dbRef, 'quickReplyTemplates'));
        quickReplyTemplates = {}; // Reset in-memory state to ensure it's an object
        if (templatesSnapshot.exists()) {
            const firebaseTemplates = templatesSnapshot.val();
            if (firebaseTemplates && typeof firebaseTemplates === 'object') { // Ensure it's an object
                for (const encodedShortcut in firebaseTemplates) {
                     // Tambahkan cek `hasOwnProperty`
                    if (!Object.prototype.hasOwnProperty.call(firebaseTemplates, encodedShortcut)) continue;

                    const templateData = firebaseTemplates[encodedShortcut];
                    const shortcut = decodeFirebaseKey(encodedShortcut);
                     // Validasi data sebelum menambahkan ke state
                    if (shortcut && shortcut.startsWith('/') && typeof templateData.text === 'string') {
                        // Generating a stable ID from encoded shortcut
                        const templateId = encodedShortcut;
                        quickReplyTemplates[shortcut] = { id: templateId, shortcut: shortcut, text: templateData.text };
                    } else {
                         console.warn(`[FIREBASE] Entri template tidak valid ditemukan di DB: ${encodedShortcut}`, templateData);
                         // Tidak perlu menghapus dari DB di sini, fungsi save akan membersihkan yang tidak valid
                    }
                }
                console.log(`[FIREBASE] ${Object.keys(quickReplyTemplates).length} quick reply templates berhasil dimuat dari Firebase.`);
            } else {
                console.warn('[FIREBASE] Data quick reply templates di Firebase tidak valid (bukan objek). Mengabaikan data tersebut.');
                 quickReplyTemplates = {}; // Pastikan state tetap objek kosong
            }
        } else {
            console.log('[FIREBASE] Tidak ada quick reply templates di Firebase.');
             quickReplyTemplates = {}; // Pastikan state adalah objek kosong jika tidak ada data
        }
        // --- END QUICK REPLY TEMPLATES ---


    } catch (error) {
        console.error('[FIREBASE] Gagal memuat data dari Firebase:', error);
         // Ini adalah error fatal saat startup, re-throw untuk menghentikan server
         throw error;
    }
}

// Menyimpan Chat History ke Firebase
function saveChatHistoryToFirebase() {
    // console.log('[FIREBASE] Menyimpan riwayat chat ke Firebase...'); // Disable verbose logging
    const dbRef = ref(database, 'chatHistory');
    // Filter undefined values just in case, although serializing should handle it
    const sanitizedChatHistory = JSON.parse(JSON.stringify(chatHistory, (key, value) => value === undefined ? null : value));

    set(dbRef, sanitizedChatHistory)
        .then(() => {
            // console.log('[FIREBASE] Riwayat chat berhasil disimpan ke Firebase.'); // Disable verbose logging
        })
        .catch((error) => {
            console.error('[FIREBASE] Gagal menyimpan riwayat chat ke Firebase:', error);
        });
}

// Menyimpan Data Admin ke Firebase
function saveAdminsToFirebase() {
    const dbRef = ref(database, 'admins');
     const sanitizedAdmins = JSON.parse(JSON.stringify(admins, (key, value) => value === undefined ? null : value));
    set(dbRef, sanitizedAdmins)
        .then(() => {
            console.log('[FIREBASE] Data admin berhasil disimpan ke Firebase.');
            io.emit('registered_admins', admins); // Emit updated admins to all clients
             io.emit('update_online_admins', getOnlineAdminUsernames()); // Emit updated online status
        })
        .catch((error) => {
            console.error('[FIREBASE] Gagal menyimpan data admin ke Firebase:', error);
        });
}

// --- QUICK REPLY TEMPLATES ---
// Menyimpan Quick Reply Templates ke Firebase
async function saveQuickReplyTemplatesToFirebase() {
    console.log('[FIREBASE] Menyimpan quick reply templates ke Firebase...');
    const dbRef = ref(database, 'quickReplyTemplates');
    const firebaseData = {};
    // Convert backend object state to Firebase-friendly object
    for (const shortcut in quickReplyTemplates) {
         if (!Object.prototype.hasOwnProperty.call(quickReplyTemplates, shortcut)) continue;

        const template = quickReplyTemplates[shortcut];
         // Validate template structure before saving
         if (shortcut && shortcut.startsWith('/') && template && typeof template.text === 'string') {
             // Use encoded shortcut as Firebase key
             firebaseData[encodeFirebaseKey(shortcut)] = { text: template.text };
        } else {
             console.warn(`[FIREBASE] Mengabaikan template dengan struktur atau shortcut tidak valid saat menyimpan: '${shortcut}'`, template);
         }
    }

    try {
        await set(dbRef, firebaseData);
        console.log('[FIREBASE] Quick reply templates berhasil disimpan ke Firebase.');
        // Convert backend object state to array for frontend
        const quickReplyTemplatesArray = Object.values(quickReplyTemplates);
        io.emit('quick_reply_templates_updated', quickReplyTemplatesArray); // Emit updated templates (as array) to all clients
    } catch (error) {
        console.error('[FIREBASE] Gagal menyimpan quick reply templates ke Firebase:', error);
        // Tidak perlu re-throw error di sini, biarkan server tetap berjalan
        // throw error;
    }
}
// --- END QUICK REPLY TEMPLATES ---


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
        io.emit('initial_pick_status', pickedChats); // Send full state update
        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId && io.sockets.sockets.get(targetSocketId)) { // Check if socket is still online
          io.to(targetSocketId).emit('auto_release_notification', { chatId: normalizedChatId, message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} dilepas otomatis (tidak aktif).` }); // Use fallback
        }
      } else {
          console.log(`[TIMER] Timer auto-release untuk ${normalizedChatId} oleh ${username} habis, tetapi chat sudah tidak diambil oleh admin ini. Timer dibersihkan.`);
          delete chatReleaseTimers[normalizedChatId];
      }
    }, timeoutMs);
  }
}

// Mendapatkan daftar username admin yang sedang online
function getOnlineAdminUsernames() {
    // Filter out potential undefined/null values just in case
    return Object.values(adminSockets).map(adminInfo => adminInfo?.username).filter(Boolean);
}

// Mendapatkan info admin (termasuk role) berdasarkan Socket ID
function getAdminInfoBySocketId(socketId) {
    // Ensure adminSockets[socketId] exists and is an object before accessing properties
    return adminSockets[socketId] && typeof adminSockets[socketId] === 'object' ? adminSockets[socketId] : null;
}

// Membersihkan state admin saat disconnect/logout
function cleanupAdminState(socketId) {
    const adminInfo = getAdminInfoBySocketId(socketId);
    if (adminInfo) {
        const username = adminInfo.username;
        console.log(`[ADMIN] Membersihkan state untuk admin ${username} (Socket ID: ${socketId})`);
        const chatsToRelease = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === username);
        chatsToRelease.forEach(chatId => {
            clearAutoReleaseTimer(chatId);
            delete pickedChats[chatId];
            console.log(`[ADMIN] Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            io.emit('update_pick_status', { chatId: chatId, pickedBy: null }); // Notify others
        });

        delete adminSockets[socketId];
        delete usernameToSocketId[username];
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Update online list for everyone
        io.emit('initial_pick_status', pickedChats); // Send full state update
        return username; // Return username of cleaned up admin
    }
    return null; // Return null if no admin found for socketId
}

// Fungsi untuk memastikan chatId dalam format lengkap
function normalizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null; // Handle null/undefined/non-string

  // Basic normalization - WhatsApp IDs are either JID or group JID
   // Ensure it contains at least one number and an '@'
   if (!/\d@s\.whatsapp\.net$/.test(chatId) && !/-@g\.us$/.test(chatId)) {
       // Attempt to append default JID if it looks like just a number
       if(/^\d+$/.test(chatId)) {
            return `${chatId}@s.whatsapp.net`;
       }
       // Attempt to append group JID if it looks like number-number
        if(/^\d+-\d+$/.test(chatId)) {
             return `${chatId}@g.us`;
        }
        console.warn(`[NORMALIZE] Chat ID format tidak dikenali: ${chatId}`);
       return null; // Indicate invalid format if cannot normalize
   }

  return chatId; // Return as is if already in a recognized format
}

// Fungsi untuk decode kunci dari Firebase (membalikkan encodeFirebaseKey)
function decodeFirebaseKey(encodedKey) {
   if (!encodedKey || typeof encodedKey !== 'string') return null;
   return encodedKey
    .replace(/_dot_/g, '.')
    .replace(/_at_/g, '@')
    .replace(/_dollar_/g, '$')
    .replace(/_slash_/g, '/')
    .replace(/_openbracket_/g, '[')
    .replace(/_closebracket_/g, ']')
    .replace(/_hash_/g, '#');
}

// Fungsi untuk meng-encode kunci agar valid di Firebase
function encodeFirebaseKey(key) {
   if (!key || typeof key !== 'string') return null;
   return key
    .replace(/\./g, '_dot_')
    .replace(/@/g, '_at_')
    .replace(/\$/g, '_dollar_')
    .replace(/\//g, '_slash_')
    .replace(/\[/g, '_openbracket_')
    .replace(/\]/g, '_closebracket_')
    .replace(/#/g, '_hash_');
}

// Fungsi untuk mengecek apakah admin adalah Super Admin
function isSuperAdmin(username) {
     // Check if username exists in admins object and has role 'superadmin'
     // Use config.superAdminUsername as a fallback check, but rely on loaded admins data
     const isAdminInLoadedList = admins[username]?.role === 'superadmin';
     // const isConfigSuperAdmin = username === config.superAdminUsername && admins[username]?.role === 'superadmin'; // This check is redundant if we trust the DB role

     return isAdminInLoadedList; // Return true if the user in DB has superadmin role
}


// --- Setup Express & Server ---

// Memuat data dari Firebase sebelum memulai server atau WA
loadDataFromFirebase().then(() => {
    console.log("[SERVER] Data Firebase siap. Memulai koneksi WhatsApp dan Server HTTP.");
     connectToWhatsApp().catch(err => {
      console.error("[WA] Gagal memulai koneksi WhatsApp awal:", err);
       // Server might continue running without WA connection, or you might want to exit
       // process.exit(1); // Uncomment to exit if WA connection is mandatory for startup
    });

    server.listen(PORT, () => {
      console.log(`[SERVER] Server Helpdesk berjalan di http://localhost:${PORT}`);
      console.log(`[SERVER] Versi Aplikasi: ${config.version || 'N/A'}`);
    });

}).catch(err => {
    console.error("[SERVER] Gagal memuat data awal dari Firebase. Server tidak dapat dimulai.", err);
    process.exit(1); // Exit if initial data load fails
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
  console.log("[WA] Mencoba menghubungkan ke WhatsApp...");
  // auth_info_baileys will be created if it doesn't exist
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.baileysOptions?.printQRInTerminal ?? true,
    browser: Browsers.macOS('Desktop'),
    logger: logger,
     syncFullHistory: false,
    getMessage: async (key) => {
        // Baileys mungkin meminta pesan lama (misal untuk quote/reply)
        // Kita tidak menyimpan objek pesan Baileys lengkap, jadi kembalikan undefined.
        // console.warn(`[WA] Baileys meminta pesan ${key.id} dari ${key.remoteJid}. Tidak tersedia di history lokal.`);
        return undefined;
    }
  });

  // Event listeners for Baileys
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isOnline, isConnecting } = update;

    if (qr && !qrDisplayed) {
      qrDisplayed = true;
      console.log('[WA] QR Code diterima, pindai dengan WhatsApp Anda:');
      qrcode.generate(qr, { small: true });
       // Emit QR to all connected Super Admins
       for (const socketId in adminSockets) {
            if (Object.prototype.hasOwnProperty.call(adminSockets, socketId) && adminSockets[socketId]?.role === 'superadmin') {
                 io.to(socketId).emit('whatsapp_qr', qr);
            }
       }
       if (Object.keys(adminSockets).filter(id => adminSockets[id]?.role === 'superadmin').length === 0) {
           console.warn('[WA] Tidak ada Super Admin yang login. QR Code hanya ditampilkan di terminal.');
       }
    }

    if (connection === 'close') {
      qrDisplayed = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Reconnect reasons: https://github.com/WhiskeySockets/Baileys/blob/main/src/Utils/decode-wa-msg.ts#L23
      const shouldReconnect = ![401, 403, 411, 419].includes(statusCode); // 401: Auth failed, 403: Forbidden, 411: Gone, 419: Conflict

      console.error(`[WA] Koneksi WhatsApp terputus: ${lastDisconnect?.error?.message || 'Alasan tidak diketahui'} (Code: ${statusCode || 'N/A'}), Mencoba menyambung kembali: ${shouldReconnect}`);
      io.emit('whatsapp_disconnected', { reason: lastDisconnect?.error?.message || 'Unknown', statusCode, message: lastDisconnect?.error?.message }); // Emit message to frontend

      if (shouldReconnect) {
        console.log("[WA] Mencoba menyambung kembali dalam 10 detik...");
        setTimeout(connectToWhatsApp, 10000); // Reconnect after 10s
      } else {
        console.error("[WA] Tidak dapat menyambung kembali otomatis. Mungkin sesi invalid atau konflik. Perlu scan ulang QR.");
        // Emit fatal disconnect specifically to Super Admins, as they handle QR
        for (const socketId in adminSockets) {
             if (Object.prototype.hasOwnProperty.call(adminSockets, socketId) && adminSockets[socketId]?.role === 'superadmin') {
                 io.to(socketId).emit('whatsapp_fatal_disconnected', { reason: lastDisconnect?.error?.message || 'Auth Failed', statusCode, message: 'Sesi invalid atau konflik. Silakan Tampilkan QR untuk memulihkan (perlu scan ulang).' });
             } else {
                 // Notify regular admins about the fatal error and to contact Super Admin
                 io.to(socketId).emit('whatsapp_disconnected', { reason: lastDisconnect?.error?.message || 'Auth Failed', statusCode, message: 'Koneksi WhatsApp terputus secara fatal. Hubungi Super Admin untuk memulihkan.' });
             }
        }
         if (Object.keys(adminSockets).filter(id => adminSockets[id]?.role === 'superadmin').length === 0) {
             console.warn('[WA] Tidak ada Super Admin yang login untuk menerima notifikasi fatal disconnect.');
         }
      }
    } else if (connection === 'open') {
      console.log('[WA] Berhasil terhubung ke WhatsApp!');
      qrDisplayed = false;
      io.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
    } else {
        console.log(`[WA] Status koneksi WhatsApp: ${connection} ${isConnecting ? '(connecting)' : ''} ${isOnline ? '(online)' : ''}`);
        if (connection === 'connecting') {
            io.emit('whatsapp_connecting', {});
        }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // console.log(`[WA] Pesan ${type} diterima: ${messages.length}`); // Disable verbose logging
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
      // Ignore messages sent by us, status updates, or from the WA bot's own JID
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
           console.error(`[FIREBASE] Gagal meng-encode chatId: ${chatId}. Mengabaikan pesan masuk.`);
           continue;
       }


      let messageContent = null; // Main text content (for message bubble)
      let mediaData = null; // Base64 data for media
      let mediaType = null; // Baileys message type string (e.g., 'imageMessage')
      let mimeType = null; // Actual MIME type from Baileys props
       let fileName = null; // Original file name if applicable
       let messageTextSnippet = ''; // Snippet for chat list


      const messageBaileysType = message.message ? Object.keys(message.message)[0] : null; // e.g., 'imageMessage'
      const messageProps = message.message?.[messageBaileysType]; // Properties specific to the message type

       // Handle different message types
       switch (messageBaileysType) {
           case 'conversation':
           case 'extendedTextMessage':
               messageContent = messageProps?.text || messageProps?.conversation || '';
               messageTextSnippet = messageContent;
               mediaType = 'text'; // Custom type for text messages in our scheme
               break;
           case 'imageMessage':
           case 'videoMessage':
           case 'audioMessage':
           case 'documentMessage':
           case 'stickerMessage': // Stickers also have media
               mediaType = messageBaileysType;
               mimeType = messageProps?.mimetype;
                // Use original filename or a default based on type
               fileName = messageProps?.fileName || messageProps?.caption || `${mediaType.replace('Message', '')}_file`;
               if (mediaType === 'audioMessage' && messageProps?.ptt) fileName = 'Voice Note';

               messageContent = messageProps?.caption || `[${mediaType.replace('Message', '')}]`; // Caption or placeholder
               messageTextSnippet = messageProps?.caption || `[${mediaType.replace('Message', '')}]`; // Caption or placeholder for snippet

               // Attempt to download media
               try {
                 const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
                 if (buffer) {
                     mediaData = buffer.toString('base64');
                 } else {
                     console.warn(`[WA] Gagal mengunduh media (buffer kosong) dari ${chatId} untuk pesan ${message.key.id}`);
                     // Fallback text content if download fails
                     messageContent = `[Gagal mengunduh media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                     messageTextSnippet = `[Gagal unduh media ${mediaType.replace('Message', '')}]`;
                 }
               } catch (error) {
                 console.error(`[WA] Error mengunduh media dari ${chatId} untuk pesan ${message.key.id}:`, error);
                  // Fallback text content if download errors
                 messageContent = `[Gagal memuat media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                 messageTextSnippet = `[Error media ${mediaType.replace('Message', '')}]`;
               }
               break;
            case 'locationMessage':
                messageContent = `[Lokasi: ${messageProps?.degreesLatitude}, ${messageProps?.degreesLongitude}]`;
                messageTextSnippet = '[Lokasi]';
                mediaType = 'location'; // Custom type
                // Optionally store location data: mediaData = JSON.stringify(messageProps);
                break;
            case 'contactMessage':
                messageContent = `[Kontak: ${messageProps?.displayName || 'Nama tidak diketahui'}]`;
                 messageTextSnippet = `[Kontak]`;
                 mediaType = 'contact'; // Custom type
                 // Optionally store vcard: mediaData = messageProps?.vcard;
                 break;
            case 'liveLocationMessage':
                 messageContent = '[Live Lokasi]';
                 messageTextSnippet = '[Live Lokasi]';
                 mediaType = 'liveLocation'; // Custom type
                 // Optionally store data: mediaData = JSON.stringify(messageProps);
                 break;
            case 'protocolMessage':
            case 'reactionMessage':
            case 'senderKeyDistributionMessage':
            case 'editedMessage':
            case 'keepalive':
                 // These are often service messages, ignore for history/display
                 // console.log(`[WA] Skipping message type: ${messageBaileysType} from ${chatId}`);
                 continue; // Skip these message types entirely
            default:
                // Fallback for unknown or unhandled types
                console.warn(`[WA] Menerima pesan dengan tipe tidak dikenal atau tidak ditangani: ${messageBaileysType} dari ${chatId}`);
                messageContent = `[Pesan tidak dikenal: ${messageBaileysType || 'N/A'}]`;
                messageTextSnippet = `[${messageBaileysType || 'Unknown'}]`;
                mediaType = 'unknown'; // Custom type
                // Optionally store raw message: mediaData = JSON.stringify(message);
       }


      const messageData = {
        id: message.key.id,
        from: chatId, // Store original sender (the customer)
        text: messageContent || '', // Use messageContent, default to empty string
        mediaData: mediaData, // Base64 media data (if any)
        mediaType: mediaType, // Baileys message type string or custom type (if any)
        mimeType: mimeType, // Actual MIME type (if any)
        fileName: fileName, // File name (if any)
        snippet: messageTextSnippet || '', // Snippet for chat list, default to empty string
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(),
        unread: true, // Mark incoming messages as unread by default
        type: 'incoming'
      };


      // Initialize chat entry if it doesn't exist or if messages array is missing
      if (!chatHistory[encodedChatId] || !Array.isArray(chatHistory[encodedChatId].messages)) { // Ensure messages is array
        console.log(`[HISTORY] Membuat/memperbaiki entri baru untuk chat ${chatId}.`);
         // Ensure status exists or set default
        chatHistory[encodedChatId] = { status: chatHistory[encodedChatId]?.status || 'open', messages: [] };
      }
       if (!chatHistory[encodedChatId].status) {
           chatHistory[encodedChatId].status = 'open';
       }

      // Add message to the messages array, deduplicate by ID
      if (!chatHistory[encodedChatId].messages.some(m => m && typeof m === 'object' && m.id === messageData.id)) { // Check for null/undefined message objects
        console.log(`[HISTORY] Menambahkan pesan masuk baru (ID: ${messageData.id}) ke chat ${chatId}`);
        chatHistory[encodedChatId].messages.push(messageData);
        saveChatHistoryToFirebase(); // Save after adding new message

        io.emit('new_message', { // Emit to all clients
             ...messageData,
             chatId: chatId, // Ensure chatId is top-level for client
             chatStatus: chatHistory[encodedChatId].status // Include chat status
         });

        // Send notification to online admins *not* handling this chat
        const pickedBy = pickedChats[chatId];
        const onlineAdmins = getOnlineAdminUsernames();
        onlineAdmins.forEach(adminUsername => {
            const adminSocketId = usernameToSocketId[adminUsername];
            // Only send notification if admin is online AND not the one handling the chat AND chat is open
            if (adminSocketId && pickedBy !== adminUsername && chatHistory[encodedChatId].status === 'open') {
                // Check if the socket is still connected before emitting
                if (io.sockets.sockets.get(adminSocketId)) {
                      const notificationBody = messageTextSnippet || '[Pesan Baru]'; // Use snippet for notification
                     io.to(adminSocketId).emit('notification', {
                        title: `Pesan Baru (${chatId.split('@')[0] || chatId})`, // Use chatId if name split fails
                        body: notificationBody,
                        icon: '/favicon.ico',
                        chatId: chatId
                     });
                } else {
                     console.warn(`[NOTIF] Socket ${adminSocketId} untuk admin ${adminUsername} terputus, tidak mengirim notifikasi.`);
                }
            }
        });

      } else {
         // console.log(`[WA] Pesan duplikat terdeteksi di upsert (ID: ${messageData.id}), diabaikan.`); // Disable verbose logging
      }
    }
  });

}


// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`[SOCKET] Admin terhubung: ${socket.id}`);

  // Send initial data required immediately upon connection
  socket.emit('registered_admins', admins);
  socket.emit('update_online_admins', getOnlineAdminUsernames());
  socket.emit('initial_pick_status', pickedChats);
  // --- FIX: Ensure quickReplyTemplates is an array for frontend ---
  io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Send templates as an array
  // --- END FIX ---

  // Send initial WhatsApp status on connection
  if (sock?.user?.id) { // Check if sock and user.id exist
      socket.emit('whatsapp_connected', { username: sock.user.id });
  } else if (qrDisplayed) {
       // If QR is displayed, it means WA is waiting for scan
       socket.emit('whatsapp_fatal_disconnected', { message: 'Sesi invalid. Menunggu QR Code baru...' }); // Simulate fatal to indicate need for QR
       if (currentQrCode) { // Only send QR if we have it
            socket.emit('whatsapp_qr', currentQrCode);
       }
  }
   else {
      // Otherwise, assume it's trying to connect or disconnected
       // Check socket connection state more reliably if available
      const waConnectionState = sock?.ws?.readyState; // WebSocket readyState
       if (waConnectionState === sock?.ws.OPEN) { // Check against sock's WebSocket state
            socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
       } else if (waConnectionState === sock?.ws.CONNECTING) {
            socket.emit('whatsapp_connecting', {});
       } else { // Assuming WA is disconnected or not initialized
           socket.emit('whatsapp_disconnected', { reason: 'Not Initialized/Disconnected', statusCode: 'N/A', message: 'Koneksi WhatsApp belum siap.' });
       }
  }


  socket.on('request_initial_data', () => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (adminInfo) {
      console.log(`[SOCKET] Admin ${adminInfo.username} meminta data awal.`);
      const decodedChatHistory = {};
      // Iterate through encoded keys from backend state
      for (const encodedKey in chatHistory) {
         // Add hasOwnProperty check
         if (!Object.prototype.hasOwnProperty.call(chatHistory, encodedKey)) continue;

        const decodedKey = decodeFirebaseKey(encodedKey);
        // Ensure decodedKey is valid and chat entry exists and has messages array
         if (decodedKey && chatHistory[encodedKey] && Array.isArray(chatHistory[encodedKey].messages)) {
            decodedChatHistory[decodedKey] = {
                status: chatHistory[encodedKey].status || 'open', // Ensure status default
                messages: chatHistory[encodedKey].messages.map((message) => ({
                    ...message,
                    chatId: decodedKey // Add decoded chatId to each message
                }))
            };
         } else if (decodedKey && chatHistory[encodedKey]) {
              // Handle case where chat entry exists but messages is not an array (based on validation in loadData)
              decodedChatHistory[decodedKey] = {
                   status: chatHistory[encodedKey].status || 'open',
                   messages: [] // Send empty array
               };
              console.warn(`[SOCKET] Chat history untuk ${decodedKey} memiliki struktur pesan tidak valid.`);
         } else {
              console.warn(`[SOCKET] Mengabaikan chat history dengan encoded key tidak valid: ${encodedKey}`);
         }
      }
       // Send initial data including chat history, admins, role, and quick replies (as array)
      socket.emit('initial_data', { chatHistory: decodedChatHistory, admins: admins, currentUserRole: adminInfo.role, quickReplies: Object.values(quickReplyTemplates) });
    } else {
      console.warn(`[SOCKET] Socket ${socket.id} meminta data awal sebelum login.`);
      // Frontend handles login request on reconnect_failed, no specific emit needed here
    }
  });

  socket.on('get_chat_history', (chatId) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[SOCKET] Socket ${socket.id} meminta history sebelum login.`);
        return socket.emit('chat_history_error', { chatId, message: 'Login diperlukan.' });
    }
    const normalizedChatId = normalizeChatId(chatId); // Normalize input chatId
    if (!normalizedChatId) { // Check if normalization failed
         console.warn(`[SOCKET] Admin ${adminInfo?.username} meminta history dengan ID chat tidak valid: ${chatId}`);
         return socket.emit('chat_history_error', { chatId, message: 'Chat ID tidak valid.' });
    }

    const encodedChatId = encodeFirebaseKey(normalizedChatId);
    if (!encodedChatId) {
        console.error(`[SOCKET] Gagal meng-encode chatId untuk get_chat_history: ${normalizedChatId}`);
        return socket.emit('chat_history_error', { chatId: normalizedChatId, message: 'Kesalahan internal: ID chat tidak valid.' });
    }

    const chatEntry = chatHistory[encodedChatId];
     // Ensure messages is an array before mapping
    const history = Array.isArray(chatEntry?.messages) ? chatEntry.messages.map((message) => ({
      ...message,
      chatId: normalizedChatId // Ensure chatId is correct on message objects sent to client
    })) : [];
    const status = chatEntry?.status || 'open';

    console.log(`[SOCKET] Mengirim history untuk chat ${normalizedChatId} (${history.length} pesan) ke admin ${adminInfo.username}.`);
    socket.emit('chat_history', { chatId: normalizedChatId, messages: history, status: status });
  });

  socket.on('admin_login', ({ username, password }) => {
      console.log(`[ADMIN] Menerima percobaan login untuk: ${username}`);
    const adminUser = admins[username]; // Look up in loaded admins data
    if (adminUser && adminUser.password === password) {
      const existingSocketId = usernameToSocketId[username];
      if (existingSocketId && io.sockets.sockets.get(existingSocketId)) {
         console.warn(`[ADMIN] Login gagal: Admin ${username} sudah login dari socket ${existingSocketId}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain.' });
         return;
      }

      console.log(`[ADMIN] Login berhasil: ${username} (Socket ID: ${socket.id})`);
      adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
      usernameToSocketId[username] = socket.id;

      // Send login success with role and initial state
      socket.emit('login_success', { username: username, initials: adminUser.initials, role: adminUser.role || 'admin', currentPicks: pickedChats });
      // --- FIX: Ensure templates are sent as an array on login ---
      io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates));
      // --- END FIX ---
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Notify others about new online admin

    } else {
      console.log(`[ADMIN] Login gagal untuk username: ${username}. Username atau password salah.`);
      socket.emit('login_failed', { message: 'Username atau password salah.' });
    }
  });

  socket.on('admin_reconnect', ({ username }) => {
      console.log(`[ADMIN] Menerima percobaan reconnect untuk: ${username} (Socket ID: ${socket.id})`);
    const adminUser = admins[username]; // Look up in loaded admins data
    if (adminUser) {
        const existingSocketId = usernameToSocketId[username];
        if (existingSocketId && existingSocketId !== socket.id && io.sockets.sockets.get(existingSocketId)) {
             console.warn(`[ADMIN] Admin ${username} mereconnect. Menutup socket lama ${existingSocketId}.`);
             cleanupAdminState(existingSocketId); // Clean up old socket state
             io.sockets.sockets.get(existingSocketId).disconnect(true); // Disconnect old socket
        } else if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
             console.log(`[ADMIN] Admin ${username} mereconnect. Socket lama ${existingSocketId} sudah tidak aktif. Membersihkan state lama.`);
              cleanupAdminState(existingSocketId); // Clean up old socket state
        }

        console.log(`[ADMIN] Reconnect berhasil untuk ${username} (Socket ID: ${socket.id})`);
        adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
        usernameToSocketId[username] = socket.id;

        // Send reconnect success with role and initial state
        socket.emit('reconnect_success', { username: username, currentPicks: pickedChats, role: adminUser.role || 'admin' });
        // --- FIX: Ensure templates are sent as an array on reconnect ---
        io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates));
        // --- END FIX ---
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Notify others about online status update
    } else {
        console.warn(`[ADMIN] Reconnect failed: Admin ${username} not found in registered admins.`);
        socket.emit('reconnect_failed'); // Indicate reconnect failed
    }
  });


  socket.on('admin_logout', () => {
    // cleanupAdminState handles state removal and emitting online status updates
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} logout.`);
        socket.emit('logout_success'); // Optional: client might just reset UI anyway
    } else {
         console.warn(`[ADMIN] Socket ${socket.id} mencoba logout tapi tidak terdaftar sebagai admin login.`);
         socket.emit('logout_failed', { message: 'Not logged in.' }); // Optional
    }
  });

  socket.on('pick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
    const username = adminInfo.username;
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

     const encodedChatId = encodeFirebaseKey(normalizedChatId);
     // Check if chat exists in history and is closed
     if (chatHistory[encodedChatId]?.status === 'closed') {
         console.warn(`[PICK] Admin ${username} mencoba mengambil chat tertutup ${normalizedChatId}`);
         return socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa diambil.' });
     }
     // If chat doesn't exist in history, allow picking but log it
      if (!chatHistory[encodedChatId]) {
          console.warn(`[PICK] Admin ${username} mengambil chat baru ${normalizedChatId} yang belum ada di history.`);
          // Optionally create the chat entry here with default status 'open'
           chatHistory[encodedChatId] = { status: 'open', messages: [] };
           saveChatHistoryToFirebase(); // Save the new chat entry
      }


    if (pickedChats[normalizedChatId] && pickedChats[normalizedChatId] !== username) {
      console.warn(`[PICK] Admin ${username} mencoba mengambil chat ${normalizedChatId} yang sudah diambil oleh ${pickedChats[normalizedChatId]}`);
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedChats[normalizedChatId]}.` });
    } else if (!pickedChats[normalizedChatId]) {
      pickedChats[normalizedChatId] = username;
      console.log(`[PICK] Admin ${username} mengambil chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username });
      io.emit('initial_pick_status', pickedChats); // Send full state update to sync all clients

      // Start auto-release timer only if timeout is configured
      if (config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(normalizedChatId, username);
      }


       const chatEntry = chatHistory[encodedChatId];
       // Mark incoming messages as read for this chat if it exists and has messages
       if (chatEntry?.messages) { // Ensure messages array exists
           let changed = false;
           // Iterate backwards from the last message
           for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                // Ensure message object is valid
                if (!chatEntry.messages[i] || typeof chatEntry.messages[i] !== 'object') continue;

                if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                    chatEntry.messages[i].unread = false;
                    changed = true;
                } else if (chatEntry.messages[i].type === 'outgoing') {
                    // Stop marking read when we hit an outgoing message
                    break;
                }
           }
           if (changed) {
               console.log(`[MARK] Mark incoming messages as read for chat ${normalizedChatId} by ${adminInfo.username}.`);
               saveChatHistoryToFirebase(); // Save changes
               io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Notify clients to update UI
           }
       }
    } else {
      console.log(`[PICK] Admin ${username} mengklik pick lagi untuk ${normalizedChatId}, mereset timer.`);
       // Only reset timer if auto-release is enabled
      if (config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(normalizedChatId, username);
           socket.emit('pick_info', { chatId: normalizedChatId, message: 'Timer auto-release direset.' }); // Optional info feedback
      } else {
           socket.emit('pick_info', { chatId: normalizedChatId, message: 'Chat ini sudah diambil oleh Anda.' }); // Optional info feedback
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
    // Allow unpicking if picked by current user OR if is Super Admin
    if (pickedBy === username || isSuperAdmin(username)) {
        if (pickedBy) { // Check if it was actually picked before deleting
            clearAutoReleaseTimer(normalizedChatId);
            delete pickedChats[normalizedChatId];
            console.log(`[PICK] Admin ${username} melepas chat ${normalizedChatId}`);
            io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
             io.emit('initial_pick_status', pickedChats); // Send full state update
        } else {
            console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil.`);
             socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
        }
    } else if (pickedBy) { // If picked by someone else and not Super Admin
       console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang diambil oleh ${pickedBy}. Akses ditolak.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedBy} atau Super Admin yang bisa melepas chat ini.` });
    } else { // Should be covered by the first 'if', but as fallback
         console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} dalam keadaan ambigu.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
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
      const senderAdminRole = adminInfo.role; // Store role for validation

      const normalizedChatId = normalizeChatId(chatId);

      if (!normalizedChatId || !targetAdminUsername || typeof targetAdminUsername !== 'string') {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi dengan data tidak lengkap atau salah format.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Data tidak lengkap atau target admin tidak valid.' });
      }

      const currentPickedBy = pickedChats[normalizedChatId];
      // Check if sender is the picker OR is a Super Admin
      if (currentPickedBy !== senderAdminUsername && !isSuperAdmin(senderAdminUsername)) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi chat ${normalizedChatId} yang diambil oleh ${currentPickedBy || 'tidak ada'}. Akses ditolak.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: currentPickedBy ? `Chat ini sedang ditangani oleh ${currentPickedBy}.` : 'Chat ini belum diambil oleh Anda.' });
      }
      if (senderAdminUsername === targetAdminUsername) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke diri sendiri.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      }
      // Check if target admin exists in the loaded admin list
      if (!admins[targetAdminUsername]) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke admin target tidak dikenal: ${targetAdminUsername}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: `Admin target '${targetAdminUsername}' tidak ditemukan.` });
      }

      const encodedChatId = encodeFirebaseKey(normalizedChatId);
      // Check if chat exists and is closed
      if (chatHistory[encodedChatId]?.status === 'closed') {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan chat tertutup ${normalizedChatId}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa didelegasikan.' });
      }
       // If chat doesn't exist in history, allow delegation but log it
      if (!chatHistory[encodedChatId]) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat baru ${normalizedChatId} yang belum ada di history.`);
           // Optionally create the chat entry here with default status 'open'
           chatHistory[encodedChatId] = { status: 'open', messages: [] };
           // await saveChatHistoryToFirebase(); // Save the new chat entry - Save is done after update_pick_status below
      }


      console.log(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId); // Clear timer for the sender's pick
      pickedChats[normalizedChatId] = targetAdminUsername; // Set the new picker
      // Start auto-release timer for the new picker if enabled
      if (config.chatAutoReleaseTimeoutMinutes > 0) {
          startAutoReleaseTimer(normalizedChatId, targetAdminUsername);
      }


      // Save history only if a new chat entry was created above
      // saveChatHistoryToFirebase(); // Or save here every time if you want to be sure status/messages[] is there

      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername }); // Update pick status for everyone
      io.emit('initial_pick_status', pickedChats); // Send full state update to sync all clients

      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId && io.sockets.sockets.get(targetSocketId)) { // Check if target admin is online
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} didelegasikan kepada Anda oleh ${senderAdminUsername}.` // Use chatId as fallback
          });
      } else {
           console.warn(`[DELEGATE] Target admin ${targetAdminUsername} offline, tidak mengirim notifikasi delegasi.`);
      }

      socket.emit('delegate_success', { chatId: normalizedChatId, targetAdminUsername }); // Confirm to sender
  });


  socket.on('reply_message', async ({ to, text, media }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[REPLY] Socket ${socket.id} mencoba kirim pesan sebelum login.`);
        return socket.emit('send_error', { to: to, text, message: 'Login diperlukan.' });
    }
    const username = adminInfo.username;

    const chatId = normalizeChatId(to); // Normalize the target chat ID
    if (!chatId || (!text && !media)) { // Check if target ID is valid and there is content
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan dengan data tidak lengkap atau ID chat tidak valid.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Data tidak lengkap (ID chat, teks, atau media kosong) atau ID chat tidak valid.' });
    }
     // Check WhatsApp connection state
    if (!sock || sock.ws.readyState !== sock.ws.OPEN) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan, tapi koneksi WA tidak siap.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Koneksi WhatsApp belum siap. Silakan coba lagi nanti.' });
    }

    const pickedBy = pickedChats[chatId];
    // Allow sending if picked by current user OR is Super Admin
    const canReply = pickedBy === username || isSuperAdmin(username);

    if (!canReply) {
         const errorMsg = pickedBy ? `Sedang ditangani oleh ${pickedBy}. Ambil alih chat ini terlebih dahulu.` : 'Ambil chat ini terlebih dahulu.';
         console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat ${chatId}. ${errorMsg}`);
        return socket.emit('send_error', { to: chatId, text, message: errorMsg });
    }

     const encodedChatId = encodeFirebaseKey(chatId);
     // Check if chat exists in history and is closed
     if (chatHistory[encodedChatId]?.status === 'closed') {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat tertutup ${chatId}.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Chat sudah ditutup. Tidak bisa mengirim balasan.' });
    }
     // If chat doesn't exist in history, create it now with default status 'open'
     if (!chatHistory[encodedChatId]) {
          console.log(`[REPLY] Admin ${username} mengirim pesan ke chat baru ${chatId} yang belum ada di history.`);
          chatHistory[encodedChatId] = { status: 'open', messages: [] };
           // No need to save here, save is done after adding message below
      }


    try {
      // Get admin initials for outgoing message display
      const adminInfoFromAdmins = admins[username];
      const adminInitials = (adminInfoFromAdmins?.initials || username.substring(0, 3).toUpperCase()).substring(0,3);

      // Add initials prefix to text if text exists, or use initials alone if only media
      const textContent = text?.trim() || ''; // Use trimmed text or empty string
      const textForSendingToWA = textContent.length > 0 ? `${textContent}\n\n-${adminInitials}` : (media ? `-${adminInitials}` : '');


      let sentMsgResult;
      let sentMediaType = null;
      let sentMimeType = null;
      let sentFileName = null;

      if (media) {
        if (!media.data || !media.type) {
             console.error(`[REPLY] Media data atau type kosong untuk chat ${chatId}`);
             return socket.emit('send_error', { to: chatId, text, media, message: 'Data media tidak valid.' });
        }
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const mediaMimeType = media.mimeType || media.type; // Use provided mimeType or guess from type

        const mediaOptions = {
          mimetype: mediaMimeType,
          fileName: media.name || 'file',
          caption: textForSendingToWA || undefined // Send the text with initials as caption
        };

        console.log(`[WA] Mengirim media (${mediaMimeType}) ke ${chatId} oleh ${username}...`);

        // Handle different media types for sending
        if (media.type.startsWith('image/')) {
             sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, ...mediaOptions });
             sentMediaType = 'imageMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        } else if (media.type.startsWith('video/')) {
             sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, ...mediaOptions });
             sentMediaType = 'videoMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        } else if (media.type.startsWith('audio/')) {
           // Check if it looks like a voice note based on MIME type
           const isVoiceNote = mediaOptions.mimetype === 'audio/ogg; codecs=opus' || mediaOptions.mimetype === 'audio/mpeg' || mediaOptions.mimetype === 'audio/wav';
            // For voice notes, send as audio with ptt: true and ignore caption. Send text separately if it exists.
            if (isVoiceNote) {
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: true });
                  // If there was text alongside a voice note, send it as a separate text message
                 if (textContent.length > 0) {
                     console.log(`[WA] Mengirim teks caption VN terpisah ke ${chatId}`);
                     await sock.sendMessage(chatId, { text: `-${adminInitials}: ${textContent}` }); // Prepend initials to caption
                 }
            } else { // Regular audio file
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: false, caption: mediaOptions.caption });
            }
            sentMediaType = 'audioMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;

        } else if (media.type === 'application/pdf' || media.type.startsWith('application/') || media.type.startsWith('text/')) {
             sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, ...mediaOptions });
              sentMediaType = 'documentMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        }
         // Add handler for stickers if needed for sending
         // else if (media.type === 'stickerMessage') {
         //      sentMsgResult = await sock.sendMessage(chatId, { sticker: mediaBuffer, ...mediaOptions });
         //      sentMediaType = 'stickerMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name || 'sticker';
         // }
        else {
          console.warn(`[REPLY] Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to: chatId, text, media, message: 'Tipe media tidak didukung.' });
          return; // Stop processing on unsupported media type
        }

      } else { // Text message only
        if (textForSendingToWA.trim().length > 0) { // Ensure text content is not just initials alone if original text was empty
           console.log(`[WA] Mengirim teks ke ${chatId} oleh ${username}...`);
           sentMsgResult = await sock.sendMessage(chatId, { text: textForSendingToWA });
            sentMediaType = 'conversation';
            sentMimeType = 'text/plain'; // Standard mime type for plain text
            sentFileName = null; // No filename for text
        } else {
            console.warn(`[REPLY] Admin ${username} mencoba kirim pesan kosong.`);
            socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten untuk dikirim.' });
            return; // Stop processing if no text and no media
        }
      }

      // Ensure sentMsgResult is an array and get the first message object
      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      // Check if the sent message object is valid
      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('[WA] sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.', sentMsgResult);
          socket.emit('send_error', { to: chatId, text, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          return; // Stop processing on invalid response
      }

      // Create the outgoing message data object for history and clients
      const outgoingMessageData = {
        id: sentMsg.key.id, // WhatsApp message ID
        from: username, // Admin's username
        to: chatId, // Customer's JID
        text: textContent, // Original text content (without initials prefix for display in bubble)
        mediaType: sentMediaType, // Baileys message type or custom type
        mimeType: sentMimeType, // MIME type of the sent media (if any)
        mediaData: media?.data || null, // Base64 media data (if available from client)
        fileName: sentFileName, // File name (if any)
        initials: adminInitials, // Admin's initials
        timestamp: sentMsg.messageTimestamp // Timestamp from WhatsApp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString()
          : new Date().toISOString(), // Fallback to current time
        type: 'outgoing', // Message direction
         // outgoing messages are considered read by default
      };

      // Ensure encodedChatId is valid before accessing chatHistory
      if (!encodedChatId) {
           console.error('[FIREBASE] Gagal meng-encode chatId untuk menyimpan pesan keluar:', chatId);
           // Even if we can't save, notify client that send was attempted
           socket.emit('send_error', { to: chatId, text: textContent, media, message: 'Kesalahan internal saat menyimpan history. Pesan mungkin terkirim tetapi tidak tersimpan.' });
           // Continue processing to emit to other clients, but log error
      } else {
           // Ensure chat entry and messages array exist
          if (!chatHistory[encodedChatId] || !Array.isArray(chatHistory[encodedChatId].messages)) {
               console.log(`[HISTORY] Membuat/memperbaiki entri chat ${chatId} untuk pesan keluar.`);
               chatHistory[encodedChatId] = { status: chatHistory[encodedChatId]?.status || 'open', messages: [] };
           }

           // Add the outgoing message to history, deduplicate by ID
           if (!chatHistory[encodedChatId].messages.some(m => m && typeof m === 'object' && m.id === outgoingMessageData.id)) {
             console.log(`[HISTORY] Menambahkan pesan keluar baru (ID: ${outgoingMessageData.id}) ke chat ${chatId}`);
             chatHistory[encodedChatId].messages.push(outgoingMessageData);
             saveChatHistoryToFirebase(); // Save after adding message
           } else {
               console.warn(`[HISTORY] Pesan keluar duplikat terdeteksi (ID: ${outgoingMessageData.id}), diabaikan penambahannya ke history.`);
           }
      }


      // Emit the outgoing message to all clients (including sender) to update their UI
      io.emit('new_message', {
          ...outgoingMessageData,
          chatId: chatId, // Ensure chatId is top-level
          chatStatus: chatHistory[encodedChatId]?.status || 'open' // Include chat status
      });

      // Send confirmation to the original sender's socket
      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.to
      });

      // Reset auto-release timer if the message was sent by the current picker
      if (pickedChats[chatId] === username && config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(chatId, username);
      }


    } catch (error) {
      console.error(`[REPLY] Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      // Send error feedback to the original sender's socket
      socket.emit('send_error', { to: chatId, text: textContent, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  socket.on('mark_as_read', ({ chatId }) => {
     const adminInfo = getAdminInfoBySocketId(socket.id);
     if (!adminInfo || !chatId) {
         console.warn(`[SOCKET] Permintaan mark_as_read tanpa login atau chat ID: Socket ${socket.id}`);
         return;
     }

     const normalizedChatId = normalizeChatId(chatId);
     if (!normalizedChatId) {
          console.warn(`[SOCKET] Admin ${adminInfo?.username} mencoba mark_as_read dengan ID chat tidak valid: ${chatId}`);
          return;
     }
     const encodedChatId = encodeFirebaseKey(normalizedChatId);
     if (!encodedChatId) {
         console.error(`[FIREBASE] Gagal meng-encode chatId untuk mark_as_read: ${normalizedChatId}`);
         return;
     }

     const pickedBy = pickedChats[normalizedChatId];
     // Allow marking as read if Super Admin OR if picked by the current user
     if (isSuperAdmin(adminInfo.username) || pickedBy === adminInfo.username) {
         const chatEntry = chatHistory[encodedChatId];
         if (chatEntry?.messages) { // Ensure chat entry and messages array exist
              let changed = false;
              // Iterate backwards from the last message
              for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                  // Ensure message object is valid and is an unread incoming message
                   if (!chatEntry.messages[i] || typeof chatEntry.messages[i] !== 'object') continue;

                   if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                       chatEntry.messages[i].unread = false;
                       changed = true;
                   } else if (chatEntry.messages[i].type === 'outgoing') {
                        // Stop marking read when we hit an outgoing message
                        break;
                   }
              }
              if (changed) {
                  console.log(`[MARK] Mark incoming messages as read for chat ${normalizedChatId} by ${adminInfo.username}.`);
                  saveChatHistoryToFirebase(); // Save the changes
                  io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Notify all clients to update UI
              }
         } else {
             console.warn(`[MARK] Chat ${normalizedChatId} not found or has no messages to mark as read.`);
         }
     } else {
         console.warn(`[MARK] Admin ${adminInfo.username} mencoba mark_as_read chat ${normalizedChatId} yang tidak ditanganinya. Akses ditolak.`);
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
        const encodedChatId = encodeFirebaseKey(normalizedChatId);
        if (!encodedChatId) {
             console.error(`[SUPERADMIN] Gagal meng-encode chatId untuk delete_chat: ${normalizedChatId}`);
             return socket.emit('superadmin_error', { message: 'Kesalahan internal: ID chat tidak valid.' });
        }


        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus chat history untuk ${normalizedChatId}`);

        // Check if chat exists in history before attempting deletion
        if (chatHistory[encodedChatId]) {
            // Remove from backend state
            delete chatHistory[encodedChatId];
            // Remove from picked state if picked
            if (pickedChats[normalizedChatId]) {
                clearAutoReleaseTimer(normalizedChatId);
                delete pickedChats[normalizedChatId];
            }

            // Delete from Firebase
            const success = await deleteChatHistoryFromFirebase(encodedChatId);

            if (success) {
                // Emit updates to all clients
                io.emit('chat_history_deleted', { chatId: normalizedChatId });
                 // No need for update_pick_status here, initial_pick_status handles it
                 io.emit('initial_pick_status', pickedChats);
                socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dihapus.` }); // Use chatId as fallback
            } else {
                 console.error(`[SUPERADMIN] Gagal menghapus chat ${normalizedChatId} dari Firebase.`);
                 socket.emit('superadmin_error', { message: 'Gagal menghapus chat dari database.' });
                 // Note: If Firebase delete failed, the chat is gone from backend state but not DB.
                 // A reload/reconnect would bring it back from DB. This is a potential inconsistency edge case.
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

         // Reset backend state
         chatHistory = {};
         for (const chatId in pickedChats) {
             if (Object.prototype.hasOwnProperty.call(pickedChats, chatId)) {
                clearAutoReleaseTimer(chatId);
             }
         }
         pickedChats = {};

         // Delete from Firebase
         const success = await deleteAllChatHistoryFromFirebase();

         if (success) {
             // Emit updates to all clients
             io.emit('all_chat_history_deleted');
             io.emit('initial_pick_status', pickedChats); // Send empty picked state
             socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus.' });
         } else {
              console.error(`[SUPERADMIN] Gagal menghapus semua chat dari Firebase.`);
             socket.emit('superadmin_error', { message: 'Gagal menghapus semua chat dari database.' });
             // Note: If Firebase delete failed, backend state is empty, but DB might not be.
             // A reload/reconnect would bring back data from DB.
         }
     });

     socket.on('add_admin', ({ username, password, initials, role }) => {
        console.log(`[SUPERADMIN] Menerima permintaan tambah admin: ${username}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah admin.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menambah admin.' });
        }

        if (!username || typeof username !== 'string' || !password || typeof password !== 'string' || !initials || typeof initials !== 'string') {
             console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} data tidak lengkap atau format salah.`);
            return socket.emit('superadmin_error', { message: 'Username, password, dan initials harus diisi dengan format yang benar.' });
        }
         const cleanedInitials = initials.trim().toUpperCase();
         if (cleanedInitials.length === 0 || cleanedInitials.length > 3) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} initials tidak valid: '${initials}' tidak 1-3 huruf.`);
              return socket.emit('superadmin_error', { message: 'Initials harus 1-3 karakter huruf.' });
         }
          // Allow A-Z only for initials
         if (!/^[A-Z]+$/.test(cleanedInitials)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} initials mengandung karakter non-huruf: '${initials}'`);
              return socket.emit('superadmin_error', { message: 'Initials hanya boleh berisi huruf A-Z.' });
         }

        if (admins[username]) { // Check against loaded admins data
            console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menambah admin '${username}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Admin dengan username '${username}' sudah ada.` });
        }
         const validRoles = ['admin', 'superadmin'];
         if (!role || typeof role !== 'string' || !validRoles.includes(role)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} role tidak valid: ${role}`);
              return socket.emit('superadmin_error', { message: 'Role admin tidak valid. Gunakan "admin" atau "superadmin".' });
         }
         // Prevent regular admin from creating Super Admin
         if (role === 'superadmin' && !isSuperAdmin(adminInfo.username)) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} (role ${adminInfo.role}) mencoba menambah admin dengan role 'superadmin'. Akses ditolak.`);
              return socket.emit('superadmin_error', { message: 'Hanya Super Admin yang bisa membuat Super Admin baru.' });
         }


        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menambah admin baru: ${username} (${role})`);

        // Update backend state
        admins[username] = {
            password: password,
            initials: cleanedInitials,
            role: role
        };

        // Save to Firebase and emit updates
        saveAdminsToFirebase();

        socket.emit('superadmin_success', { message: `Admin '${username}' berhasil ditambahkan.` });
     });

      socket.on('delete_admin', ({ usernameToDelete }) => {
          console.log(`[SUPERADMIN] Menerima permintaan hapus admin: ${usernameToDelete}`);
          const adminInfo = getAdminInfoBySocketId(socket.id);
          if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
              console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus admin.`);
              return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus admin.' });
          }

          if (!usernameToDelete || typeof usernameToDelete !== 'string') {
               console.warn(`[SUPERADMIN] Permintaan hapus admin dari ${adminInfo.username} data tidak lengkap atau format salah.`);
              return socket.emit('superadmin_error', { message: 'Username admin yang akan dihapus tidak valid.' });
          }
          // Prevent admin from deleting themselves
          if (usernameToDelete === adminInfo.username) {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus akun sendiri.`);
              return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus akun Anda sendiri.' });
          }
           // Prevent deleting the last Super Admin
           const superAdmins = Object.keys(admins).filter(user => admins[user]?.role === 'superadmin');
           if (superAdmins.length === 1 && superAdmins[0] === usernameToDelete) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus Super Admin terakhir: ${usernameToDelete}`);
               return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus Super Admin terakhir.' });
           }


          if (!admins[usernameToDelete]) { // Check against loaded admins data
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus admin '${usernameToDelete}' yang tidak ditemukan.`);
               return socket.emit('superadmin_error', { message: `Admin dengan username '${usernameToDelete}' tidak ditemukan.` });
          }

          console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus admin: ${usernameToDelete}`);

           // If the admin to be deleted is currently online, clean up their state and disconnect their socket
           const targetSocketId = usernameToSocketId[usernameToDelete];
           if(targetSocketId) {
                console.log(`[SUPERADMIN] Admin ${usernameToDelete} online, membersihkan state dan memutuskan koneksi.`);
                cleanupAdminState(targetSocketId); // This cleans up their picked chats and removes them from adminSockets/usernameToSocketId
                 // Explicitly disconnect the socket if it still exists
                 if (io.sockets.sockets.get(targetSocketId)) {
                      io.sockets.sockets.get(targetSocketId).disconnect(true);
                 }
           } else {
                // If admin is offline, manually clean up their picked chats
                const chatsPickedByDeletedAdmin = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === usernameToDelete);
                 chatsPickedByDeletedAdmin.forEach(chatId => {
                    clearAutoReleaseTimer(chatId); // Clear their timers
                    delete pickedChats[chatId]; // Remove their picks
                    console.log(`[ADMIN] Chat ${chatId} dilepas karena admin ${usernameToDelete} dihapus.`);
                    io.emit('update_pick_status', { chatId: chatId, pickedBy: null }); // Notify clients
                 });

               // Emit updates about online admins (the deleted one is now definitely not online) and picked chats
               io.emit('update_online_admins', getOnlineAdminUsernames());
               io.emit('initial_pick_status', pickedChats);
           }

           // Remove from backend state
          delete admins[usernameToDelete];

          // Save to Firebase and emit updates
          saveAdminsToFirebase();

          socket.emit('superadmin_success', { message: `Admin '${usernameToDelete}' berhasil dihapus.` });
      });


     socket.on('close_chat', ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan tutup chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !chatId || typeof chatId !== 'string') {
             console.warn(`[CHAT STATUS] Socket ${socket.id} mencoba tutup chat tanpa login atau chat ID.`);
             return socket.emit('chat_status_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
        }
        const username = adminInfo.username;
        const normalizedChatId = normalizeChatId(chatId);
        if (!normalizedChatId) { // Check if normalization failed
            console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat dengan ID tidak valid: ${chatId}`);
            return socket.emit('chat_status_error', { chatId, message: 'Chat ID tidak valid.' });
        }

        const encodedChatId = encodeFirebaseKey(normalizedChatId);
         if (!encodedChatId) {
             console.error(`[CHAT STATUS] Gagal meng-encode chatId untuk close_chat: ${normalizedChatId}`);
             return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Kesalahan internal: ID chat tidak valid.' });
         }
        const chatEntry = chatHistory[encodedChatId];

         // Check if chat exists in history
        if (!chatEntry) {
             console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang tidak ditemukan di history.`);
             return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan.' });
        }

        const pickedBy = pickedChats[normalizedChatId];
        // Allow closing if picked by current user OR is Super Admin
        if (isSuperAdmin(username) || pickedBy === username) {
            if (chatEntry.status === 'closed') {
                 console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang sudah tertutup.`);
                 return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
            }

            console.log(`[CHAT STATUS] Admin ${username} menutup chat ${normalizedChatId}`);
            // Update backend state
            chatEntry.status = 'closed';

            // Remove from picked state if picked
            if (pickedBy) {
                 clearAutoReleaseTimer(normalizedChatId);
                 delete pickedChats[normalizedChatId];
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Notify clients
                 io.emit('initial_pick_status', pickedChats); // Send full state update
            }

            // Save to Firebase and emit updates
            saveChatHistoryToFirebase();

            io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' }); // Notify all clients
            socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil ditutup.` }); // Confirm to sender

        } else {
             const errorMsg = pickedBy ? `Hanya ${pickedBy} atau Super Admin yang bisa menutup chat ini.` : `Chat ini tidak diambil oleh siapa pun. Hanya Super Admin yang bisa menutup chat yang tidak diambil.`;
             console.warn(`[CHAT STATUS] Admin ${username} mencoba menutup chat ${normalizedChatId}. Akses ditolak: ${errorMsg}`);
            socket.emit('chat_status_error', { chatId: normalizedChatId, message: errorMsg }); // Send error to sender
        }
     });

      socket.on('open_chat', ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan buka chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        // Only allow Super Admin to open chats
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
         if (!encodedChatId) {
             console.error(`[SUPERADMIN] Gagal meng-encode chatId untuk open_chat: ${normalizedChatId}`);
             return socket.emit('superadmin_error', { message: 'Kesalahan internal: ID chat tidak valid.' });
         }
        const chatEntry = chatHistory[encodedChatId];

         // Check if chat exists in history
        if (!chatEntry) {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang tidak ditemukan di history.`);
             return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan.' });
        }

         // Check if chat is already open
         if (chatEntry.status === 'open') {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang sudah terbuka.`);
              return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat sudah terbuka.' });
         }

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} membuka kembali chat ${normalizedChatId}`);
        // Update backend state
        chatEntry.status = 'open';

        // Save to Firebase and emit updates
        saveChatHistoryToFirebase();

        io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' }); // Notify all clients
        socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali.` }); // Confirm to sender

     });

    // --- QUICK REPLY TEMPLATES HANDLERS (SUPER ADMIN) ---
    socket.on('add_quick_reply', async ({ shortcut, text }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        // Only allow Super Admin
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan tambah template dari Super Admin ${adminInfo.username}: ${shortcut}`);

        // Validate input data
        if (!shortcut || typeof shortcut !== 'string' || !text || typeof text !== 'string') {
            console.warn(`[TEMPLATES] Data template tidak lengkap atau format salah dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Data template tidak lengkap (shortcut dan text diperlukan).' });
        }
        const cleanedShortcut = shortcut.trim().toLowerCase(); // Normalize shortcut to lowercase

        // --- PERBAIKAN: Regex validasi shortcut ---
        // Regex ini memeriksa apakah string dimulai dengan '/' diikuti 1 atau lebih huruf kecil, angka, underscore, atau hyphen.
        const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
        if (!shortcutValidationRegex.test(cleanedShortcut)) {
             console.warn(`[TEMPLATES] Shortcut template tidak valid dari ${adminInfo.username}: '${cleanedShortcut}'. Tidak sesuai format.`);
             return socket.emit('superadmin_error', { message: 'Shortcut harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).' });
        }
        // --- END PERBAIKAN ---

        if (quickReplyTemplates[cleanedShortcut]) { // Check against backend state
            console.warn(`[TEMPLATES] Admin ${adminInfo.username} mencoba menambah template '${cleanedShortcut}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Template dengan shortcut '${cleanedShortcut}' sudah ada.` });
        }

        if (text.trim().length === 0) {
            console.warn(`[TEMPLATES] Template text kosong dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Teks template tidak boleh kosong.' });
        }

        // Generate a stable ID from the encoded shortcut
        const templateId = encodeFirebaseKey(cleanedShortcut);
        if (!templateId) {
             console.error(`[TEMPLATES] Gagal meng-encode shortcut '${cleanedShortcut}' untuk ID template.`);
             return socket.emit('superadmin_error', { message: 'Kesalahan internal saat membuat ID template.' });
        }


        // Update backend state
        quickReplyTemplates[cleanedShortcut] = {
            id: templateId, // Store the generated ID
            shortcut: cleanedShortcut, // Store the cleaned shortcut (e.g. /hallo)
            text: text.trim() // Store the trimmed text
        };

        // Save to Firebase and emit updates
        try {
             await saveQuickReplyTemplatesToFirebase();
             socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil ditambahkan.` });
        } catch (error) {
             console.error('[TEMPLATES] Gagal menyimpan template setelah menambah:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan template '${cleanedShortcut}' ke database.` });
             // Revert state if save failed? Maybe too complex for this example.
             // delete quickReplyTemplates[cleanedShortcut];
        }
    });

    socket.on('update_quick_reply', async ({ id, shortcut, text }) => {
         const adminInfo = getAdminInfoBySocketId(socket.id);
        // Only allow Super Admin
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba update template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan update template ID ${id} dari Super Admin ${adminInfo.username}`);

         // Validate input data
        if (!id || typeof id !== 'string' || !shortcut || typeof shortcut !== 'string' || !text || typeof text !== 'string') {
             console.warn(`[TEMPLATES] Data template update tidak lengkap atau format salah dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Data template tidak lengkap atau format salah.' });
        }
        const cleanedShortcut = shortcut.trim().toLowerCase(); // Normalize new shortcut
         const oldShortcut = decodeFirebaseKey(id); // Decode ID back to old shortcut

        // --- PERBAIKAN: Validasi shortcut baru ---
        const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
        if (!shortcutValidationRegex.test(cleanedShortcut)) {
             console.warn(`[TEMPLATES] Shortcut template baru tidak valid dari ${adminInfo.username}: '${cleanedShortcut}'. Tidak sesuai format.`);
             return socket.emit('superadmin_error', { message: 'Shortcut baru harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).' });
        }
        // --- END PERBAIKAN ---


         // Check if the template with the old shortcut exists in state
         if (!quickReplyTemplates[oldShortcut]) {
             console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${oldShortcut}) tidak ditemukan untuk diupdate oleh ${adminInfo.username}.`);
             return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
         }

         // If the shortcut is changing (new shortcut is different from old), check if the new shortcut already exists for *another* template
         if (oldShortcut !== cleanedShortcut && quickReplyTemplates[cleanedShortcut]) {
             console.warn(`[TEMPLATES] Admin ${adminInfo.username} mencoba update template menjadi shortcut '${cleanedShortcut}' yang sudah ada.`);
             return socket.emit('superadmin_error', { message: `Template dengan shortcut '${cleanedShortcut}' sudah ada.` });
         }

         if (text.trim().length === 0) {
              console.warn(`[TEMPLATES] Template text kosong saat update dari ${adminInfo.username}.`);
             return socket.emit('superadmin_error', { message: 'Teks template tidak boleh kosong.' });
         }

        // Update backend state
        // If shortcut changed, delete old entry and add new one
        if (oldShortcut !== cleanedShortcut) {
             console.log(`[TEMPLATES] Shortcut template ID ${id} berubah dari '${oldShortcut}' menjadi '${cleanedShortcut}'. Menghapus lama dan menambah baru.`);
             delete quickReplyTemplates[oldShortcut];
             // New ID will be based on the new shortcut
             const newTemplateId = encodeFirebaseKey(cleanedShortcut);
              if (!newTemplateId) {
                   console.error(`[TEMPLATES] Gagal meng-encode shortcut baru '${cleanedShortcut}' untuk ID template.`);
                   return socket.emit('superadmin_error', { message: 'Kesalahan internal saat membuat ID template baru.' });
              }
             quickReplyTemplates[cleanedShortcut] = {
                 id: newTemplateId,
                 shortcut: cleanedShortcut,
                 text: text.trim()
             };
        } else {
             // If shortcut didn't change, just update the existing entry's text
             console.log(`[TEMPLATES] Shortcut template ID ${id} tetap '${oldShortcut}'. Mengupdate teks.`);
             quickReplyTemplates[cleanedShortcut].text = text.trim();
             // ID remains the same
        }


        // Save to Firebase and emit updates
        try {
             await saveQuickReplyTemplatesToFirebase();
             socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil diupdate.` });
        } catch (error) {
             console.error('[TEMPLATES] Gagal menyimpan template setelah update:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan template '${cleanedShortcut}' ke database.` });
             // State might be inconsistent if save fails
        }

    });


    socket.on('delete_quick_reply', async ({ id }) => {
         const adminInfo = getAdminInfoBySocketId(socket.id);
        // Only allow Super Admin
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan hapus template ID ${id} dari Super Admin ${adminInfo.username}`);

        // Validate input data
        if (!id || typeof id !== 'string') {
             console.warn(`[TEMPLATES] Template ID tidak valid dari ${adminInfo.username} untuk dihapus.`);
            return socket.emit('superadmin_error', { message: 'Template ID tidak valid.' });
        }

        const shortcutToDelete = decodeFirebaseKey(id); // Decode ID back to shortcut

        if (!shortcutToDelete || !quickReplyTemplates[shortcutToDelete]) { // Check against backend state using decoded shortcut
            console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${shortcutToDelete}) tidak ditemukan untuk dihapus oleh ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
        }

        // Update backend state
        delete quickReplyTemplates[shortcutToDelete];

         // Save to Firebase and emit updates
         try {
             await saveQuickReplyTemplatesToFirebase();
             socket.emit('superadmin_success', { message: `Template '${shortcutToDelete}' berhasil dihapus.` });
         } catch (error) {
              console.error('[TEMPLATES] Gagal menyimpan template setelah menghapus:', error);
              socket.emit('superadmin_error', { message: `Gagal menghapus template '${shortcutToDelete}' dari database.` });
              // State might be inconsistent if save fails
         }
    });
    // --- END QUICK REPLY TEMPLATES HANDLERS ---


  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] Socket ${socket.id} terputus. Alasan: ${reason}`);
    // cleanupAdminState handles state removal and emitting online status updates
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} state dibersihkan.`);
    }
  });

});


// --- Shutdown Handling ---
const shutdownHandler = async (signal) => {
    console.log(`[SERVER] Menerima ${signal}. Membersihkan...`);

    // Clean up admin states for all connected sockets
    const connectedSocketIds = Object.keys(adminSockets); // Get current online sockets
    for (const socketId of connectedSocketIds) {
         // Use getAdminInfoBySocketId for safe access
         const adminInfo = getAdminInfoBySocketId(socketId);
         if (adminInfo) {
             console.log(`[ADMIN] Cleaning up state for admin ${adminInfo.username} (Socket ID: ${socketId}) during shutdown.`);
             cleanupAdminState(socketId); // This removes them from adminSockets and usernameToSocketId
             // Don't disconnect sockets manually here, io.Close() will do it or they are already disconnecting
         }
    }
    // Note: adminSockets should be empty after this loop


    // Close Socket.IO server
     console.log('[SOCKET] Menutup server Socket.IO...');
     await new Promise(resolve => io.close(resolve));
     console.log('[SOCKET] Server Socket.IO tertutup.');


    // Close WhatsApp connection
    if (sock && sock.ws.readyState !== sock.ws.CLOSED && sock.ws.readyState !== sock.ws.CLOSING) {
        console.log('[WA] Menutup koneksi WhatsApp...');
        try {
            await sock.logout(); // Attempt graceful logout
            console.log('[WA] WhatsApp connection closed gracefully.');
        } catch (e) {
             console.error('[WA] Error during WhatsApp logout, forcing end:', e);
             // If logout fails, force end the connection
             try {
                 sock.end(new Error('Server Shutdown Forced'));
             } catch (endErr) {
                  console.error('[WA] Error forcing WhatsApp connection end:', endErr);
             }
        }
     } else {
         console.log('[WA] WhatsApp connection already closed or not initialized.');
     }

    console.log('[SERVER] Server dimatikan.');
    process.exit(0); // Exit successfully
};

process.on('SIGINT', () => shutdownHandler('SIGINT')); // Ctrl+C
process.on('SIGTERM', () => shutdownHandler('SIGTERM')); // kill command

// Handle unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally shutdown gracefully here too if it's a critical error
   // shutdownHandler('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err);
  // Crucial to handle uncaught exceptions. Log the error and then exit.
   // Adding a delay might allow logs to flush
  setTimeout(() => {
       shutdownHandler('uncaughtException'); // Attempt graceful shutdown
  }, 1000); // Delay exit slightly
});