// database.js

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs'; // <-- Pastikan modul fs diimpor
import path from 'path'; // <-- Pastikan modul path diimpor
import { fileURLToPath } from 'url';

// Mendapatkan __dirname yang setara di ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pastikan direktori data dan media ada
const dbDir = path.join(__dirname, 'data');
const mediaDir = path.join(__dirname, 'media'); // <-- Direktori media
const dbPath = path.join(dbDir, 'helpdesk.db');

// Fungsi untuk memastikan direktori ada
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        console.log(`[DATABASE] Membuat direktori: ${dirPath}`);
        fs.mkdirSync(dirPath, { recursive: true });
    } else {
        // console.log(`[DATABASE] Direktori sudah ada: ${dirPath}`); // Opsional: verbose log
    }
}


// Singleton untuk koneksi database
let dbInstance = null;

/**
 * Mendapatkan koneksi database SQLite. Menggunakan pola singleton.
 * Jika koneksi belum ada, akan dibuat dan disimpan.
 * @returns {Promise<import('sqlite').Database>} Instance koneksi database.
 * @throws {Error} Jika gagal membuat koneksi database.
 */
async function getDb() {
    if (dbInstance) {
        return dbInstance;
    }

    try {
        // Pastikan direktori database dan media ada sebelum membuka DB
        ensureDirectoryExists(dbDir);
        ensureDirectoryExists(mediaDir); // <-- Pastikan direktori media juga ada

        console.log(`[DATABASE] Membuka database: ${dbPath}`);
        dbInstance = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });

        await dbInstance.exec('PRAGMA foreign_keys = ON;');
        console.log('[DATABASE] FOREIGN KEY constraints diaktifkan.');

        console.log('[DATABASE] Koneksi SQLite berhasil dibuat');
        return dbInstance;
    } catch (error) {
        console.error('[DATABASE] Gagal membuat koneksi SQLite:', error);
        dbInstance = null;
        throw error;
    }
}

/**
 * Menutup koneksi database SQLite.
 * @returns {Promise<void>}
 */
async function closeDatabase() {
    if (dbInstance) {
        console.log('[DATABASE] Menutup koneksi database...');
        try {
            await dbInstance.close();
            console.log('[DATABASE] Koneksi database ditutup.');
        } catch (error) {
             console.error('[DATABASE] Gagal menutup koneksi database:', error);
        } finally {
            dbInstance = null;
        }
    }
}


/**
 * Inisialisasi skema database (membuat tabel jika belum ada).
 * Juga memastikan direktori data dan media ada.
 * @async
 * @function initDatabase
 * @returns {Promise<void>}
 * @throws {Error} Jika gagal mengeksekusi perintah SQL untuk membuat tabel.
 */
