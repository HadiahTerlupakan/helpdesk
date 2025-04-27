// backend.js

import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, Browsers } from 'baileys';
import express from 'express';
const expressApp = express({}); // Menggunakan objek kosong untuk opsi, bukan langsung fungsi
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

// SQLite Imports
// IMPORT closeDatabase DI SINI
import {
    initDatabase,
    closeDatabase, // <--- IMPORT closeDatabase
    loadChatHistory,
    saveChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins,
    loadAdmins,
    saveQuickReplyTemplates,
    loadQuickReplyTemplates
} from './database.js';

// --- Konfigurasi & State ---
// Menggunakan 'let' untuk variabel yang isinya akan diganti (seperti seluruh objek admins/chatHistory)
let admins = {}; // { username: { password, initials, role } } - Akan dimuat dari database SQLite
let chatHistory = {}; // Struktur: { normalizedChatId: { status: 'open'|'closed', messages: [...] } }
let quickReplyTemplates = {}; // Struktur: { shortcut: { id: string, text: string, shortcut: string } }

// Menggunakan 'const' untuk variabel yang objeknya TIDAK akan diganti secara keseluruhan,
// hanya propertinya yang akan diubah (ditambah/dihapus).
const adminSockets = {}; // socket ID -> { username: '...', role: '...' } // Menyimpan info admin login
const usernameToSocketId = {}; // username -> socket ID
const pickedChats = {}; // chatId (normalized) -> username // State di backend untuk chat yang diambil
const chatReleaseTimers = {}; // chatId (normalized) -> setTimeout ID

const __filename = fileURLToPath(import.meta.url); // Menggunakan fileURLToPath yang benar
const __dirname = path.dirname(__filename);

const superAdminUsername = config.superAdminUsername; // Ambil superadmin username dari config

let sock; // Variabel global untuk instance socket Baileys
let qrDisplayed = false; // Flag untuk menandai apakah QR sudah ditampilkan via kode kita
let currentQrCode = null; // Variabel untuk menyimpan QR code saat ini


// --- Fungsi Helper ---

const logger = pino({ level: config.baileysOptions?.logLevel ?? 'warn' });

// Memuat Data dari Database (History, Admins, Templates)
/**
 * Memuat data dari database SQLite termasuk chat history, daftar admin, dan template quick reply.
 * @async
 * @function loadDataFromDatabase
 * @returns {Promise<void>}
 */
async function loadDataFromDatabase() {
    console.log("[DATABASE] Memuat data dari SQLite...");

    try {
        // Inisialisasi database (akan membuka koneksi jika belum ada)
        await initDatabase();

        // Muat Chat History
        console.log('[DATABASE] Mencoba memuat riwayat chat...');
        chatHistory = await loadChatHistory(); // loadChatHistory melempar error jika skema salah
        console.log('[DATABASE] Riwayat chat berhasil dimuat dari database.');

        // Muat Admins
        console.log('[DATABASE] Mencoba memuat data admin...');
        admins = await loadAdmins();

        // Jika tidak ada admin di database, gunakan dari config
        if (!admins || Object.keys(admins).length === 0) {
            console.warn('[DATABASE] Tidak ada data admin di database. Menggunakan dari config.js.');
            admins = config.admins || {};

            if (Object.keys(admins).length > 0) {
                console.log('[DATABASE] Menyimpan admin dari config.js ke database.');
                await saveAdmins(admins); // Simpan ke DB
            } else {
                console.error('[DATABASE] TIDAK ADA DATA ADMIN DITEMUKAN DI CONFIG.JS ATAU DATABASE! Tidak ada admin yang bisa login.');
            }
        } else {
            console.log('[DATABASE] Data admin berhasil dimuat dari database.');

            // Validasi dasar untuk superadmin
            const superAdminsInDb = Object.keys(admins).filter(user => admins[user]?.role === 'superadmin');
            if (!admins[superAdminUsername] || admins[superAdminUsername].role !== 'superadmin') {
                console.warn(`[DATABASE] PERINGATAN: Super Admin username '${superAdminUsername}' dari config.js tidak ditemukan atau tidak memiliki role 'superadmin' di database.`);
                if (superAdminsInDb.length === 0) {
                    console.error('[DATABASE] TIDAK ADA SUPER ADMIN DITEMUKAN DI DATABASE! Fungsionalitas super admin tidak akan bekerja.');
                } else if (superAdminsInDb.length === 1) {
                    console.warn(`[DATABASE] Super Admin aktif di database adalah '${superAdminsInDb[0]}'. Pastikan config.superAdminUsername sesuai jika ingin menggunakan '${superAdminUsername}'.`);
                } else {
                    console.warn(`[DATABASE] Beberapa Super Admin ditemukan di database: ${superAdminsInDb.join(', ')}. config.superAdminUsername adalah '${superAdminUsername}'.`);
                }
            } else if (superAdminsInDb.length > 1) {
                 console.warn(`[DATABASE] PERINGATAN: Beberapa Super Admin ditemukan di database, termasuk '${superAdminUsername}'.`);
            }
             if (superAdminsInDb.length === 0) {
                 console.error('[DATABASE] TIDAK ADA SUPER ADMIN DITEMUKAN DI DATABASE! Fungsionalitas super admin tidak akan bekerja.');
             }
        }

        // Muat Quick Reply Templates
        console.log('[DATABASE] Mencoba memuat quick reply templates...');
        quickReplyTemplates = await loadQuickReplyTemplates();

        if (Object.keys(quickReplyTemplates).length > 0) {
            console.log(`[DATABASE] ${Object.keys(quickReplyTemplates).length} quick reply templates berhasil dimuat dari database.`);
        } else {
            console.log('[DATABASE] Tidak ada quick reply templates di database.');
            quickReplyTemplates = {}; // Pastikan state kosong jika DB kosong
        }

    } catch (error) {
        console.error('[DATABASE] Gagal memuat data awal dari database:', error);
        // Ini adalah error fatal saat startup (misal skema salah), re-throw untuk menghentikan server
        throw error;
    }
}

// Menyimpan Chat History ke Database
/**
 * Menyimpan chat history ke database SQLite.
 * @function saveChatHistoryToDatabase
 * @returns {Promise<void>}
 */
async function saveChatHistoryToDatabase() {
    // Filter undefined values just in case before saving
    const sanitizedChatHistory = JSON.parse(JSON.stringify(chatHistory, (key, value) => value === undefined ? null : value));

    try {
        // saveChatHistory di database.js menghapus semua & menulis ulang.
        // Ini kurang efisien tapi sesuai dengan cara state chatHistory dikelola di memory saat ini.
        await saveChatHistory(sanitizedChatHistory);
        // console.log('[DATABASE] Riwayat chat berhasil disimpan ke database.'); // Disable verbose logging
    } catch (error) {
        console.error('[DATABASE] Gagal menyimpan riwayat chat ke database:', error);
        // Jangan lempar error, biarkan aplikasi tetap berjalan meskipun gagal save
    }
}

// Menyimpan Data Admin ke Database
/**
 * Menyimpan daftar admin ke database SQLite.
 * @function saveAdminsToDatabase
 * @returns {Promise<void>}
 */
async function saveAdminsToDatabase() {
    const sanitizedAdmins = JSON.parse(JSON.stringify(admins, (key, value) => value === undefined ? null : value));

    try {
        // saveAdmins di database.js menghapus semua & menulis ulang.
        await saveAdmins(sanitizedAdmins);
        console.log('[DATABASE] Data admin berhasil disimpan ke database.');
        // Emit updated admins *after* successful save
        io.emit('registered_admins', admins); // Emit updated admins to all clients
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Emit updated online status
    } catch (error) {
        console.error('[DATABASE] Gagal menyimpan data admin ke database:', error);
        // Jangan lempar error
    }
}

// --- QUICK REPLY TEMPLATES ---
// Menyimpan Quick Reply Templates ke Database
/**
 * Menyimpan template quick reply ke database SQLite.
 * @async
 * @function saveQuickReplyTemplatesToDatabase
 * @returns {Promise<void>}
 */
async function saveQuickReplyTemplatesToDatabase() {
    console.log('[DATABASE] Menyimpan quick reply templates ke database...');

    try {
        // saveQuickReplyTemplates di database.js menghapus semua & menulis ulang.
        await saveQuickReplyTemplates(quickReplyTemplates);
        console.log('[DATABASE] Quick reply templates berhasil disimpan ke database.');
        // Convert backend object state to array for frontend and emit
        const quickReplyTemplatesArray = Object.values(quickReplyTemplates);
        io.emit('quick_reply_templates_updated', quickReplyTemplatesArray); // Emit updated templates (as array) to all clients
    } catch (error) {
        console.error('[DATABASE] Gagal menyimpan quick reply templates ke database:', error);
        // Tidak perlu melempar error di sini
    }
}
// --- END QUICK REPLY TEMPLATES ---


// Menghapus Chat History dari Database
/**
 * Menghapus chat history dari database berdasarkan chat ID.
 * @async
 * @function deleteChatHistoryFromDatabase
 * @param {string} chatId - Chat ID yang akan dihapus
 * @returns {Promise<boolean>}
 */
async function deleteChatHistoryFromDatabase(chatId) {
    try {
        const success = await deleteChatHistory(chatId); // Panggil fungsi database dengan chatId langsung
        if (success) {
            console.log(`[DATABASE] Chat history untuk ${chatId} berhasil dihapus dari database.`);
        }
        return success;
    } catch (error) {
        console.error(`[DATABASE] Gagal menghapus chat history untuk ${chatId} dari database:`, error);
        return false;
    }
}

// Menghapus Semua Chat History dari Database
/**
 * Menghapus semua chat history dari database SQLite.
 * @async
 * @function deleteAllChatHistoryFromDatabase
 * @returns {Promise<boolean>}
 */
async function deleteAllChatHistoryFromDatabase() {
    try {
        const success = await deleteAllChatHistory();
        if (success) {
            console.log('[DATABASE] Semua chat history berhasil dihapus dari database.');
        }
        return success;
    } catch (error) {
        console.error('[DATABASE] Gagal menghapus semua chat history dari database:', error);
        return false;
    }
}


// Membatalkan timer auto-release
/**
 * Membersihkan timer auto release untuk chat tertentu.
 * @function clearAutoReleaseTimer
 * @param {string} chatId - ID chat yang akan dibersihkan timernya (normalized)
 * @returns {void}
 */
function clearAutoReleaseTimer(chatId) {
  const normalizedChatId = normalizeChatId(chatId); // Pastikan ID dinormalisasi sebelum digunakan sebagai kunci
   if (!normalizedChatId) {
       console.warn(`[TIMER] Mencoba membersihkan timer dengan ID chat tidak valid: ${chatId}`);
       return;
   }
  if (chatReleaseTimers[normalizedChatId]) {
    clearTimeout(chatReleaseTimers[normalizedChatId]);
    delete chatReleaseTimers[normalizedChatId]; // Hapus ID timer dari objek state
    // console.log(`Timer auto-release untuk chat ${normalizedChatId} dibatalkan.`);
  }
}

// Memulai timer auto-release
/**
 * Memulai timer auto release untuk chat tertentu.
 * @function startAutoReleaseTimer
 * @param {string} chatId - ID chat yang akan diberi timer (normalized)
 * @param {string} username - Username admin yang mengambil chat
 * @returns {void}
 */