async function initDatabase() {
    // Pastikan direktori ada sebelum mendapatkan koneksi DB
    ensureDirectoryExists(dbDir);
    ensureDirectoryExists(mediaDir); // <-- Pastikan direktori media juga ada

    const db = await getDb(); // Ini akan membuka koneksi dan membuat dir jika diperlukan

    try {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS chat_history (
                chat_id TEXT PRIMARY KEY,
                status TEXT DEFAULT 'open', -- e.g., 'open', 'closed'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Buat tabel untuk pesan - Dihapus mediaData, Ditambah filePath
        await db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, -- Message ID dari Baileys
                chat_id TEXT, -- FOREIGN KEY ke chat_history
                timestamp INTEGER, -- Unix timestamp (detik)
                type TEXT, -- e.g., 'incoming', 'outgoing'
                sender TEXT, -- customer JID for incoming, admin username for outgoing
                initials TEXT, -- admin initials for outgoing
                text TEXT, -- Text content (caption for media)
                mediaType TEXT, -- Baileys message type string or custom ('text', 'location', etc.)
                mimeType TEXT, -- Actual MIME type for media
                fileName TEXT, -- Original file name for media (for display)
                filePath TEXT, -- Path to media file on server (relative to media dir)
                snippet TEXT, -- Snippet untuk preview di daftar chat
                unread BOOLEAN DEFAULT 1, -- Untuk incoming messages (1=true, 0=false)

                FOREIGN KEY (chat_id) REFERENCES chat_history(chat_id) ON DELETE CASCADE
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS admins (
                username TEXT PRIMARY KEY,
                password TEXT, -- (PERTIMBANGKAN HASHING PASSWORD DI PRODUKSI!)
                initials TEXT,
                role TEXT -- e.g., 'admin', 'superadmin'
            )
        `);

        await db.exec(`
            CREATE TABLE IF NOT EXISTS quick_reply_templates (
                id TEXT PRIMARY KEY, -- Gunakan shortcut sebagai ID yang unik
                shortcut TEXT UNIQUE, -- Misalnya '/salam', harus unik
                text TEXT -- Isi template balasan cepat
            )
        `);

        console.log('[DATABASE] Skema database berhasil diinisialisasi/diverifikasi');
    } catch (error) {
        console.error('[DATABASE] Gagal menginisialisasi skema database:', error);
        throw error;
    }
}

// Fungsi-fungsi untuk operasi chat history & messages

/**
 * Menyimpan seluruh state chat history dan pesan dari memory ke database.
 * Strategi ini menghapus data yang ada di tabel chat_history dan messages,
 * lalu menulis ulang state dari memory. PERHATIAN: TIDAK efisien untuk data besar
 * atau konkurensi tinggi, tetapi cocok untuk state memory yang dikelola secara terpusat.
 * @param {Object} chatHistory - Objek chat history dari state memory { chatId: { status, messages: [] } }
 * @returns {Promise<void>}
 * @throws {Error} Jika transaksi database gagal.
 */
async function saveChatHistory(chatHistory) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua data yang ada
        // NOTE: Karena FOREIGN KEY ON DELETE CASCADE, menghapus dari chat_history
        // akan menghapus pesan terkait dari tabel messages SECARA OTOMATIS.
        // Kita tidak perlu menghapus dari messages secara terpisah di sini.
        await db.run('DELETE FROM chat_history');


        // Sesuaikan INSERT query untuk kolom filePath (dan hilangkan mediaData)
        const insertChatStmt = await db.prepare('INSERT INTO chat_history (chat_id, status, created_at) VALUES (?, ?, ?)');
        const insertMessageStmt = await db.prepare(
            'INSERT INTO messages (id, chat_id, timestamp, type, sender, initials, text, mediaType, mimeType, fileName, filePath, snippet, unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        for (const chatId in chatHistory) {
            if (!Object.prototype.hasOwnProperty.call(chatHistory, chatId)) continue;

            const chatData = chatHistory[chatId];

            if (!chatData || !Array.isArray(chatData.messages)) {
                console.warn(`[DATABASE] Data chat tidak valid atau array messages missing/invalid untuk chatId: ${chatId}. Melewati.`);
                continue;
            }

            const firstMessageTimestamp = chatData.messages.length > 0 ? new Date(chatData.messages[0].timestamp).toISOString() : new Date().toISOString();
             await insertChatStmt.run(
                 chatId,
                 chatData.status || 'open',
                 firstMessageTimestamp
             );

            for (const message of chatData.messages) {
                if (!message || typeof message !== 'object' || !message.id || !message.type) {
                    console.warn(`[DATABASE] Pesan tidak valid dalam chat ${chatId}:`, message, '. Melewati.');
                    continue;
                }

                 const dbSender = message.type === 'incoming' ? message.from : message.from;
                 const dbInitials = message.type === 'outgoing' ? message.initials : null;
                 const dbUnread = message.unread ? 1 : 0;
                 const dbTimestamp = message.timestamp ? Math.floor(new Date(message.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);


                await insertMessageStmt.run(
                    message.id,
                    chatId,
                    dbTimestamp,
                    message.type,
                    dbSender,
                    dbInitials,
                    message.text || null,
                    message.mediaType || null,
                    message.mimeType || null,
                    message.fileName || null,
                    message.filePath || null, // <-- Simpan filePath, bukan mediaData
                    message.snippet || null,
                    dbUnread
                );
            }
        }

        await insertChatStmt.finalize();
        await insertMessageStmt.finalize();

        await db.run('COMMIT');
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan chat history dan pesan ke database (ROLLBACK):', error);
        throw error;
    }
}


/**
 * Memuat chat history dari database ke objek state memory.
 * Membangun kembali objek state memory { chatId: { status, messages: [] } } dari tabel chat_history dan messages.
 * @async
 * @function loadChatHistory
 * @returns {Promise<Object>} - Objek chat history { chatId: { status: 'open'|'closed', messages: [...] } }
 * @throws {Error} Jika query database gagal.
 */
async function loadChatHistory() {
    const db = await getDb();

    try {
        const chatHistory = {};

        const chats = await db.all('SELECT chat_id, status FROM chat_history');

        // Sesuaikan SELECT query untuk filePath (dan hilangkan mediaData)
        const messagesStmt = await db.prepare('SELECT id, timestamp, type, sender, initials, text, mediaType, mimeType, fileName, filePath, snippet, unread FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');

        for (const chat of chats) {
            const messageRows = await messagesStmt.all(chat.chat_id);

            const messages = messageRows.map(row => {
                if (!row || typeof row !== 'object' || !row.id) {
                     console.warn('[DATABASE] Melewati baris pesan dengan data tidak lengkap saat memuat:', row);
                     return null;
                }

                return {
                    id: row.id,
                    chatId: chat.chat_id,
                    timestamp: row.timestamp ? new Date(parseInt(row.timestamp) * 1000).toISOString() : new Date().toISOString(),
                    type: row.type || 'unknown',
                    from: row.type === 'incoming' ? row.sender : row.initials || row.sender || 'Unknown Admin',
                    sender: row.sender || null,
                    initials: row.initials || null,
                    text: row.text || null,
                    mediaType: row.mediaType || null,
                    mimeType: row.mimeType || null,
                    fileName: row.fileName || null,
                    filePath: row.filePath || null, // <-- Muat filePath
                    mediaData: null, // <-- Tidak lagi memuat mediaData dari DB
                    snippet: row.snippet || null,
                    unread: row.unread === 1 ? true : false
                };
            }).filter(msg => msg !== null);

            chatHistory[chat.chat_id] = {
                status: chat.status || 'open',
                messages: messages
            };
        }

        await messagesStmt.finalize();
        return chatHistory;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat chat history dari database:', error);
        throw error; // Lempar error agar penanganan di backend tahu bahwa pemuatan gagal
    }
}


/**
 * Menghapus chat history dan pesan terkait berdasarkan chat ID dari database.
 * @async
 * @function deleteChatHistory
 * @param {string} chatId - ID chat yang akan dihapus
 * @returns {Promise<boolean>} - True jika berhasil menghapus setidaknya satu baris chat_history, false jika tidak.
 * @throws {Error} Jika transaksi database gagal.
 */
async function deleteChatHistory(chatId) {
    const db = await getDb();

    if (!chatId || typeof chatId !== 'string') {
        console.error('[DATABASE] deleteChatHistory: Chat ID tidak valid', chatId);
        return false;
    }

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus chat history. Karena FOREIGN KEY ON DELETE CASCADE di tabel 'messages',
        // pesan-pesan terkait akan otomatis terhapus.
        const result = await db.run('DELETE FROM chat_history WHERE chat_id = ?', [chatId]);

        await db.run('COMMIT');
        return result.changes > 0;
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(`[DATABASE] Gagal menghapus chat history untuk ${chatId} dari database (ROLLBACK):`, error);
        throw error;
    }
}

/**
 * Menghapus semua chat history dan pesan dari database.
 * @async
 * @function deleteAllChatHistory
 * @returns {Promise<boolean>} - True jika berhasil menghapus setidaknya satu baris chat_history, false jika tidak ada baris chat_history sebelumnya.
 * @throws {Error} Jika transaksi database gagal.
 */
async function deleteAllChatHistory() {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua pesan dari tabel messages.
        // Tidak perlu khawatir FOREIGN KEY di sini karena kita menghapus semua pesan.
        await db.run('DELETE FROM messages');

        // Hapus semua chat history.
        const result = await db.run('DELETE FROM chat_history');


        await db.run('COMMIT');
        console.log('[DATABASE] Semua chat history berhasil dihapus dari database');
        // Return true regardless of changes because the intent (clear tables) was successful
        // if no errors occurred. Checking result.changes might be misleading if tables were already empty.
        return true;
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menghapus semua chat history dari database (ROLLBACK):', error);
        throw error;
    }
}

// --- NEW FUNCTIONS TO GET FILE PATHS BEFORE DELETION ---

/**
 * Mengambil daftar filePath media dari pesan untuk chat ID tertentu.
 * Digunakan sebelum menghapus chat untuk membersihkan file di disk.
 * @async
 * @function getMediaFilePathsForChat
 * @param {string} chatId - ID chat.
 * @returns {Promise<string[]>} - Array string filePath. Mengembalikan array kosong jika tidak ada file atau error.
 */
async function getMediaFilePathsForChat(chatId) {
    const db = await getDb().catch(() => null);
    if (!db) {
        console.error('[DATABASE] getMediaFilePathsForChat: Gagal mendapatkan koneksi DB.');
        return [];
    }
    try {
        // Select filePath for messages in this chat that have a filePath stored AND is not an empty string
        // Using `AND filePath IS NOT NULL` is good, adding `AND filePath != ''` is extra safe.
        const rows = await db.all('SELECT filePath FROM messages WHERE chat_id = ? AND filePath IS NOT NULL AND filePath != ""', [chatId]);
        return rows.map(row => row.filePath).filter(Boolean); // Ensure only valid, non-empty paths are returned
    } catch (error) {
        console.error(`[DATABASE] Gagal mengambil filePaths untuk chat ${chatId}:`, error);
        return []; // Return empty array on error
    }
}

/**
 * Mengambil daftar semua filePath media dari semua pesan.
 * Digunakan sebelum menghapus semua chat untuk membersihkan semua file di disk.
 * @async
 * @function getAllMediaFilePaths
 * @returns {Promise<string[]>} - Array string filePath. Mengembalikan array kosong jika tidak ada file atau error.
 */
async function getAllMediaFilePaths() {
    const db = await getDb().catch(() => null);
    if (!db) {
        console.error('[DATABASE] getAllMediaFilePaths: Gagal mendapatkan koneksi DB.');
        return [];
    }
    try {
        // Select all filePath values that are not NULL or empty string
        const rows = await db.all('SELECT filePath FROM messages WHERE filePath IS NOT NULL AND filePath != ""');
        return rows.map(row => row.filePath).filter(Boolean); // Ensure only valid, non-empty paths are returned
    } catch (error) {
        console.error('[DATABASE] Gagal mengambil semua filePaths:', error);
        return []; // Return empty array on error
    }
}

// --- Fungsi-fungsi Admin & Quick Reply (Tidak Berubah Sehubungan Perubahan Media) ---
// (Sertakan kembali kode saveAdmins, loadAdmins, saveQuickReplyTemplates, loadQuickReplyTemplates dari database.js asli Anda di sini)
/**
 * Menyimpan data admin ke database.
 * Menghapus semua admin yang ada di tabel admins, lalu menulis ulang dari objek state memory.
 * @async
 * @function saveAdmins
 * @param {Object} admins - Objek admin { username: { password, initials, role } }
 * @returns {Promise<void>}
 * @throws {Error} Jika transaksi database gagal.
 */
async function saveAdmins(admins) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua admin yang ada untuk melakukan write-ulang
        await db.run('DELETE FROM admins');

        const insertStmt = await db.prepare('INSERT INTO admins (username, password, initials, role) VALUES (?, ?, ?, ?)');

        // Tambahkan admin baru dari objek state memory
        for (const username in admins) {
            if (!Object.prototype.hasOwnProperty.call(admins, username)) continue;

            const admin = admins[username];
             // Validasi dasar struktur data admin
             if (!admin || typeof admin !== 'object' || !admin.password || !admin.initials || !admin.role) {
                 console.warn(`[DATABASE] Melewati admin dengan data tidak lengkap saat menyimpan: ${username}. Data:`, admin);
                 continue; // Lewati admin yang tidak valid
            }

            await insertStmt.run(
                username,
                admin.password, // PERTIMBANGKAN HASHING PASSWORD!
                admin.initials,
                admin.role
            );
        }

        await insertStmt.finalize();
        await db.run('COMMIT');
        console.log('[DATABASE] Data admin berhasil disimpan ke database'); // Log sukses
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan data admin ke database (ROLLBACK):', error);
        throw error; // Lempar error
    }
}

/**
 * Memuat data admin dari database ke objek state memory.
 * @async
 * @function loadAdmins
 * @returns {Promise<Object>} - Objek admin { username: { password, initials, role } }. Mengembalikan objek kosong jika tidak ada admin.
 * @throws {Error} Jika query database gagal.
 */
async function loadAdmins() {
    const db = await getDb();

    try {
        const admins = {};

        // Ambil semua admin dari tabel admins
        const adminRows = await db.all('SELECT username, password, initials, role FROM admins');

        for (const admin of adminRows) {
             // Validasi dasar struktur data admin yang dimuat
             if (!admin || typeof admin !== 'object' || !admin.username || !admin.password || !admin.initials || !admin.role) {
                  console.warn('[DATABASE] Melewati baris admin dengan data tidak lengkap saat memuat:', admin);
                  continue; // Lewati baris yang tidak valid
             }
            admins[admin.username] = {
                password: admin.password,
                initials: admin.initials,
                role: admin.role
            };
        }

        // console.log(`[DATABASE] Data admin berhasil dimuat dari database. Total admin: ${Object.keys(admins).length}`); // Log di backend.js
        return admins; // Kembalikan objek (mungkin kosong)
    } catch (error) {
        console.error('[DATABASE] Gagal memuat data admin dari database:', error);
        // Jangan lempar error di sini, kembalikan objek kosong atau tangani di pemanggil
        return {};
    }
}

/**
 * Menyimpan template balasan cepat ke database.
 * Menghapus semua template yang ada di tabel quick_reply_templates, lalu menulis ulang dari objek state memory.
 * @async
 * @function saveQuickReplyTemplates
 * @param {Object} templates - Objek template { shortcut: { id, shortcut, text } }
 * @returns {Promise<void>}
 * @throws {Error} Jika transaksi database gagal.
 */
async function saveQuickReplyTemplates(templates) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua template yang ada untuk melakukan write-ulang
        await db.run('DELETE FROM quick_reply_templates');

        const insertStmt = await db.prepare('INSERT INTO quick_reply_templates (id, shortcut, text) VALUES (?, ?, ?)');

        // Tambahkan template baru dari objek state memory
        for (const shortcut in templates) {
            if (!Object.prototype.hasOwnProperty.call(templates, shortcut)) continue;

            const template = templates[shortcut];
             // Validasi dasar struktur data template
             if (!template || typeof template !== 'object' || !template.id || !template.shortcut || !template.text) {
                 console.warn(`[DATABASE] Melewati template dengan data tidak lengkap saat menyimpan: ${shortcut}. Data:`, template);
                 continue; // Lewati template yang tidak valid
            }

            await insertStmt.run(
                template.id,
                template.shortcut,
                template.text
            );
        }

        await insertStmt.finalize();
        await db.run('COMMIT');
        console.log('[DATABASE] Quick reply templates berhasil disimpan ke database'); // Log sukses
        // TIDAK ADA LOGIKA IO.EMIT DI SINI. EMIT DILAKUKAN DI BACKEND.JS.
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan quick reply templates ke database (ROLLBACK):', error);
        throw error; // Lempar error
    }
}

/**
 * Memuat template balasan cepat dari database ke objek state memory.
 * @async
 * @function loadQuickReplyTemplates
 * @returns {Promise<Object>} - Objek template { shortcut: { id, shortcut, text } }. Mengembalikan objek kosong jika tidak ada template.
 * @throws {Error} Jika query database gagal.
 */
async function loadQuickReplyTemplates() {
    const db = await getDb();

    try {
        const templates = {};

        // Ambil semua template dari tabel quick_reply_templates
        const templateRows = await db.all('SELECT id, shortcut, text FROM quick_reply_templates');

        for (const template of templateRows) {
             // Validasi dasar struktur data template yang dimuat
             if (!template || typeof template !== 'object' || !template.id || !template.shortcut || !template.text) {
                  console.warn('[DATABASE] Melewati baris template dengan data tidak lengkap saat memuat:', template);
                 continue; // Lewati baris yang tidak valid
            }
            templates[template.shortcut] = { // Gunakan shortcut sebagai kunci objek state
                id: template.id,
                shortcut: template.shortcut,
                text: template.text
            };
        }

        // console.log(`[DATABASE] Quick reply templates berhasil dimuat dari database. Total template: ${Object.keys(templates).length}`); // Log di backend.js
        return templates; // Kembalikan objek (mungkin kosong)
    } catch (error) {
        console.error('[DATABASE] Gagal memuat quick reply templates dari database:', error);
        // Jangan lempar error di sini, kembalikan objek kosong atau tangani di pemanggil
        return {};
    }
}


// Ekspor fungsi-fungsi yang akan digunakan di backend
export {
    initDatabase,
    closeDatabase,
    saveChatHistory,
    loadChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins,
    loadAdmins,
    saveQuickReplyTemplates,
    loadQuickReplyTemplates,
    getDb, // Ini tetap diekspor karena digunakan di backend.js
    getMediaFilePathsForChat, // <-- Export fungsi baru
    getAllMediaFilePaths // <-- Export fungsi baru
};