function startAutoReleaseTimer(chatId, username) {
  const normalizedChatId = normalizeChatId(chatId); // Pastikan ID dinormalisasi
  if (!normalizedChatId) {
      console.warn(`[TIMER] Mencoba memulai timer dengan ID chat tidak valid: ${chatId}`);
      return;
  }

  clearAutoReleaseTimer(normalizedChatId); // Bersihkan timer yang mungkin sudah ada

  const timeoutMinutes = config.chatAutoReleaseTimeoutMinutes;
  if (timeoutMinutes && timeoutMinutes > 0) {
    const timeoutMs = timeoutMinutes * 60 * 1000;
    console.log(`[TIMER] Memulai timer auto-release ${timeoutMinutes} menit untuk chat ${normalizedChatId} oleh ${username}.`);

    chatReleaseTimers[normalizedChatId] = setTimeout(() => {
      // Periksa apakah chat *masih* diambil oleh admin yang sama
      if (pickedChats[normalizedChatId] === username) {
        console.log(`[TIMER] Timer auto-release habis untuk chat ${normalizedChatId} (diambil ${username}). Melepas chat.`);
        delete pickedChats[normalizedChatId]; // Hapus dari state pickedChats
        delete chatReleaseTimers[normalizedChatId]; // Hapus ID timer dari state

        // Beri tahu semua klien tentang perubahan status pick
        io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null });
        io.emit('initial_pick_status', pickedChats); // Kirim update state pick lengkap

        // Opsional: Beri tahu admin yang chat-nya dilepas otomatis
        const targetSocketId = usernameToSocketId[username];
        if (targetSocketId && io.sockets.sockets.get(targetSocketId)) { // Periksa apakah socket masih online & terhubung
           io.to(targetSocketId).emit('auto_release_notification', { chatId: normalizedChatId, message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} dilepas otomatis (tidak aktif selama ${timeoutMinutes} menit).` }); // Gunakan chatId sebagai fallback untuk nama chat
        }

      } else {
          // Timer selesai, tapi chat sudah tidak diambil oleh admin ini (mungkin dilepas manual/didelegasikan)
          console.log(`[TIMER] Timer auto-release untuk ${normalizedChatId} oleh ${username} selesai, tetapi chat sudah tidak diambil oleh admin ini. Timer dibersihkan.`);
          delete chatReleaseTimers[normalizedChatId]; // Bersihkan ID timer dari state
      }
    }, timeoutMs);
  }
}

// Mendapatkan daftar username admin yang sedang online
/**
 * Mendapatkan daftar username admin yang online.
 * @function getOnlineAdminUsernames
 * @returns {string[]} - Array berisi username admin yang online
 */
function getOnlineAdminUsernames() {
    // Filter out potential undefined/null values just in case
    return Object.values(adminSockets).map(adminInfo => adminInfo?.username).filter(Boolean);
}

// Mendapatkan info admin (termasuk role) berdasarkan Socket ID
/**
 * Mendapatkan informasi admin berdasarkan socket ID.
 * @function getAdminInfoBySocketId
 * @param {string} socketId - Socket ID admin
 * @returns {Object|null} - Objek berisi informasi admin atau null jika tidak ditemukan
 */
function getAdminInfoBySocketId(socketId) {
    // Ensure adminSockets[socketId] exists and is an object before accessing properties
    return adminSockets[socketId] && typeof adminSockets[socketId] === 'object' ? adminSockets[socketId] : null;
}

// Membersihkan state admin saat disconnect/logout
/**
 * Membersihkan state admin berdasarkan socket ID.
 * @function cleanupAdminState
 * @param {string} socketId - Socket ID admin yang akan dibersihkan
 * @returns {string|null} - Username admin yang dibersihkan, atau null jika tidak ada admin
 */
function cleanupAdminState(socketId) {
    const adminInfo = getAdminInfoBySocketId(socketId);
    if (adminInfo) {
        const username = adminInfo.username;
        console.log(`[ADMIN] Membersihkan state untuk admin ${username} (Socket ID: ${socketId})`);

        // Lepas semua chat yang diambil oleh admin ini
        // Iterate over a copy of keys as delete modifies the object
        const chatsToRelease = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === username);
        for (const chatId of chatsToRelease) {
            clearAutoReleaseTimer(chatId); // Bersihkan timer sebelum melepaskan
            delete pickedChats[chatId]; // Hapus dari state pickedChats
            console.log(`[ADMIN] Chat ${chatId} dilepas karena ${username} terputus/logout.`);
            io.emit('update_pick_status', { chatId: chatId, pickedBy: null }); // Beri tahu klien lain tentang pelepasan
        }

        // Hapus dari pelacakan online
        delete adminSockets[socketId];
        delete usernameToSocketId[username];

        // Emit update tentang status online dan chat yang diambil (setelah pelepasan)
        io.emit('update_online_admins', getOnlineAdminUsernames());
        io.emit('initial_pick_status', pickedChats); // Kirim state pick yang diperbarui

        return username; // Kembalikan username admin yang dibersihkan
    }
    return null; // Kembalikan null jika tidak ada admin untuk socketId ini
}

// Fungsi untuk memastikan chatId dalam format lengkap (normalized)
/**
 * Normalisasi chat ID WhatsApp.
 * @function normalizeChatId
 * @param {string} chatId - Chat ID yang akan dinormalisasi
 * @returns {string|null} - Chat ID yang sudah dinormalisasi atau null jika format tidak valid.
 */
function normalizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') {
      return null; // Handle null/undefined/non-string
  }

  // Regex untuk format JID WA yang umum (personal, group, broadcast, status)
  // Menambahkan kemungkinan titik dua (:) pada broadcast/status JID
  const personalRegex = /^\d+@s\.whatsapp\.net$/;
  const groupRegex = /^\d+-\d+@g\.us$/;
  const broadcastRegex = /^\d+@broadcast$/;
  const statusRegex = /^status@broadcast$/;
  const otherValidCharsRegex = /^[a-zA-Z0-9._\-:]+$/; // Karakter lain yang mungkin valid di JID

  // Jika sudah sesuai pola JID WA standar, kembalikan apa adanya
  if (personalRegex.test(chatId) || groupRegex.test(chatId) || broadcastRegex.test(chatId) || statusRegex.test(chatId)) {
      // console.log(`[NORMALIZE] Matched standard pattern: ${chatId}`); // Debugging
      return chatId;
  }

    // Jika tidak sesuai pola standar, coba normalisasi dari format angka saja atau angka-angka
    // Hapus karakter yang jelas tidak valid untuk nomor atau nomor-grup, seperti + di awal
   const cleanedForNumberPatterns = chatId.replace(/^\+/, '').replace(/[^\d\-]/g, ''); // Hanya sisakan digit dan hyphen

    if(/^\d+$/.test(cleanedForNumberPatterns)) { // Terlihat seperti hanya angka (misal: "6281234567890")
         // console.log(`[NORMALIZE] Looks like number-only, appending @s.whatsapp.net: ${chatId} -> ${cleanedForNumberPatterns}@s.whatsapp.net`); // Debugging
         return `${cleanedForNumberPatterns}@s.whatsapp.net`;
    }
     if(/^\d+-\d+$/.test(cleanedForNumberPatterns)) { // Terlihat seperti angka-angka (misal: "6281234567890-1234567890")
          // console.log(`[NORMALIZE] Looks like number-number, appending @g.us: ${chatId} -> ${cleanedForNumberPatterns}@g.us`); // Debugging
          return `${cleanedForNumberPatterns}@g.us`;
     }

    // Jika masih tidak cocok, cek apakah string hanya berisi karakter yang biasanya diizinkan di JID
    // Jika ya, mungkin itu JID dari tipe lain yang tidak ditangani secara spesifik, kembalikan apa adanya.
    // Ini adalah fallback untuk JID yang tidak standar tapi mungkin valid.
    // PERHATIAN: Ini bisa mengembalikan string yang sebenarnya bukan JID WA valid.
    if (otherValidCharsRegex.test(chatId)) {
         console.warn(`[NORMALIZE] Chat ID tidak cocok pola standar tapi hanya berisi karakter valid JID. Mengembalikan apa adanya: ${chatId}`);
         return chatId; // Kembalikan apa adanya jika hanya berisi karakter yang diizinkan
    }


  // Jika tidak ada pola yang cocok setelah normalisasi minimal, anggap tidak valid
  console.warn(`[NORMALIZE] Chat ID format tidak dikenali dan tidak dapat dinormalisasi: ${chatId}`);
  return null;
}


// Fungsi untuk mengecek apakah admin adalah Super Admin
/**
 * Memeriksa apakah username termasuk super admin.
 * @function isSuperAdmin
 * @param {string} username - Username yang akan diperiksa
 * @returns {boolean} - True jika super admin, false jika bukan
 */
function isSuperAdmin(username) {
     // Check if username exists in loaded admins object and has role 'superadmin'
     // Rely purely on loaded admins data from the database
     return admins[username]?.role === 'superadmin';
}


// --- Setup Express & Server ---

const PORT = config.serverPort || 3000;

// Memuat data dari database sebelum memulai server atau WA
// Wrap startup logic in an async function to use await
async function startApp() {
    try {
        // loadDataFromDatabase akan melempar error jika gagal, dan di sana initDatabase dipanggil
        await loadDataFromDatabase();
        console.log("[SERVER] Data database siap. Memulai koneksi WhatsApp dan Server HTTP.");

        // Start WhatsApp connection
        // Use a self-executing async function or call connectToWhatsApp directly
        connectToWhatsApp().catch(err => {
            console.error("[WA] Gagal memulai koneksi WhatsApp awal:", err);
            // Decide if this is fatal or if server can run without WA
            // process.exit(1); // Uncomment to exit if WA connection is mandatory for startup
        });

        // Start HTTP and Socket.IO server
        // Gunakan promise agar menunggu server listen
        await new Promise(resolve => {
            server.listen(PORT, () => {
                console.log(`[SERVER] Server Helpdesk berjalan di http://localhost:${PORT}`);
                console.log(`[SERVER] Versi Aplikasi: ${config.version || 'N/A'}`);
                resolve(); // Resolve promise setelah server listen
            });
        });


    } catch (err) {
        console.error("[SERVER] Gagal memuat data awal dari database. Server tidak dapat dimulai.", err);
        // Pastikan koneksi database ditutup jika startup gagal setelah init
        await closeDatabase().catch(dbErr => console.error('[DATABASE] Error closing DB after startup failure:', dbErr));
        // Keluar dari proses dengan kode error
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


// Start the application
// Tangkap error dari startApp jika ada
startApp().catch(err => {
     console.error("[SERVER] Error during application startup:", err);
     process.exit(1);
});


// --- Koneksi WhatsApp (Baileys) ---

/**
 * Menghubungkan ke WhatsApp menggunakan Baileys.
 * @async
 * @function connectToWhatsApp
 * @returns {Promise<void>}
 */
async function connectToWhatsApp() {
  console.log("[WA] Mencoba menghubungkan ke WhatsApp...");
  // auth_info_baileys will be created if it doesn't exist
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    // Set printQRInTerminal menjadi false karena QR akan di-handle di frontend Super Admin
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    logger: logger,
     syncFullHistory: false,
    getMessage: async (key) => {
        // Baileys mungkin meminta pesan lama (misal untuk quote/reply)
        // Kita tidak menyimpan objek pesan Baileys lengkap, jadi kembalikan undefined.
        // console.warn(`[WA] Baileys meminta pesan ${key.id} dari ${key.remoteJid}. Tidak tersedia di history lokal.`);
        return undefined; // Atau cari di database jika menyimpan objek lengkap
    }
  });

  // Event listeners for Baileys
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isOnline, isConnecting } = update;

    if (qr && !qrDisplayed) {
      qrDisplayed = true;
      currentQrCode = qr; // Simpan QR code saat ini
      console.log('[WA] QR Code diterima, pindai dengan WhatsApp Anda:');
      // --- Cetak QR via qrcode-terminal hanya sebagai fallback ---
      qrcode.generate(qr, { small: true });
      // --- END cetak QR ---
       // Emit QR to all connected Super Admins
       // Gunakan salinan kunci adminSockets karena adminSockets bisa berubah saat iterasi
       const currentAdminSockets = { ...adminSockets };
       let superAdminNotified = false;
       for (const socketId in currentAdminSockets) {
            if (Object.prototype.hasOwnProperty.call(currentAdminSockets, socketId) && currentAdminSockets[socketId]?.role === 'superadmin') {
                 // Check if socket is still connected before emitting
                 if (io.sockets.sockets.get(socketId)) {
                    io.to(socketId).emit('whatsapp_qr', qr);
                    superAdminNotified = true;
                 }
            }
       }
       if (!superAdminNotified) {
           console.warn('[WA] Tidak ada Super Admin yang login untuk menerima QR Code via Socket.IO. QR Code hanya ditampilkan di terminal.');
       }
    }

    if (connection === 'close') {
      qrDisplayed = false; // Reset flag agar QR bisa ditampilkan lagi jika dibutuhkan
      currentQrCode = null; // Hapus QR code yang tersimpan
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Unknown';
      // Alasan untuk reconnect: https://github.com/WhiskeySockets/Baileys/blob/main/src/Utils/decode-wa-msg.ts#L23
      // Tambahkan 440 (Conflict - Replaced) ke daftar kode yang TIDAK auto-reconnect
      const shouldReconnect = ![401, 403, 411, 419, 440].includes(statusCode);


      console.error(`[WA] Koneksi WhatsApp terputus: ${reason} (Code: ${statusCode || 'N/A'}), Mencoba menyambung kembali: ${shouldReconnect}`);
      // Emit pesan ke semua klien tentang disconnect
      io.emit('whatsapp_disconnected', { reason: reason, statusCode, message: reason });

      if (shouldReconnect) {
        console.log("[WA] Mencoba menyambung kembali dalam 10 detik...");
        setTimeout(connectToWhatsApp, 10000); // Reconnect after 10s
      } else {
        console.error("[WA] Tidak dapat menyambung kembali otomatis. Mungkin sesi invalid atau konflik. Perlu scan ulang QR.");
        // Emit fatal disconnect specifically to Super Admins, as they handle QR
        const fatalMessage = statusCode === 440
            ? 'Sesi digunakan di tempat lain. Tutup WhatsApp di perangkat lain atau scan ulang QR.'
            : 'Sesi invalid atau konflik. Silakan hubungi Super Admin untuk menampilkan QR untuk memulihkan (perlu scan ulang).';

        // Gunakan salinan kunci adminSockets
        const currentAdminSockets = { ...adminSockets };
        let superAdminNotified = false;
        for (const socketId in currentAdminSockets) {
             if (Object.prototype.hasOwnProperty.call(currentAdminSockets, socketId)) {
                 if (currentAdminSockets[socketId]?.role === 'superadmin') {
                     if (io.sockets.sockets.get(socketId)) { // Periksa apakah socket masih terhubung
                          io.to(socketId).emit('whatsapp_fatal_disconnected', { reason, statusCode, message: fatalMessage });
                          superAdminNotified = true;
                     }
                 } else {
                      // Beri tahu admin biasa tentang error fatal dan instruksikan menghubungi Super Admin
                      if (io.sockets.sockets.get(socketId)) { // Periksa apakah socket masih terhubung
                         io.to(socketId).emit('whatsapp_disconnected', { reason, statusCode, message: 'Koneksi WhatsApp terputus secara fatal. Hubungi Super Admin untuk memulihkan.' });
                      }
                 }
             }
        }
         if (!superAdminNotified) {
             console.warn('[WA] Tidak ada Super Admin yang login untuk menerima notifikasi fatal disconnect.');
         }
      }
    } else if (connection === 'open') {
      console.log('[WA] Berhasil terhubung ke WhatsApp!');
      qrDisplayed = false; // Reset flag saat koneksi terbuka
      currentQrCode = null; // Hapus QR code yang tersimpan
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
      // Abaikan pesan yang dikirim oleh bot sendiri, status update, atau dari JID bot sendiri
      if (message.key.fromMe || message.key.remoteJid === 'status@broadcast' || (sock?.user?.id && message.key.remoteJid === sock.user.id)) {
        continue;
      }

      const chatId = normalizeChatId(message.key.remoteJid); // Normalized JID for this chat
       if (!chatId) {
           console.error('[WA] Invalid chatId received:', message.key.remoteJid); // Log original ID if normalization failed
           continue;
       }

      // Gunakan normalized chatId sebagai kunci di state memory chatHistory dan untuk DB
      const dbChatId = chatId;

      let messageContent = null; // Konten teks utama (untuk kolom 'text' di DB dan bubble chat)
      let mediaData = null; // Data Base64 untuk media (untuk kolom 'mediaData' di DB)
      let mediaType = null; // Tipe pesan Baileys string atau custom (untuk kolom 'mediaType' di DB)
      let mimeType = null; // Tipe MIME sebenarnya dari properti Baileys (untuk kolom 'mimeType' di DB)
       let fileName = null; // Nama file asli jika ada (untuk kolom 'fileName' di DB)
       let messageTextSnippet = ''; // Snippet untuk daftar chat (untuk kolom 'snippet' di DB)


      const messageBaileysType = message.message ? Object.keys(message.message)[0] : null; // e.g., 'imageMessage'
      const messageProps = message.message?.[messageBaileysType]; // Properti spesifik untuk tipe pesan

       // Tangani berbagai tipe pesan masuk
       switch (messageBaileysType) {
           case 'conversation': // Pesan teks biasa
           case 'extendedTextMessage': // Pesan teks dengan fitur tambahan (reply, link preview, dll)
               messageContent = messageProps?.text || messageProps?.conversation || '';
               messageTextSnippet = messageContent.substring(0, 100) + (messageContent.length > 100 ? '...' : ''); // Snippet max 100 chars
               mediaType = 'text'; // Tipe kustom untuk pesan teks dalam skema kita
               break;
           case 'imageMessage':
           case 'videoMessage':
           case 'audioMessage':
           case 'documentMessage':
           case 'stickerMessage': // Stiker juga memiliki media
               mediaType = messageBaileysType;
               mimeType = messageProps?.mimetype;
                // Gunakan nama file asli atau default berdasarkan tipe
               fileName = messageProps?.fileName || messageProps?.caption || `${mediaType.replace('Message', '')}_file`;
               if (mediaType === 'audioMessage' && messageProps?.ptt) fileName = 'Voice Note'; // Ganti nama file untuk VN

               messageContent = messageProps?.caption || `[${mediaType.replace('Message', '')}]`; // Caption atau placeholder jika tidak ada caption
               messageTextSnippet = messageProps?.caption ? messageProps.caption.substring(0, 100) + (messageProps.caption.length > 100 ? '...' : '') : `[${mediaType.replace('Message', '')}]`; // Gunakan caption atau placeholder untuk snippet

               // Coba mengunduh media - PERINGATAN: Menyimpan Base64 di DB sangat TIDAK efisien
               try {
                 const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
                 if (buffer) {
                     mediaData = buffer.toString('base64');
                 } else {
                     console.warn(`[WA] Gagal mengunduh media (buffer kosong) dari ${chatId} untuk pesan ${message.key.id}`);
                     // Fallback konten teks jika download gagal
                     messageContent = `[Gagal mengunduh media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                     messageTextSnippet = `[Gagal unduh media ${mediaType.replace('Message', '')}]`;
                     mediaData = null; // Pastikan mediaData null saat gagal
                 }
               } catch (error) {
                 console.error(`[WA] Error mengunduh media dari ${chatId} untuk pesan ${message.key.id}:`, error);
                  // Fallback konten teks jika download error
                 messageContent = `[Gagal memuat media ${mediaType.replace('Message', '')}]` + (messageProps?.caption ? `\n${messageProps.caption}` : '');
                 messageTextSnippet = `[Error media ${mediaType.replace('Message', '')}]`;
                 mediaData = null; // Pastikan mediaData null saat error
               }
               break;
            case 'locationMessage':
                messageContent = `[Lokasi: ${messageProps?.degreesLatitude}, ${messageProps?.degreesLongitude}]`;
                messageTextSnippet = '[Lokasi]';
                mediaType = 'location'; // Tipe kustom
                // Opsional: simpan data lokasi di mediaData: mediaData = JSON.stringify(messageProps);
                break;
            case 'contactMessage':
                messageContent = `[Kontak: ${messageProps?.displayName || 'Nama tidak diketahui'}]`;
                 messageTextSnippet = `[Kontak]`;
                 mediaType = 'contact'; // Tipe kustom
                 // Opsional: simpan vcard di mediaData: mediaData = messageProps?.vcard;
                 break;
            case 'liveLocationMessage':
                 messageContent = '[Live Lokasi]';
                 messageTextSnippet = '[Live Lokasi]';
                 mediaType = 'liveLocation'; // Tipe kustom
                 // Opsional: simpan data di mediaData: mediaData = JSON.stringify(messageProps);
                 break;
            case 'protocolMessage': // Biasanya pesan terkait E2E, penghapusan, dll.
            case 'reactionMessage': // Reaksi terhadap pesan
            case 'senderKeyDistributionMessage':
            case 'editedMessage': // Pesan yang diedit
            case 'keepalive': // Keepalive signal
                 // Pesan-pesan ini sering kali adalah pesan layanan atau update, abaikan untuk history/tampilan percakapan
                 // console.log(`[WA] Skipping message type: ${messageBaileysType || 'N/A'} from ${chatId}`);
                 continue; // Lewati tipe pesan ini sepenuhnya
            default:
                // Fallback untuk tipe pesan yang tidak dikenal atau tidak ditangani
                console.warn(`[WA] Menerima pesan dengan tipe tidak dikenal atau tidak ditangani: ${messageBaileysType || 'N/A'} dari ${chatId}`);
                messageContent = `[Pesan tidak dikenal: ${messageBaileysType || 'N/A'}]`;
                messageTextSnippet = `[${messageBaileysType || 'Unknown'}]`;
                mediaType = 'unknown'; // Tipe kustom
                // Opsional: simpan pesan mentah di mediaData: mediaData = JSON.stringify(message);
       }

      // Buat objek data pesan masuk untuk state memory dan klien
      const messageData = {
        id: message.key.id,
        chatId: chatId, // Tambahkan chatId di sini untuk kejelasan
        from: chatId, // 'from' menunjukkan customer JID (pengirim asli) - ini akan jadi nilai 'sender' di DB
        text: messageContent || '', // Konten teks (caption untuk media)
        mediaData: mediaData, // Data Base64 media (jika ada)
        mediaType: mediaType, // Tipe media/pesan
        mimeType: mimeType, // Tipe MIME sebenarnya (jika ada)
        fileName: fileName, // Nama file (jika ada)
        snippet: messageTextSnippet || '', // Snippet untuk daftar chat
        timestamp: message.messageTimestamp
          ? new Date(parseInt(message.messageTimestamp) * 1000).toISOString() // Konversi Unix timestamp ke ISO string
          : new Date().toISOString(), // Fallback ke waktu saat ini
        unread: true, // Pesan masuk ditandai belum dibaca secara default
        type: 'incoming' // Arah pesan
         // Kolom 'sender' dan 'initials' untuk DB akan diisi di fungsi saveChatHistory
      };


      // Inisialisasi entri chat jika belum ada atau jika array messages hilang/bukan array
      if (!chatHistory[dbChatId] || !Array.isArray(chatHistory[dbChatId].messages)) { // Pastikan messages adalah array
        console.log(`[HISTORY] Membuat/memperbaiki entri baru untuk chat ${chatId}.`);
         // Pastikan status ada atau set default 'open'
        chatHistory[dbChatId] = { status: chatHistory[dbChatId]?.status || 'open', messages: [] };
      }
       // Pastikan status ada di objek chat yang ada
       if (!chatHistory[dbChatId].status) {
           chatHistory[dbChatId].status = 'open';
       }

      // Tambahkan pesan ke array messages, hindari duplikasi berdasarkan ID pesan
      // Gunakan dbChatId untuk mengakses state chatHistory
      if (!chatHistory[dbChatId].messages.some(m => m && typeof m === 'object' && m.id === messageData.id)) { // Periksa objek pesan yang valid & ID
        console.log(`[HISTORY] Menambahkan pesan masuk baru (ID: ${messageData.id}) ke chat ${chatId}`);
        chatHistory[dbChatId].messages.push(messageData);
        saveChatHistoryToDatabase(); // Simpan ke DB setelah menambahkan pesan baru

        // Emit pesan ke semua klien untuk memperbarui UI
        io.emit('new_message', {
             ...messageData,
             chatId: chatId, // Pastikan chatId ada di level teratas untuk klien
             chatStatus: chatHistory[dbChatId].status // Sertakan status chat dari state
         });

        // Kirim notifikasi ke admin online yang *tidak* menangani chat ini
        const pickedBy = pickedChats[chatId]; // Gunakan normalized chatId untuk pickedChats
        const onlineAdmins = getOnlineAdminUsernames();
        onlineAdmins.forEach(adminUsername => {
            const adminSocketId = usernameToSocketId[adminUsername];
            // Kirim notifikasi hanya jika admin online, BUKAN admin yang menangani chat ini, DAN chat dalam status 'open'
            if (adminSocketId && pickedBy !== adminUsername && chatHistory[dbChatId].status === 'open') { // Periksa status dari state
                // Periksa apakah socket masih terhubung sebelum mengirim
                if (io.sockets.sockets.get(adminSocketId)) {
                      const notificationBody = messageTextSnippet || '[Pesan Baru]'; // Gunakan snippet untuk notifikasi
                     io.to(adminSocketId).emit('notification', {
                        title: `Pesan Baru (${chatId.split('@')[0] || chatId})`, // Gunakan chatId jika split nama gagal
                        body: notificationBody,
                        icon: '/favicon.ico',
                        chatId: chatId
                     });
                } else {
                     console.warn(`[NOTIF] Socket ${adminSocketId} for admin ${adminUsername} is disconnected, not sending notification.`);
                }
            }
        });

      } else {
         // console.log(`[WA] Duplicate message detected in upsert (ID: ${messageData.id}), ignored.`); // Disable verbose logging
      }
    }
  });

}


// --- Logika Socket.IO (Komunikasi dengan Frontend Admin) ---
io.on('connection', (socket) => {
  console.log(`[SOCKET] Admin terhubung: ${socket.id}`);

  // Kirim data awal yang diperlukan segera setelah koneksi (admins, status online, pick, template)
  socket.emit('registered_admins', admins); // Kirim daftar admin
  io.emit('update_online_admins', getOnlineAdminUsernames()); // Siarkan status online ke semua
  socket.emit('initial_pick_status', pickedChats); // Kirim status pick spesifik ke klien yang terhubung
  io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Siarkan template sebagai array

  // Kirim status WhatsApp saat ini pada koneksi
  // Periksa instance sock dan state koneksinya dengan aman
  if (sock?.ws?.readyState === sock.ws.OPEN) {
       socket.emit('whatsapp_connected', { username: sock.user?.id || 'N/A' });
  } else if (sock?.ws?.readyState === sock.ws.CONNECTING) {
       socket.emit('whatsapp_connecting', {});
  } else if (qrDisplayed && currentQrCode) {
       // Jika QR ditampilkan oleh kode kita, berarti WA menunggu scan setelah disconnect yang perlu re-auth
       socket.emit('whatsapp_fatal_disconnected', { message: 'Sesi invalid. Menunggu QR Code baru...' }); // Indikasikan perlu QR
       // Kirim QR hanya ke Super Admin yang terhubung
       if (getAdminInfoBySocketId(socket.id)?.role === 'superadmin') {
           socket.emit('whatsapp_qr', currentQrCode);
       }
  }
   else {
      // Asumsi WA terputus atau belum diinisialisasi
       socket.emit('whatsapp_disconnected', { reason: 'Not Connected', statusCode: 'N/A', message: 'Koneksi WhatsApp belum siap atau terputus.' });
  }


  socket.on('request_initial_data', () => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (adminInfo) {
      console.log(`[SOCKET] Admin ${adminInfo.username} meminta data awal.`);
      const chatHistoryForClient = {}; // Klien mengharapkan kunci berupa normalized chatId
      // Iterasi melalui kunci dari state backend (yang sudah normalized chatId)
      for (const chatId in chatHistory) {
         // Tambahkan hasOwnProperty check
         if (!Object.prototype.hasOwnProperty.call(chatHistory, chatId)) continue;

        // Gunakan chatId langsung karena sudah dinormalisasi di kunci state backend
        const chatEntry = chatHistory[chatId];

        // Pastikan entri chat ada dan memiliki array messages yang valid
         if (chatEntry && Array.isArray(chatEntry.messages)) {
            chatHistoryForClient[chatId] = {
                status: chatEntry.status || 'open', // Pastikan status default
                messages: chatEntry.messages.map((message) => ({
                    ...message,
                    chatId: chatId // Pastikan chatId ada di setiap objek pesan untuk klien
                }))
            };
         } else if (chatEntry) {
              // Tangani kasus di mana entri chat ada tetapi messages bukan array
              chatHistoryForClient[chatId] = {
                   status: chatEntry.status || 'open',
                   messages: [] // Kirim array kosong
               };
              console.warn(`[SOCKET] Chat history untuk ${chatId} memiliki struktur pesan tidak valid.`);
         } else {
              console.warn(`[SOCKET] Mengabaikan chat history dengan ID tidak valid dalam state: ${chatId}`);
         }
      }
       // Kirim data awal termasuk chat history, admin, role, dan template balasan cepat (sebagai array)
      socket.emit('initial_data', {
          chatHistory: chatHistoryForClient,
          admins: admins, // Kirim daftar admin yang dimuat
          currentUserRole: adminInfo.role,
          quickReplies: Object.values(quickReplyTemplates) // Kirim template sebagai array
      });
    } else {
      console.warn(`[SOCKET] Socket ${socket.id} meminta data awal sebelum login.`);
      // Frontend menangani permintaan login jika tidak ada data awal yang dikirim pada reconnect_success/failed
    }
  });

  socket.on('get_chat_history', (chatId) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[SOCKET] Socket ${socket.id} meminta history sebelum login.`);
        return socket.emit('chat_history_error', { chatId, message: 'Login diperlukan.' });
    }
    const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId input
    if (!normalizedChatId) { // Periksa jika normalisasi gagal
         console.warn(`[SOCKET] Admin ${adminInfo?.username} meminta history dengan ID chat tidak valid: ${chatId}`);
         return socket.emit('chat_history_error', { chatId, message: 'Chat ID tidak valid.' });
    }

    // Akses state chatHistory menggunakan normalized chatId
    const chatEntry = chatHistory[normalizedChatId];
     // Pastikan messages adalah array sebelum memetakan
    const history = Array.isArray(chatEntry?.messages) ? chatEntry.messages.map((message) => ({
      ...message,
      chatId: normalizedChatId // Pastikan chatId benar pada objek pesan yang dikirim ke klien
    })) : [];
    const status = chatEntry?.status || 'open';

    console.log(`[SOCKET] Mengirim history untuk chat ${normalizedChatId} (${history.length} pesan) ke admin ${adminInfo.username}.`);
    socket.emit('chat_history', { chatId: normalizedChatId, messages: history, status: status });
  });

  socket.on('admin_login', ({ username, password }) => {
      console.log(`[ADMIN] Menerima percobaan login untuk: ${username}`);
    const adminUser = admins[username]; // Cari di data admin yang dimuat
    if (adminUser && adminUser.password === password) { // (CONSIDER HASHING PASSWORDS)
      const existingSocketId = usernameToSocketId[username];
      // Periksa apakah admin dengan username ini sudah login dengan socket yang aktif
      if (existingSocketId && io.sockets.sockets.get(existingSocketId)) {
         console.warn(`[ADMIN] Login gagal: Admin ${username} sudah login dari socket ${existingSocketId}.`);
         socket.emit('login_failed', { message: 'Akun ini sudah login di tempat lain.' });
         return;
      }
       // Jika usernameToSocketId memiliki entri tapi socket-nya sudah hilang, bersihkan statenya terlebih dahulu
       if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
            console.log(`[ADMIN] Admin ${username} login. Membersihkan state socket lama ${existingSocketId} yang sudah tidak aktif.`);
            cleanupAdminState(existingSocketId); // Bersihkan state untuk socket lama yang mati
       }

      console.log(`[ADMIN] Login berhasil: ${username} (Socket ID: ${socket.id})`);
      // Simpan info admin dan petakan username ke socket ID baru
      adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
      usernameToSocketId[username] = socket.id;

      // Kirim login success dengan role dan state awal
      socket.emit('login_success', { username: username, initials: adminUser.initials, role: adminUser.role || 'admin', currentPicks: pickedChats });
      io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Pastikan template dikirim sebagai array
      io.emit('update_online_admins', getOnlineAdminUsernames()); // Beri tahu klien lain tentang admin online baru

    } else {
      console.log(`[ADMIN] Login gagal untuk username: ${username}. Username atau password salah.`);
      socket.emit('login_failed', { message: 'Username atau password salah.' });
    }
  });

  socket.on('admin_reconnect', ({ username }) => {
      console.log(`[ADMIN] Menerima percobaan reconnect untuk: ${username} (Socket ID: ${socket.id})`);
    const adminUser = admins[username]; // Cari di data admin yang dimuat
    // Untuk reconnect, kita tidak memeriksa password lagi, hanya verifikasi username ada
    if (adminUser) {
        const existingSocketId = usernameToSocketId[username];
        // Jika ada socket aktif yang ada untuk username ini, tutup
        if (existingSocketId && existingSocketId !== socket.id && io.sockets.sockets.get(existingSocketId)) {
             console.warn(`[ADMIN] Admin ${username} mereconnect. Menutup socket lama ${existingSocketId}.`);
             cleanupAdminState(existingSocketId); // Bersihkan state socket lama
             // Gunakan timeout untuk memutuskan socket lama agar event dapat diproses, lalu paksa tutup
             setTimeout(() => {
                  const oldSocket = io.sockets.sockets.get(existingSocketId);
                  if (oldSocket) {
                       try {
                           oldSocket.disconnect(true); // Paksa tutup socket lama
                           console.log(`[ADMIN] Socket lama ${existingSocketId} disconnected.`);
                       } catch (e) {
                           console.error(`[ADMIN] Error disconnecting old socket ${existingSocketId}:`, e);
                       }
                  } else {
                      console.log(`[ADMIN] Old socket ${existingSocketId} already gone.`);
                  }
             }, 100); // Penundaan kecil
        } else if (existingSocketId && !io.sockets.sockets.get(existingSocketId)) {
             // Jika ada entri tapi socket sudah hilang, bersihkan state yang kedaluwarsa
             console.log(`[ADMIN] Admin ${username} mereconnect. Socket lama ${existingSocketId} sudah tidak aktif. Membersihkan state lama.`);
              cleanupAdminState(existingSocketId); // Bersihkan state menggunakan socket ID yang tercatat
        }

        console.log(`[ADMIN] Reconnect berhasil untuk ${username} (Socket ID: ${socket.id})`);
        // Perbarui state untuk menggunakan socket ID baru untuk username ini
        adminSockets[socket.id] = { username: username, role: adminUser.role || 'admin' };
        usernameToSocketId[username] = socket.id;

        // Kirim reconnect success dengan role dan state awal
        socket.emit('reconnect_success', { username: username, currentPicks: pickedChats, role: adminUser.role || 'admin' });
        io.emit('quick_reply_templates_updated', Object.values(quickReplyTemplates)); // Pastikan template dikirim sebagai array
        io.emit('update_online_admins', getOnlineAdminUsernames()); // Beri tahu klien lain tentang update status online

    } else {
        console.warn(`[ADMIN] Reconnect failed: Admin ${username} not found in registered admins.`);
        // Jika pengguna tidak ditemukan di daftar admin, paksa mereka untuk login ulang
        socket.emit('reconnect_failed');
    }
  });


  socket.on('admin_logout', () => {
    // cleanupAdminState menangani penghapusan state dan emit update status online
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} logout dari socket ${socket.id}.`);
        // Prompt klien untuk menghapus cache dan session storage browser
        socket.emit('clear_cache');
        socket.emit('logout_success'); // Opsional: klien mungkin hanya mereset UI anyway
    } else {
         console.warn(`[ADMIN] Socket ${socket.id} mencoba logout tapi tidak terdaftar sebagai admin login.`);
         socket.emit('logout_failed', { message: 'Not logged in.' }); // Opsional
    }
  });

  socket.on('pick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
    const username = adminInfo.username;
    const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId input
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    const pickedBy = pickedChats[normalizedChatId];
    // Periksa apakah chat ada di history dan statusnya closed
    const chatEntry = chatHistory[normalizedChatId];
     if (chatEntry?.status === 'closed') {
         console.warn(`[PICK] Admin ${username} mencoba mengambil chat tertutup ${normalizedChatId}`);
         return socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa diambil.' });
     }
     // Jika chat tidak ada di state history, izinkan pick tapi buat entri placeholder
      if (!chatEntry) {
          console.warn(`[PICK] Admin ${username} mengambil chat baru ${normalizedChatId} yang belum ada di history state.`);
           chatHistory[normalizedChatId] = { status: 'open', messages: [] }; // Buat entri dengan status default 'open'
           saveChatHistoryToDatabase(); // Simpan entri chat baru ke DB
      }


    if (pickedBy && pickedBy !== username) {
      console.warn(`[PICK] Admin ${username} mencoba mengambil chat ${normalizedChatId} yang sudah diambil oleh ${pickedBy}`);
      socket.emit('pick_error', { chatId: normalizedChatId, message: `Sudah diambil oleh ${pickedBy}.` });
    } else { // Jika belum diambil, atau diambil oleh diri sendiri (klik lagi)
      pickedChats[normalizedChatId] = username; // Set picker baru/update
      console.log(`[PICK] Admin ${username} mengambil/mereset pick chat ${normalizedChatId}`);
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: username });
      io.emit('initial_pick_status', pickedChats); // Kirim update state pick lengkap ke semua klien

      // Mulai/reset timer auto-release hanya jika timeout dikonfigurasi dan diaktifkan
      if (config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(normalizedChatId, username);
      }

       // Tandai pesan masuk sebagai sudah dibaca untuk chat ini jika ada dan memiliki pesan
       // Logika ini ada di tempat yang benar, di dalam blok pick yang berhasil
       const updatedChatEntry = chatHistory[normalizedChatId]; // Ambil entri yang mungkin baru dibuat
       if (updatedChatEntry?.messages) { // Pastikan array messages ada
           let changed = false;
           // Iterasi mundur dari pesan terakhir
           for (let i = updatedChatEntry.messages.length - 1; i >= 0; i--) {
                // Pastikan objek pesan valid
                if (!updatedChatEntry.messages[i] || typeof updatedChatEntry.messages[i] !== 'object') continue;

                if (updatedChatEntry.messages[i].type === 'incoming' && updatedChatEntry.messages[i].unread) {
                    updatedChatEntry.messages[i].unread = false;
                    changed = true;
                } else if (updatedChatEntry.messages[i].type === 'outgoing') {
                    // Berhenti menandai sebagai dibaca saat menemukan pesan keluar
                    break; // Ini penting untuk hanya menandai blok pesan masuk terbaru
                }
           }
           if (changed) {
               console.log(`[MARK] Menandai pesan masuk sebagai dibaca untuk chat ${normalizedChatId} oleh ${adminInfo.username}.`);
               saveChatHistoryToDatabase(); // Simpan perubahan ke DB
               io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Beri tahu semua klien untuk memperbarui UI
           }
       }
        // Opsional: Kirim feedback ke pengirim pick
        // socket.emit('pick_success', { chatId: normalizedChatId, pickedBy: username, message: pickedBy ? 'Timer auto-release direset.' : 'Chat diambil.' });
    }
  });

  socket.on('unpick_chat', ({ chatId }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) return socket.emit('pick_error', { chatId, message: 'Login diperlukan.' });
     const username = adminInfo.username;
     const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId input
    if (!normalizedChatId) return socket.emit('pick_error', { chatId, message: 'Chat ID tidak valid.' });

    const pickedBy = pickedChats[normalizedChatId];
    // Izinkan unpick jika diambil oleh pengguna saat ini ATAU jika adalah Super Admin
    if (pickedBy === username || isSuperAdmin(username)) {
        if (pickedBy) { // Periksa apakah memang sedang diambil sebelum menghapus
            clearAutoReleaseTimer(normalizedChatId); // Bersihkan timer sebelum melepaskan
            delete pickedChats[normalizedChatId]; // Hapus dari state pickedChats
            console.log(`[PICK] Admin ${username} melepas chat ${normalizedChatId}`);
            io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Beri tahu klien lain
             io.emit('initial_pick_status', pickedChats); // Kirim update state lengkap
            // Opsional: Kirim feedback ke pengirim unpick
            socket.emit('pick_success', { chatId: normalizedChatId, pickedBy: null, message: 'Chat berhasil dilepas.' });
        } else {
            console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil.`);
             socket.emit('pick_error', { chatId: normalizedChatId, message: 'Chat ini tidak sedang diambil.' });
        }
    } else if (pickedBy) { // Jika diambil oleh orang lain dan bukan Super Admin
       console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} yang diambil oleh ${pickedBy}. Akses ditolak.`);
       socket.emit('pick_error', { chatId: normalizedChatId, message: `Hanya ${pickedBy} atau Super Admin yang bisa melepas chat ini.` });
    } else { // Seharusnya sudah ditangani oleh 'if' pertama, tapi sebagai fallback
         console.warn(`[PICK] Admin ${username} mencoba melepas chat ${normalizedChatId} dalam keadaan ambigu (tidak diambil oleh siapa pun?).`);
         // Meskipun tidak diambil, izinkan Super Admin untuk "unpick" apa pun secara implisit
          if (isSuperAdmin(username)) {
              console.log(`[PICK] Super Admin ${username} mencoba melepas chat ${normalizedChatId} yang tidak diambil. Membersihkan timer jika ada.`);
              clearAutoReleaseTimer(normalizedChatId); // Hanya pastikan timer bersih
              // Tidak perlu menghapus dari pickedChats karena memang tidak ada di sana
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

      const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId
      if (!normalizedChatId) {
           console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi dengan ID chat tidak valid: ${chatId}.`);
           return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat ID tidak valid.' });
      }

      if (!targetAdminUsername || typeof targetAdminUsername !== 'string' || targetAdminUsername.trim().length === 0) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi dengan target admin tidak valid.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Username admin target tidak valid.' });
      }

      const currentPickedBy = pickedChats[normalizedChatId];
      // Periksa apakah pengirim adalah picker saat ini ATAU Super Admin
      if (currentPickedBy !== senderAdminUsername && !isSuperAdmin(senderAdminUsername)) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba delegasi chat ${normalizedChatId} yang diambil oleh ${currentPickedBy || 'tidak ada'}. Akses ditolak.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: currentPickedBy ? `Chat ini sedang ditangani oleh ${currentPickedBy}.` : 'Chat ini belum diambil oleh Anda.' });
      }
      if (senderAdminUsername === targetAdminUsername) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke diri sendiri.`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Tidak bisa mendelegasikan ke diri sendiri.' });
      }
      // Periksa apakah admin target ada di daftar admin yang dimuat
      const targetAdminInfo = admins[targetAdminUsername];
      if (!targetAdminInfo) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan ke admin target tidak dikenal: ${targetAdminUsername}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: `Admin target '${targetAdminUsername}' tidak ditemukan.` });
      }

      // Periksa apakah chat ada di history state dan statusnya closed
      const chatEntry = chatHistory[normalizedChatId];
      if (chatEntry?.status === 'closed') {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mencoba mendelegasikan chat tertutup ${normalizedChatId}`);
          return socket.emit('delegate_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup. Tidak bisa didelegasikan.' });
      }
       // Jika chat tidak ada di state history, buat entri placeholder
      if (!chatEntry) {
          console.warn(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat baru ${normalizedChatId} yang belum ada di history state.`);
           chatHistory[normalizedChatId] = { status: 'open', messages: [] }; // Buat entri dengan status default 'open'
           await saveChatHistoryToDatabase(); // Simpan entri baru ke DB
      }


      console.log(`[DELEGATE] Admin ${senderAdminUsername} mendelegasikan chat ${normalizedChatId} ke ${targetAdminUsername}`);
      clearAutoReleaseTimer(normalizedChatId); // Bersihkan timer untuk pick pengirim
      pickedChats[normalizedChatId] = targetAdminUsername; // Set picker baru di state

      // Mulai timer auto-release untuk picker baru jika diaktifkan
      if (config.chatAutoReleaseTimeoutMinutes > 0) {
          startAutoReleaseTimer(normalizedChatId, targetAdminUsername);
      }

      // saveChatHistoryToDatabase(); // Sudah disimpan di atas jika chat baru dibuat, atau tidak perlu jika hanya update pick state

      // Emit update status pick ke semua klien
      io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: targetAdminUsername });
      io.emit('initial_pick_status', pickedChats); // Kirim update state lengkap

      const targetSocketId = usernameToSocketId[targetAdminUsername];
      if (targetSocketId && io.sockets.sockets.get(targetSocketId)) { // Periksa apakah admin target online dan terhubung
          io.to(targetSocketId).emit('chat_delegated_to_you', {
              chatId: normalizedChatId,
              fromAdmin: senderAdminUsername,
              message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} didelegasikan kepada Anda oleh ${senderAdminUsername}.` // Gunakan chatId sebagai fallback
          });
      } else {
           console.warn(`[DELEGATE] Target admin ${targetAdminUsername} offline atau socket terputus, tidak mengirim notifikasi delegasi via Socket.IO.`);
           // Mungkin kirim notifikasi ke pengirim bahwa target offline?
           socket.emit('delegate_info', { chatId: normalizedChatId, targetAdminUsername, message: `Chat berhasil didelegasikan ke ${targetAdminUsername}, tetapi admin tersebut sedang offline.` });
      }

      socket.emit('delegate_success', { chatId: normalizedChatId, targetAdminUsername, message: `Chat berhasil didelegasikan ke ${targetAdminUsername}.` }); // Konfirmasi ke pengirim
  });


  socket.on('reply_message', async ({ to, text, media }) => {
    const adminInfo = getAdminInfoBySocketId(socket.id);
    if (!adminInfo) {
        console.warn(`[REPLY] Socket ${socket.id} mencoba kirim pesan sebelum login.`);
        return socket.emit('send_error', { to: to, text, message: 'Login diperlukan.' });
    }
    const username = adminInfo.username;

    const chatId = normalizeChatId(to); // Normalisasi chatId target
    // Periksa apakah ID target valid DAN ada konten (teks atau data media)
    if (!chatId || (!text?.trim() && !media?.data)) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan dengan data tidak lengkap atau ID chat tidak valid.`);
        return socket.emit('send_error', { to: chatId, text, message: 'Data tidak lengkap (ID chat, teks, atau media kosong) atau ID chat tidak valid.' });
    }
     // Periksa status koneksi WhatsApp
    if (!sock || sock.ws?.readyState !== sock.ws.OPEN) {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan, tapi koneksi WA tidak siap.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Koneksi WhatsApp belum siap. Silakan coba lagi nanti.' });
    }

    const pickedBy = pickedChats[chatId];
    // Izinkan pengiriman jika diambil oleh pengguna saat ini ATAU adalah Super Admin
    const canReply = pickedBy === username || isSuperAdmin(username);

    if (!canReply) {
         const errorMsg = pickedBy ? `Sedang ditangani oleh ${pickedBy}. Ambil alih chat ini terlebih dahulu.` : 'Ambil chat ini terlebih dahulu.';
         console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat ${chatId}. Akses ditolak: ${errorMsg}`);
        return socket.emit('send_error', { to: chatId, text, message: errorMsg });
    }

     // Periksa apakah chat ada di history state dan statusnya closed
     const chatEntry = chatHistory[chatId];
     if (chatEntry?.status === 'closed') {
        console.warn(`[REPLY] Admin ${username} mencoba kirim pesan ke chat tertutup ${chatId}.`);
        return socket.emit('send_error', { to: chatId, text, media, message: 'Chat sudah ditutup. Tidak bisa mengirim balasan.' });
    }
     // Jika chat tidak ada di state history, buat entri placeholder
     if (!chatEntry) {
          console.log(`[REPLY] Admin ${username} mengirim pesan ke chat baru ${chatId} yang belum ada di history state.`);
          chatHistory[chatId] = { status: 'open', messages: [] };
           // Tidak perlu simpan di sini, penyimpanan dilakukan setelah menambahkan pesan di bawah
      }


    try {
      // Ambil inisial admin untuk tampilan pesan keluar
      const adminInfoFromAdmins = admins[username];
      const adminInitials = (adminInfoFromAdmins?.initials || username.substring(0, 3).toUpperCase()).substring(0,3);

      // Siapkan teks yang akan dikirim ke WA. Sertakan inisial.
      const textContent = text?.trim() || ''; // Gunakan teks asli yang sudah di-trim atau string kosong
      // Untuk pesan media, inisial akan ditambahkan sebagai caption. Untuk pesan teks saja, inisial ditambahkan ke teks.
      // Jika hanya media tanpa teks, kirim hanya inisial sebagai caption (atau tanpa caption jika diinginkan).
      const textForSendingToWA = textContent.length > 0
        ? `${textContent}\n\n-${adminInitials}`
        : (media ? `-${adminInitials}` : ''); // Kirim inisial jika hanya media, atau kosong jika tidak ada teks/media


      let sentMsgResult;
      let sentMediaType = null;
      let sentMimeType = null;
      let sentFileName = null;
      let sentTextContentForHistory = textContent; // Simpan teks asli tanpa inisial untuk history

      if (media) {
        if (!media.data || !media.type) {
             console.error(`[REPLY] Media data atau type kosong untuk chat ${chatId}`);
             return socket.emit('send_error', { to: chatId, text, media, message: 'Data media tidak valid.' });
        }
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const mediaMimeType = media.mimeType || media.type; // Gunakan mimeType yang disediakan atau tebak dari type

        const mediaOptions = {
          mimetype: mediaMimeType,
          fileName: media.name || 'file', // Gunakan nama yang disediakan atau default
          // Gunakan textForSendingToWA sebagai caption jika ada (baik itu teks asli + inisial, atau hanya inisial)
          caption: textForSendingToWA.length > 0 ? textForSendingToWA : undefined
        };

        console.log(`[WA] Mengirim media (${mediaMimeType}) ke ${chatId} oleh ${username}...`);

        // Tangani berbagai tipe media untuk pengiriman
        if (media.type.startsWith('image/')) {
             sentMsgResult = await sock.sendMessage(chatId, { image: mediaBuffer, ...mediaOptions });
             sentMediaType = 'imageMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        } else if (media.type.startsWith('video/')) {
             sentMsgResult = await sock.sendMessage(chatId, { video: mediaBuffer, ...mediaOptions });
             sentMediaType = 'videoMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        } else if (media.type.startsWith('audio/')) {
           // Periksa apakah terlihat seperti voice note berdasarkan MIME type atau flag eksplisit jika disediakan
           const isVoiceNote = mediaOptions.mimetype === 'audio/ogg; codecs=opus' || mediaOptions.mimetype === 'audio/mpeg' || mediaOptions.mimetype === 'audio/wav' || media.isVoiceNote; // Menambahkan media.isVoiceNote

            // Untuk voice notes, kirim sebagai audio dengan ptt: true dan abaikan caption dalam pesan audio itu sendiri.
            // Jika ada teks menyertainya, kirim sebagai pesan teks terpisah.
            if (isVoiceNote) {
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: true });
                 sentMediaType = 'audioMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = 'Voice Note'; // Paksa nama file untuk VN
                  // Jika ada teks menyertai voice note, kirim sebagai pesan teks terpisah
                 if (textContent.length > 0) { // Gunakan textContent asli di sini
                     console.log(`[WA] Mengirim teks caption VN terpisah ke ${chatId}`);
                     // Kirim teks asli dengan inisial sebagai pesan terpisah
                     await sock.sendMessage(chatId, { text: `-${adminInitials}: ${textContent}` }); // Sisipkan inisial
                 }
            } else { // File audio biasa
                 sentMsgResult = await sock.sendMessage(chatId, { audio: mediaBuffer, mimetype: mediaOptions.mimetype, ptt: false, caption: mediaOptions.caption }); // Sertakan caption jika ada
                 sentMediaType = 'audioMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
            }

        } else if (media.type === 'application/pdf' || media.type.startsWith('application/') || media.type.startsWith('text/')) {
             sentMsgResult = await sock.sendMessage(chatId, { document: mediaBuffer, ...mediaOptions });
              sentMediaType = 'documentMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name;
        }
         // Tambahkan handler untuk stiker jika perlu untuk pengiriman
         // else if (media.type === 'stickerMessage') {
         //      sentMsgResult = await sock.sendMessage(chatId, { sticker: mediaBuffer, ...mediaOptions });
         //      sentMediaType = 'stickerMessage'; sentMimeType = mediaOptions.mimetype; sentFileName = media.name || 'sticker';
         // }
        else {
          console.warn(`[REPLY] Tipe media tidak didukung untuk dikirim: ${media.type}`);
          socket.emit('send_error', { to: chatId, text, media, message: 'Tipe media tidak didukung.' });
          return; // Hentikan pemrosesan pada tipe media yang tidak didukung
        }

      } else { // Pesan teks saja
        if (textForSendingToWA.trim().length > 0) { // Pastikan konten teks yang dikirim ke WA tidak kosong setelah menambahkan inisial
           console.log(`[WA] Mengirim teks ke ${chatId} oleh ${username}...`);
           sentMsgResult = await sock.sendMessage(chatId, { text: textForSendingToWA });
            sentMediaType = 'conversation';
            sentMimeType = 'text/plain'; // Tipe mime standar untuk teks biasa
            sentFileName = null; // Tidak ada nama file untuk teks
        } else {
            console.warn(`[REPLY] Admin ${username} mencoba kirim pesan kosong (hanya spasi?).`);
            socket.emit('send_error', { to: chatId, text, media, message: 'Tidak ada konten untuk dikirim.' });
            return; // Hentikan pemrosesan jika tidak ada teks dan tidak ada media
        }
      }

      // Pastikan sentMsgResult adalah array dan ambil objek pesan pertama dari hasilnya
      // Catatan: Jika mengirim media dengan teks terpisah (seperti caption VN), sentMsgResult mungkin berisi beberapa pesan.
      // Kita hanya akan memproses hasil pesan *utama* di sini untuk kesederhanaan.
      const sentMsg = Array.isArray(sentMsgResult) ? sentMsgResult[0] : sentMsgResult;

      // Periksa apakah objek pesan yang dikirim valid
      if (!sentMsg || !sentMsg.key || !sentMsg.key.id) {
          console.error('[WA] sock.sendMessage gagal mengembalikan objek pesan terkirim yang valid.', sentMsgResult);
          // Kirim feedback error ke socket pengirim asli, tapi jangan hentikan pemrosesan
          socket.emit('send_error', { to: chatId, text: sentTextContentForHistory, media, message: 'Gagal mendapatkan info pesan terkirim dari WhatsApp.' });
          // Putuskan apakah Anda ingin berhenti di sini atau melanjutkan potensial menambahkan pesan parsial ke history.
          // Untuk ketahanan, mari berhenti memproses jika kita tidak bisa mendapatkan ID pesan.
          return;
      }

      // Buat objek data pesan keluar untuk history dan klien
      const outgoingMessageData = {
        id: sentMsg.key.id, // ID pesan WhatsApp
        chatId: chatId, // Tambahkan chatId di sini untuk kejelasan
        from: username, // Username admin (pengirim) - ini akan jadi nilai 'sender' di DB
        // Properti 'to' biasanya tidak disimpan di objek pesan dalam history, 'chatId' sudah cukup
        text: sentTextContentForHistory, // Konten teks asli (tanpa prefix inisial untuk tampilan di bubble)
        mediaType: sentMediaType, // Tipe media/pesan Baileys atau kustom
        mimeType: sentMimeType, // Tipe MIME media yang dikirim (jika ada)
        mediaData: media?.data || null, // Data Base64 media (jika tersedia dari klien) - PERINGATAN: Menyimpan Base64
        fileName: sentFileName, // Nama file (jika ada)
        initials: adminInitials, // Inisial admin (untuk kolom 'initials' di DB)
        timestamp: sentMsg.messageTimestamp // Timestamp dari WhatsApp
          ? new Date(parseInt(sentMsg.messageTimestamp) * 1000).toISOString() // Konversi Unix timestamp ke ISO string
          : new Date().toISOString(), // Fallback ke waktu saat ini
        type: 'outgoing', // Arah pesan
        unread: false, // Pesan keluar dianggap sudah dibaca secara default
        snippet: sentTextContentForHistory?.substring(0, 100) + (sentTextContentForHistory?.length > 100 ? '...' : '') || sentFileName || `[${sentMediaType?.replace('Message', '') || 'Media'}]` // Buat snippet untuk pesan keluar
      };

      // Akses state chatHistory menggunakan normalized chatId
      const dbChatId = chatId;

      // Pastikan entri chat dan array messages ada
      if (!chatHistory[dbChatId] || !Array.isArray(chatHistory[dbChatId].messages)) {
           console.log(`[HISTORY] Membuat/memperbaiki entri chat ${chatId} untuk pesan keluar.`);
           chatHistory[dbChatId] = { status: chatHistory[dbChatId]?.status || 'open', messages: [] };
       }

       // Tambahkan pesan keluar ke history, hindari duplikasi berdasarkan ID pesan
       if (!chatHistory[dbChatId].messages.some(m => m && typeof m === 'object' && m.id === outgoingMessageData.id)) {
         console.log(`[HISTORY] Menambahkan pesan keluar baru (ID: ${outgoingMessageData.id}) ke chat ${chatId}`);
         chatHistory[dbChatId].messages.push(outgoingMessageData);
         saveChatHistoryToDatabase(); // Simpan ke DB setelah menambahkan pesan
       } else {
           console.warn(`[HISTORY] Pesan keluar duplikat terdeteksi (ID: ${outgoingMessageData.id}), diabaikan penambahannya ke history state.`);
       }


      // Emit pesan keluar ke semua klien (termasuk pengirim) untuk memperbarui UI mereka
      io.emit('new_message', {
          ...outgoingMessageData,
          chatId: chatId, // Pastikan chatId ada di level teratas untuk klien
          chatStatus: chatHistory[dbChatId]?.status || 'open' // Sertakan status chat
      });

      // Kirim konfirmasi ke socket pengirim asli
      socket.emit('reply_sent_confirmation', {
          sentMsgId: outgoingMessageData.id,
          chatId: outgoingMessageData.chatId
      });

      // Reset timer auto-release jika pesan dikirim oleh picker saat ini
      if (pickedChats[chatId] === username && config.chatAutoReleaseTimeoutMinutes > 0) {
           startAutoReleaseTimer(chatId, username);
      }


    } catch (error) {
      console.error(`[REPLY] Gagal mengirim pesan ke ${chatId} oleh ${username}:`, error);
      // Kirim feedback error ke socket pengirim asli
      socket.emit('send_error', { to: chatId, text: textContent, media, message: 'Gagal mengirim: ' + (error.message || 'Error tidak diketahui') });
    }
  });

  socket.on('mark_as_read', ({ chatId }) => {
     const adminInfo = getAdminInfoBySocketId(socket.id);
     if (!adminInfo || !chatId || typeof chatId !== 'string') { // Added string check for chatId
         console.warn(`[SOCKET] Permintaan mark_as_read tanpa login atau chat ID: Socket ${socket.id}`);
         return;
     }

     const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId input
     if (!normalizedChatId) {
          console.warn(`[SOCKET] Admin ${adminInfo?.username} mencoba mark_as_read dengan ID chat tidak valid: ${chatId}`);
          return;
     }

     // Akses state chatHistory menggunakan normalized chatId
     const dbChatId = normalizedChatId;

     const pickedBy = pickedChats[normalizedChatId];
     // Izinkan menandai sebagai dibaca jika Super Admin ATAU jika diambil oleh pengguna saat ini
     if (isSuperAdmin(adminInfo.username) || pickedBy === adminInfo.username) {
         const chatEntry = chatHistory[dbChatId];
         if (chatEntry?.messages) { // Pastikan entri chat dan array messages ada
              let changed = false;
              // Iterasi mundur dari pesan terakhir
              for (let i = chatEntry.messages.length - 1; i >= 0; i--) {
                  // Pastikan objek pesan valid dan merupakan pesan masuk yang belum dibaca
                   if (!chatEntry.messages[i] || typeof chatEntry.messages[i] !== 'object') continue;

                   if (chatEntry.messages[i].type === 'incoming' && chatEntry.messages[i].unread) {
                       chatEntry.messages[i].unread = false;
                       changed = true;
                   } else if (chatEntry.messages[i].type === 'outgoing') {
                        // Berhenti menandai sebagai dibaca saat menemukan pesan keluar
                        // Kita hanya ingin menandai blok pesan masuk yang berurutan dari akhir.
                        break;
                   }
              }
              if (changed) {
                  console.log(`[MARK] Menandai pesan masuk sebagai dibaca untuk chat ${normalizedChatId} oleh ${adminInfo.username}.`);
                  saveChatHistoryToDatabase(); // Simpan perubahan ke DB
                  io.emit('update_chat_read_status', { chatId: normalizedChatId }); // Beri tahu semua klien untuk memperbarui UI
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

        const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId
        if (!normalizedChatId) {
            console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus chat dengan ID tidak valid.`);
            return socket.emit('superadmin_error', { message: 'Chat ID tidak valid.' });
        }

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus chat history untuk ${normalizedChatId}`);

        // Periksa apakah chat ada di state history sebelum mencoba penghapusan
        if (chatHistory[normalizedChatId]) {
            // Hapus dari state backend
            delete chatHistory[normalizedChatId];
            // Hapus dari state pickedChats jika sedang diambil
            if (pickedChats[normalizedChatId]) {
                clearAutoReleaseTimer(normalizedChatId);
                delete pickedChats[normalizedChatId];
            }

            // Hapus dari database
            const success = await deleteChatHistoryFromDatabase(normalizedChatId); // Kirim normalized ID ke fungsi DB

            if (success) {
                // Emit update ke semua klien
                io.emit('chat_history_deleted', { chatId: normalizedChatId });
                 // initial_pick_status sudah menangani pembaruan status pick
                 io.emit('initial_pick_status', pickedChats); // Kirim state picked yang diperbarui
                socket.emit('superadmin_success', { message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dihapus.` }); // Gunakan chatId sebagai fallback
            } else {
                 console.error(`[SUPERADMIN] Gagal menghapus chat ${normalizedChatId} dari database.`);
                 socket.emit('superadmin_error', { message: 'Gagal menghapus chat dari database.' });
                 // Catatan: Jika penghapusan DB gagal, state memory tidak konsisten dengan DB.
                 // Muat ulang atau reconnect akan mengembalikan data dari DB.
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

         // Bersihkan timer dan state picked untuk *semua* chat
         const chatIdsWithTimers = Object.keys(chatReleaseTimers); // Ambil kunci dari state timer
         if (chatIdsWithTimers.length > 0) {
              console.log(`[TIMER] Membersihkan ${chatIdsWithTimers.length} timer auto-release tersisa sebelum menghapus semua chat history...`);
              // Iterasi salinan kunci karena clearAutoReleaseTimer memodifikasi chatReleaseTimers
              for (const chatId of [...chatIdsWithTimers]) { // Gunakan spread (...) untuk membuat salinan
                   clearAutoReleaseTimer(chatId); // Fungsi ini menghapus ID timer dari chatReleaseTimers
              }
         }
         // Bersihkan state pickedChats setelah timer dibersihkan
         // PERBAIKAN: Gunakan delete untuk mengosongkan objek const
         Object.keys(pickedChats).forEach(key => delete pickedChats[key]);

         // Reset state chatHistory backend (deklarasi dengan 'let' jadi bisa di-reassign)
         chatHistory = {};


         // Hapus dari database
         const success = await deleteAllChatHistoryFromDatabase();

         if (success) {
             // Emit update ke semua klien
             io.emit('all_chat_history_deleted');
             io.emit('initial_pick_status', pickedChats); // Kirim state picked yang kosong
             socket.emit('superadmin_success', { message: 'Semua chat history berhasil dihapus.' });
         } else {
              console.error(`[SUPERADMIN] Gagal menghapus semua chat dari database.`);
             socket.emit('superadmin_error', { message: 'Gagal menghapus semua chat dari database.' });
             // Catatan: Jika penghapusan DB gagal, backend state kosong, tapi DB mungkin tidak.
         }
     });

     socket.on('add_admin', async ({ username, password, initials, role }) => {
        console.log(`[SUPERADMIN] Menerima permintaan tambah admin: ${username}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah admin.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menambah admin.' });
        }

        if (!username || typeof username !== 'string' || username.trim().length === 0 ||
            !password || typeof password !== 'string' || password.trim().length === 0 ||
            !initials || typeof initials !== 'string' || initials.trim().length === 0) {
             console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} data tidak lengkap.`);
            return socket.emit('superadmin_error', { message: 'Username, password, dan initials harus diisi.' });
        }
         const cleanedInitials = initials.trim().toUpperCase();
         if (cleanedInitials.length === 0 || cleanedInitials.length > 3 || !/^[A-Z]+$/.test(cleanedInitials)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} initials tidak valid: '${initials}'.`);
              return socket.emit('superadmin_error', { message: 'Initials harus 1-3 karakter huruf A-Z.' });
         }

        // Periksa terhadap state admin yang dimuat
        if (admins[username]) {
            console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menambah admin '${username}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Admin dengan username '${username}' sudah ada.` });
        }
         const validRoles = ['admin', 'superadmin'];
         if (!role || typeof role !== 'string' || !validRoles.includes(role)) {
              console.warn(`[SUPERADMIN] Permintaan tambah admin dari ${adminInfo.username} role tidak valid: ${role}`);
              return socket.emit('superadmin_error', { message: 'Role admin tidak valid. Gunakan "admin" atau "superadmin".' });
         }
         // Cegah admin biasa membuat Super Admin
         if (role === 'superadmin' && !isSuperAdmin(adminInfo.username)) {
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} (role ${adminInfo.role}) mencoba menambah admin dengan role 'superadmin'. Akses ditolak.`);
              return socket.emit('superadmin_error', { message: 'Hanya Super Admin yang bisa membuat Super Admin baru.' });
         }


        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menambah admin baru: ${username} (${role})`);

        // Perbarui state backend - Buat objek admins baru sementara untuk penyimpanan
         const updatedAdmins = {
            ...admins, // Salin admin saat ini
             [username]: { // Tambahkan admin baru
                 password: password, // Simpan password plaintext (PERTIMBANGKAN HASHING DI PRODUKSI)
                 initials: cleanedInitials,
                 role: role
             }
         };

        // Simpan updated admins ke database dan kirim pembaruan
        try {
            await saveAdmins(updatedAdmins); // Simpan objek yang diperbarui ke DB
            admins = updatedAdmins; // Perbarui state in-memory HANYA setelah penyimpanan DB berhasil
            console.log('[SUPERADMIN] State admin dan DB berhasil diupdate.');
            io.emit('registered_admins', admins); // Emit daftar yang diperbarui
            socket.emit('superadmin_success', { message: `Admin '${username}' berhasil ditambahkan.` });
        } catch (error) {
             console.error('[SUPERADMIN] Gagal menyimpan admin setelah menambah:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan data admin '${username}' ke database.` });
             // State in-memory 'admins' TIDAK diperbarui jika penyimpanan gagal
        }
     });

      socket.on('delete_admin', async ({ usernameToDelete }) => {
          console.log(`[SUPERADMIN] Menerima permintaan hapus admin: ${usernameToDelete}`);
          const adminInfo = getAdminInfoBySocketId(socket.id);
          if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
              console.warn(`[SUPERADMIN] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus admin.`);
              return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa menghapus admin.' });
          }

          if (!usernameToDelete || typeof usernameToDelete !== 'string' || usernameToDelete.trim().length === 0) {
               console.warn(`[SUPERADMIN] Permintaan hapus admin dari ${adminInfo.username} data tidak lengkap.`);
              return socket.emit('superadmin_error', { message: 'Username admin yang akan dihapus tidak valid.' });
          }
          // Cegah admin menghapus diri sendiri
          if (usernameToDelete === adminInfo.username) {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus akun sendiri.`);
              return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus akun Anda sendiri.' });
          }
           // Cegah menghapus Super Admin terakhir
           const superAdmins = Object.keys(admins).filter(user => admins[user]?.role === 'superadmin');
           if (superAdmins.length <= 1 && superAdmins.includes(usernameToDelete)) { // Cek jika dia adalah SATU-SATUNYA super admin atau super admin terakhir
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus Super Admin terakhir: ${usernameToDelete}`);
               return socket.emit('superadmin_error', { message: 'Tidak bisa menghapus Super Admin terakhir. Harus ada minimal satu Super Admin.' });
           }


          if (!admins[usernameToDelete]) { // Periksa terhadap state admin yang dimuat
               console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba menghapus admin '${usernameToDelete}' yang tidak ditemukan.`);
               return socket.emit('superadmin_error', { message: `Admin dengan username '${usernameToDelete}' tidak ditemukan.` });
          }

          console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} menghapus admin: ${usernameToDelete}`);

           // Jika admin yang akan dihapus sedang online, bersihkan statenya dan putuskan socketnya
           const targetSocketId = usernameToSocketId[usernameToDelete];
           if(targetSocketId && io.sockets.sockets.get(targetSocketId)) { // Periksa apakah socket masih aktif
                console.log(`[SUPERADMIN] Admin ${usernameToDelete} online, membersihkan state dan memutuskan koneksi socket ${targetSocketId}.`);
                cleanupAdminState(targetSocketId); // Ini membersihkan mereka dari adminSockets/usernameToSocketId dan melepaskan pick mereka
                 // Putuskan socket secara eksplisit saat shutdown jika masih terhubung
                 try {
                     io.sockets.sockets.get(targetSocketId).disconnect(true); // Paksa tutup
                 } catch (e) {
                     console.error(`[SUPERADMIN] Error disconnecting socket ${targetSocketId} for deleted admin ${usernameToDelete}:`, e);
                 }
           } else if (usernameToSocketId[usernameToDelete]) {
               // Admin mungkin ada di usernameToSocketId tapi socketnya sudah hilang (misal, disconnect mendadak). Bersihkan state.
                console.log(`[SUPERADMIN] Admin ${usernameToDelete} offline atau socket sudah hilang. Membersihkan state.`);
                // cleanupAdminState aman dipanggil meskipun socket tidak lagi ada di io.sockets.sockets
                 // Panggil cleanupAdminState untuk memastikan state picks dan online status bersih jika mereka sempat online
                 const usernameCleaned = cleanupAdminState(usernameToSocketId[usernameToDelete]);
                 if (!usernameCleaned) { // Jika cleanupState tidak menemukan socket ID, bersihkan picks secara manual jika ada
                    const chatsPickedByDeletedAdmin = Object.keys(pickedChats).filter(chatId => pickedChats[chatId] === usernameToDelete);
                     chatsPickedByDeletedAdmin.forEach(chatId => {
                        clearAutoReleaseTimer(chatId); // Bersihkan timer mereka
                        delete pickedChats[chatId]; // Hapus pick mereka
                        console.log(`[ADMIN] Chat ${chatId} dilepas karena admin ${usernameToDelete} dihapus.`);
                        io.emit('update_pick_status', { chatId: chatId, pickedBy: null }); // Beri tahu klien
                     });
                 }

               // Emit update tentang admin online (yang dihapus sekarang pasti tidak online) dan chat yang diambil
               io.emit('update_online_admins', getOnlineAdminUsernames());
               io.emit('initial_pick_status', pickedChats);
           } else {
               // Jika admin tidak online atau tidak ada di usernameToSocketId, tidak ada state online/picked yang perlu dibersihkan secara spesifik oleh mereka.
               console.log(`[SUPERADMIN] Admin ${usernameToDelete} tidak online. Melanjutkan penghapusan.`);
           }


           // Perbarui state backend - Buat objek admins baru yang tidak menyertakan yang akan dihapus
           const updatedAdmins = { ...admins }; // Salin admin saat ini
           delete updatedAdmins[usernameToDelete]; // Hapus admin yang ditentukan

          // Simpan updated admins ke database dan kirim pembaruan
           try {
               await saveAdmins(updatedAdmins); // Simpan objek yang diperbarui ke DB
               admins = updatedAdmins; // Perbarui state in-memory HANYA setelah penyimpanan DB berhasil
               console.log('[SUPERADMIN] State admin dan DB berhasil diupdate.');
               io.emit('registered_admins', admins); // Emit daftar yang diperbarui
               socket.emit('superadmin_success', { message: `Admin '${usernameToDelete}' berhasil dihapus.` });
           } catch (error) {
               console.error('[SUPERADMIN] Gagal menyimpan admin setelah menghapus:', error);
               socket.emit('superadmin_error', { message: `Gagal menghapus data admin '${usernameToDelete}' dari database.` });
               // State in-memory 'admins' TIDAK diperbarui jika penyimpanan gagal
           }
      });


     socket.on('close_chat', async ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan tutup chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        if (!adminInfo || !chatId || typeof chatId !== 'string') {
             console.warn(`[CHAT STATUS] Socket ${socket.id} mencoba tutup chat tanpa login atau chat ID.`);
             return socket.emit('chat_status_error', { chatId, message: 'Login diperlukan atau Chat ID tidak valid.' });
        }
        const username = adminInfo.username;
        const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId input
        if (!normalizedChatId) { // Periksa jika normalisasi gagal
            console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat dengan ID tidak valid: ${chatId}`);
            return socket.emit('chat_status_error', { chatId, message: 'Chat ID tidak valid.' });
        }

        // Akses state chatHistory menggunakan normalized chatId
        const chatEntry = chatHistory[normalizedChatId];

         // Periksa apakah chat ada di state history
        if (!chatEntry) {
             console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang tidak ditemukan di history state.`);
             // Opsional coba muat dari DB jika tidak ada di state? Untuk kesederhanaan, andalkan state.
             return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan di memory state.' });
        }

        const pickedBy = pickedChats[normalizedChatId];
        // Izinkan menutup jika diambil oleh pengguna saat ini ATAU Super Admin
        if (isSuperAdmin(username) || pickedBy === username) {
            if (chatEntry.status === 'closed') {
                 console.warn(`[CHAT STATUS] Admin ${username} mencoba tutup chat ${normalizedChatId} yang sudah tertutup.`);
                 return socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Chat sudah ditutup.' });
            }

            console.log(`[CHAT STATUS] Admin ${username} menutup chat ${normalizedChatId}`);
            // Perbarui state backend
            chatEntry.status = 'closed';

            // Hapus dari state picked jika sedang diambil
            if (pickedBy) {
                 clearAutoReleaseTimer(normalizedChatId); // Bersihkan timer sebelum melepaskan
                 delete pickedChats[normalizedChatId]; // Hapus dari state pickedChats
                 io.emit('update_pick_status', { chatId: normalizedChatId, pickedBy: null }); // Beri tahu klien lain
                 io.emit('initial_pick_status', pickedChats); // Kirim update state lengkap
            }

            // Simpan perubahan status ke database
             try {
                // Hanya perlu update status di DB, tidak perlu save seluruh history
                const db = await getDb();
                // Gunakan normalizedChatId
                const result = await db.run('UPDATE chat_history SET status = ? WHERE chat_id = ?', ['closed', normalizedChatId]);

                if (result.changes > 0) {
                    console.log(`[DATABASE] Status chat ${normalizedChatId} berhasil diupdate ke 'closed' di database.`);

                    // Emit pembaruan ke semua klien SETELAH penyimpanan DB berhasil
                    io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' }); // Beri tahu semua klien
                    socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil ditutup.` }); // Konfirmasi ke pengirim
                } else {
                    console.warn(`[DATABASE] Tidak ada baris yang terupdate saat mencoba set status 'closed' untuk ${normalizedChatId}. Mungkin chat_id tidak ada di chat_history.`);
                    // Chat tidak ada di DB, meskipun ada di state memory. Ini inkonsisten.
                    // Tetap kirim sukses ke frontend berdasarkan state memory? Atau error?
                    // Untuk saat ini, kirim sukses berdasarkan update state memory.
                     io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'closed' });
                     socket.emit('chat_status_success', { chatId: normalizedChatId, status: 'closed', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil ditutup (state memory). DB mungkin tidak konsisten.` });
                }

             } catch (error) {
                console.error(`[DATABASE] Gagal update status chat ${normalizedChatId} ke 'closed' di database:`, error);
                 // Kembalikan state di memory (opsional)
                 // chatEntry.status = 'open';
                 socket.emit('chat_status_error', { chatId: normalizedChatId, message: 'Gagal menyimpan status chat ke database.' });
             }

        } else {
             const errorMsg = pickedBy ? `Hanya ${pickedBy} atau Super Admin yang bisa menutup chat ini.` : `Chat ini tidak diambil oleh siapa pun. Hanya Super Admin yang bisa menutup chat yang tidak diambil.`;
             console.warn(`[CHAT STATUS] Admin ${username} mencoba menutup chat ${normalizedChatId}. Akses ditolak: ${errorMsg}`);
            socket.emit('chat_status_error', { chatId: normalizedChatId, message: errorMsg }); // Kirim error ke pengirim
        }
     });

      socket.on('open_chat', async ({ chatId }) => {
        console.log(`[CHAT STATUS] Permintaan buka chat: ${chatId}`);
        const adminInfo = getAdminInfoBySocketId(socket.id);
        // Hanya izinkan Super Admin membuka kembali chat
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
             console.warn(`[CHAT STATUS] Akses ditolak: Admin ${adminInfo?.username} mencoba membuka kembali chat.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa membuka kembali chat.' });
        }

        const normalizedChatId = normalizeChatId(chatId); // Normalisasi chatId
        if (!normalizedChatId) {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat dengan ID tidak valid.`);
            return socket.emit('superadmin_error', { message: 'Chat ID tidak valid.' });
        }

        // Akses state chatHistory menggunakan normalized chatId
        const chatEntry = chatHistory[normalizedChatId];

         // Periksa apakah chat ada di state history
        if (!chatEntry) {
             console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang tidak ditemukan di history state.`);
             return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat tidak ditemukan di memory state.' });
        }

         // Periksa apakah chat sudah terbuka
         if (chatEntry.status === 'open') {
              console.warn(`[SUPERADMIN] Admin ${adminInfo.username} mencoba membuka chat ${normalizedChatId} yang sudah terbuka.`);
              return socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Chat sudah terbuka.' });
         }

        console.log(`[SUPERADMIN] Super Admin ${adminInfo.username} membuka kembali chat ${normalizedChatId}`);
        // Perbarui state backend
        chatEntry.status = 'open';

        // Simpan perubahan status ke database
         try {
             const db = await getDb();
             // Gunakan normalizedChatId
             const result = await db.run('UPDATE chat_history SET status = ? WHERE chat_id = ?', ['open', normalizedChatId]);

             if (result.changes > 0) {
                console.log(`[DATABASE] Status chat ${normalizedChatId} berhasil diupdate ke 'open' di database.`);

                // Emit pembaruan ke semua klien SETELAH penyimpanan DB berhasil
                io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' }); // Beri tahu semua klien
                socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali.` }); // Konfirmasi ke pengirim
            } else {
                 console.warn(`[DATABASE] Tidak ada baris yang terupdate saat mencoba set status 'open' untuk ${normalizedChatId}. Mungkin chat_id tidak ada di chat_history.`);
                 // Chat tidak ada di DB, meskipun ada di state memory.
                 // Tetap kirim sukses ke frontend berdasarkan state memory.
                 io.emit('chat_status_updated', { chatId: normalizedChatId, status: 'open' });
                 socket.emit('superadmin_success', { chatId: normalizedChatId, status: 'open', message: `Chat ${normalizedChatId.split('@')[0] || normalizedChatId} berhasil dibuka kembali (state memory). DB mungkin tidak konsisten.` });
            }

         } catch (error) {
            console.error(`[DATABASE] Gagal update status chat ${normalizedChatId} ke 'open' di database:`, error);
             // Kembalikan state di memory (opsional)
             // chatEntry.status = 'closed';
            socket.emit('superadmin_error', { chatId: normalizedChatId, message: 'Gagal menyimpan status chat ke database.' });
         }
     });

    // --- QUICK REPLY TEMPLATES HANDLERS (SUPER ADMIN) ---
    socket.on('add_quick_reply', async ({ shortcut, text }) => {
        const adminInfo = getAdminInfoBySocketId(socket.id);
        // Hanya izinkan Super Admin
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba menambah template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan tambah template dari Super Admin ${adminInfo.username}: ${shortcut}`);

        // Validasi data input
        if (!shortcut || typeof shortcut !== 'string' || shortcut.trim().length === 0 ||
            !text || typeof text !== 'string' || text.trim().length === 0) {
            console.warn(`[TEMPLATES] Data template tidak lengkap dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Data template tidak lengkap (shortcut dan text diperlukan).' });
        }
        const cleanedShortcut = shortcut.trim().toLowerCase(); // Normalisasi shortcut ke lowercase

        // Regex validasi shortcut: dimulai dengan '/' diikuti 1 atau lebih huruf kecil, angka, underscore, atau hyphen.
        const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
        if (!shortcutValidationRegex.test(cleanedShortcut)) {
             console.warn(`[TEMPLATES] Shortcut template tidak valid dari ${adminInfo.username}: '${shortcut}'. Tidak sesuai format.`);
             return socket.emit('superadmin_error', { message: 'Shortcut harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).' });
        }

        // Periksa terhadap state backend
        if (quickReplyTemplates[cleanedShortcut]) {
            console.warn(`[TEMPLATES] Admin ${adminInfo.username} mencoba menambah template '${cleanedShortcut}' yang sudah ada.`);
            return socket.emit('superadmin_error', { message: `Template dengan shortcut '${cleanedShortcut}' sudah ada.` });
        }

        // Hasilkan ID yang stabil (gunakan shortcut yang sudah dibersihkan sebagai ID)
        const templateId = cleanedShortcut; // ID sama dengan shortcut

        // Buat objek baru untuk state template yang diperbarui
        const updatedTemplates = {
            ...quickReplyTemplates, // Salin template saat ini
             [cleanedShortcut]: { // Tambahkan template baru
                 id: templateId, // Simpan ID yang dihasilkan
                 shortcut: cleanedShortcut, // Simpan shortcut yang sudah dibersihkan
                 text: text.trim() // Simpan teks yang sudah di-trim
             }
         };

        // Simpan ke database dan kirim pembaruan
        try {
             await saveQuickReplyTemplates(updatedTemplates); // Simpan objek yang diperbarui ke DB
             quickReplyTemplates = updatedTemplates; // Perbarui state in-memory HANYA setelah penyimpanan DB berhasil
             console.log('[TEMPLATES] State template dan DB berhasil diupdate.');
             // saveQuickReplyTemplates secara internal sudah emit quick_reply_templates_updated on success
             socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil ditambahkan.` });
        } catch (error) {
             console.error('[TEMPLATES] Gagal menyimpan template setelah menambah:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan template '${cleanedShortcut}' ke database.` });
             // State in-memory 'quickReplyTemplates' TIDAK diperbarui jika penyimpanan gagal
        }
    });

    socket.on('update_quick_reply', async ({ id, shortcut, text }) => {
         const adminInfo = getAdminInfoBySocketId(socket.id);
        // Hanya izinkan Super Admin
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba update template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan update template ID ${id} dari Super Admin ${adminInfo.username}`);

         // Validasi data input
        if (!id || typeof id !== 'string' || id.trim().length === 0 ||
            !shortcut || typeof shortcut !== 'string' || shortcut.trim().length === 0 ||
            !text || typeof text !== 'string' || text.trim().length === 0) {
             console.warn(`[TEMPLATES] Data template update tidak lengkap dari ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: 'Data template tidak lengkap.' });
        }
        const cleanedShortcut = shortcut.trim().toLowerCase(); // Normalisasi shortcut baru

        // Regex validasi shortcut baru
        const shortcutValidationRegex = /^\/[a-z0-9_-]+$/;
        if (!shortcutValidationRegex.test(cleanedShortcut)) {
             console.warn(`[TEMPLATES] Shortcut template baru tidak valid dari ${adminInfo.username}: '${shortcut}'. Tidak sesuai format.`);
             return socket.emit('superadmin_error', { message: 'Shortcut baru harus diawali dengan "/" dan hanya berisi huruf kecil, angka, hyphen (-), atau underscore (_).' });
        }

         // Di state backend, kuncinya adalah shortcut. ID juga adalah shortcut.
         const oldShortcut = id; // Asumsi ID == shortcut lama

         // Periksa apakah template dengan shortcut lama ada di state
         if (!quickReplyTemplates[oldShortcut]) {
             console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${oldShortcut}) tidak ditemukan untuk diupdate oleh ${adminInfo.username}.`);
             return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
         }

         // Jika shortcut berubah (shortcut baru berbeda dari yang lama), periksa apakah shortcut baru sudah ada untuk *template lain*
         if (oldShortcut !== cleanedShortcut && quickReplyTemplates[cleanedShortcut]) {
             console.warn(`[TEMPLATES] Admin ${adminInfo.username} mencoba update template menjadi shortcut '${cleanedShortcut}' yang sudah ada.`);
             return socket.emit('superadmin_error', { message: `Template dengan shortcut '${cleanedShortcut}' sudah ada.` });
         }

        // Buat objek baru untuk state template yang diperbarui
        const updatedTemplates = { ...quickReplyTemplates }; // Salin template saat ini

        // Jika shortcut berubah, hapus entri lama dan tambahkan yang baru
        if (oldShortcut !== cleanedShortcut) {
             console.log(`[TEMPLATES] Shortcut template ID ${id} changed from '${oldShortcut}' to '${cleanedShortcut}'. Deleting old and adding new.`);
             delete updatedTemplates[oldShortcut]; // Hapus entri lama
             // ID baru akan berdasarkan shortcut baru
             updatedTemplates[cleanedShortcut] = {
                 id: cleanedShortcut, // ID adalah shortcut baru
                 shortcut: cleanedShortcut,
                 text: text.trim()
             };
        } else {
             // Jika shortcut tidak berubah, cukup perbarui teks entri yang ada
             console.log(`[TEMPLATES] Shortcut template ID ${id} remains '${oldShortcut}'. Updating text.`);
             updatedTemplates[cleanedShortcut].text = text.trim(); // Perbarui teks untuk kunci yang ada
             // ID tetap sama
        }

        // Simpan updated templates ke database dan kirim pembaruan
        try {
             await saveQuickReplyTemplates(updatedTemplates); // Simpan objek yang diperbarui ke DB
             quickReplyTemplates = updatedTemplates; // Perbarui state in-memory HANYA setelah penyimpanan DB berhasil
             console.log('[TEMPLATES] State template dan DB berhasil diupdate.');
             // saveQuickReplyTemplates secara internal sudah emit quick_reply_templates_updated on success
             socket.emit('superadmin_success', { message: `Template '${cleanedShortcut}' berhasil diupdate.` });
        } catch (error) {
             console.error('[TEMPLATES] Gagal menyimpan template setelah update:', error);
             socket.emit('superadmin_error', { message: `Gagal menyimpan template '${cleanedShortcut}' ke database.` });
              // State in-memory 'quickReplyTemplates' TIDAK diperbarui jika penyimpanan gagal
        }

    });


    socket.on('delete_quick_reply', async ({ id }) => {
         const adminInfo = getAdminInfoBySocketId(socket.id);
        // Hanya izinkan Super Admin
        if (!adminInfo || !isSuperAdmin(adminInfo.username)) {
            console.warn(`[TEMPLATES] Akses ditolak: Admin ${adminInfo?.username} mencoba menghapus template.`);
            return socket.emit('superadmin_error', { message: 'Akses ditolak. Hanya Super Admin yang bisa mengelola template.' });
        }

        console.log(`[TEMPLATES] Permintaan hapus template ID ${id} dari Super Admin ${adminInfo.username}`);

        // Validasi data input
        if (!id || typeof id !== 'string' || id.trim().length === 0) {
             console.warn(`[TEMPLATES] Template ID tidak valid dari ${adminInfo.username} untuk dihapus.`);
            return socket.emit('superadmin_error', { message: 'Template ID tidak valid.' });
        }

        // Di state backend, kuncinya adalah shortcut. ID juga adalah shortcut.
        const shortcutToDelete = id; // Asumsi ID == shortcut yang akan dihapus

        // Periksa terhadap state backend
        if (!quickReplyTemplates[shortcutToDelete]) {
            console.warn(`[TEMPLATES] Template dengan ID ${id} (shortcut ${shortcutToDelete}) tidak ditemukan untuk dihapus oleh ${adminInfo.username}.`);
            return socket.emit('superadmin_error', { message: `Template tidak ditemukan.` });
        }

        // Buat objek baru untuk state template yang diperbarui
        const updatedTemplates = { ...quickReplyTemplates }; // Salin template saat ini
        delete updatedTemplates[shortcutToDelete]; // Hapus template yang ditentukan

         // Simpan updated templates ke database dan kirim pembaruan
         try {
             await saveQuickReplyTemplates(updatedTemplates); // Simpan objek yang diperbarui ke DB
             quickReplyTemplates = updatedTemplates; // Perbarui state in-memory HANYA setelah penyimpanan DB berhasil
             console.log('[TEMPLATES] State template dan DB berhasil diupdate.');
             // saveQuickReplyTemplates secara internal sudah emit quick_reply_templates_updated on success
             socket.emit('superadmin_success', { message: `Template '${shortcutToDelete}' berhasil dihapus.` });
         } catch (error) {
              console.error('[TEMPLATES] Gagal menyimpan template setelah menghapus:', error);
              socket.emit('superadmin_error', { message: `Gagal menghapus template '${shortcutToDelete}' dari database.` });
              // State in-memory 'quickReplyTemplates' TIDAK diperbarui jika penyimpanan gagal
         }
    });
    // --- END QUICK REPLY TEMPLATES HANDLERS ---


  socket.on('disconnect', (reason) => {
    console.log(`[SOCKET] Socket ${socket.id} terputus. Alasan: ${reason}`);
    // cleanupAdminState menangani penghapusan state dan emit update status online
    const username = cleanupAdminState(socket.id);
    if (username) {
        console.log(`[ADMIN] Admin ${username} state dibersihkan.`);
    }
  });

});


// --- Shutdown Handling ---
const shutdownHandler = async (signal) => {
    console.log(`[SERVER] Menerima ${signal}. Memulai proses pembersihan...`);

    // Bersihkan state admin untuk semua socket yang terhubung
    // Iterasi salinan kunci adminSockets karena cleanupAdminState memodifikasi adminSockets
    const connectedSocketIds = Object.keys(adminSockets);
    for (const socketId of [...connectedSocketIds]) { // Gunakan spread (...) untuk membuat salinan
         const adminInfo = getAdminInfoBySocketId(socketId);
         if (adminInfo) {
             console.log(`[ADMIN] Membersihkan state untuk admin ${adminInfo.username} (Socket ID: ${socketId}) selama shutdown.`);
             // cleanupAdminState menghapus admin dari adminSockets dan usernameToSocketId, dan melepaskan pick mereka.
             // Ini juga meng-emit update untuk admin online dan chat yang diambil.
             cleanupAdminState(socketId);
             // Putuskan socket secara eksplisit selama shutdown jika masih terhubung
             const currentSocket = io.sockets.sockets.get(socketId);
             if (currentSocket) {
                  try {
                      currentSocket.disconnect(true); // Paksa tutup
                      console.log(`[SOCKET] Forced disconnect for ${socketId}`);
                  } catch (e) {
                       console.error(`[SOCKET] Error forcing disconnect for ${socketId}:`, e);
                  }
             }
         }
    }
    // Pada titik ini, adminSockets dan usernameToSocketId seharusnya kosong.

    // Bersihkan timer auto-release yang tersisa
    // Periksa state chatReleaseTimers secara langsung
    const chatIdsWithTimers = Object.keys(chatReleaseTimers); // Ambil kunci dari state timer
    if (chatIdsWithTimers.length > 0) {
         console.log(`[TIMER] Membersihkan ${chatIdsWithTimers.length} timer auto-release yang tersisa...`);
         // Iterasi salinan kunci karena clearAutoReleaseTimer memodifikasi chatReleaseTimers
         for (const chatId of [...chatIdsWithTimers]) { // Gunakan salinan kunci
              // clearAutoReleaseTimer menghapus ID timer dari chatReleaseTimers
              clearAutoReleaseTimer(chatId); // Teruskan chatId (yang merupakan kunci)
         }
    }
    // Bersihkan seluruh state pickedChats, jaga-jaga jika cleanupAdminState ada yang terlewat
    // PERBAIKAN: Gunakan delete untuk mengosongkan objek const
    Object.keys(pickedChats).forEach(key => delete pickedChats[key]);


    // Tutup server Socket.IO
     console.log('[SOCKET] Menutup server Socket.IO...');
     try {
         // Gunakan pembungkus promise untuk await callback io.close()
         await new Promise(resolve => io.close(() => {
             console.log('[SOCKET] Callback penutupan server Socket.IO terpicu.');
             resolve();
         }));
         console.log('[SOCKET] Server Socket.IO tertutup.');
     } catch (e) {
          console.error('[SOCKET] Error saat menutup server Socket.IO:', e);
          // Lanjutkan proses shutdown meskipun ada error di sini
     }


    // Tutup koneksi WhatsApp
    // Periksa apakah instance sock ada dan WebSocket-nya belum tertutup atau sedang ditutup
    if (sock && sock.ws?.readyState !== sock.ws?.CLOSED && sock.ws?.readyState !== sock.ws?.CLOSING) {
        console.log('[WA] Menutup koneksi WhatsApp...');
        try {
            // Coba graceful logout dengan timeout
            await Promise.race([
                sock.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('WhatsApp logout timed out')), 5000)) // Tambahkan timeout 5 detik
            ]);
            console.log('[WA] Koneksi WhatsApp ditutup dengan graceful.');
        } catch (e) {
             console.error('[WA] Error selama logout WhatsApp atau timeout, memaksa end:', e);
             // Jika logout gagal atau timeout, paksa akhiri koneksi
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

    // --- Panggil Fungsi Menutup Database ---
    console.log('[DATABASE] Menutup koneksi database...');
    try {
        await closeDatabase(); // Fungsi ini sekarang diawait
        console.log('[DATABASE] Koneksi database berhasil ditutup.'); // Log ini sekarang hanya muncul jika closeDatabase berhasil
    } catch (e) {
         console.error('[DATABASE] Error saat menutup database:', e);
         // Lanjutkan proses shutdown meskipun ada error di sini
    }
    // --- Akhir Panggilan Fungsi Menutup Database ---


    console.log('[SERVER] Server dimatikan.');
    // Panggil process.exit() untuk memastikan proses Node.js diakhiri
    // Ini penting jika ada handle tak terduga yang masih menjaga event loop tetap hidup
    process.exit(0); // Keluar dengan sukses
};

// Tambahkan listener untuk event server 'close' sebagai jalur shutdown alternatif
server.on('close', () => {
    console.log('[SERVER] Server HTTP tertutup.');
    // Event ini mungkin terpicu setelah shutdownHandler atau sebagai bagian darinya (jika io.close menutup http server)
    // Untuk menghindari double-handling, pastikan shutdownHandler dirancang untuk idempoten atau menangani sumber daya yang sudah tertutup.
    // Memanggil shutdownHandler secara eksplisit pada SIGINT/SIGTERM lebih dapat diandalkan untuk sinyal OS.
});


// Tangani sinyal terminasi
process.on('SIGINT', () => shutdownHandler('SIGINT').catch(console.error)); // Ctrl+C, tambahkan catch untuk handler async
process.on('SIGTERM', () => shutdownHandler('SIGTERM').catch(console.error)); // kill command, tambahkan catch untuk handler async

// Tangani unhandled promise rejections dan uncaught exceptions
// Ini adalah error kritis. Catat dan kemudian coba shutdown yang graceful.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
   // Coba shutdown setelah penundaan singkat untuk memungkinkan logging
  setTimeout(() => {
      console.error('[SERVER] Mencoba shutdown karena unhandled rejection...');
      shutdownHandler('unhandledRejection').catch(console.error);
  }, 1000); // Tunda exit sebentar
});

process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught Exception:', err);
   // Coba shutdown setelah penundaan singkat untuk memungkinkan logging
  setTimeout(() => {
       console.error('[SERVER] Mencoba shutdown karena uncaught exception...');
       shutdownHandler('uncaughtException').catch(console.error); // Coba shutdown yang graceful
  }, 1000); // Tunda exit sebentar
});
