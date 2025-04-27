// database.js

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pastikan direktori database ada
const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
    console.log(`[DATABASE] Membuat direktori database: ${dbDir}`);
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'helpdesk.db');

// Singleton untuk koneksi database
let dbInstance = null;

/**
 * Mendapatkan koneksi database SQLite
 * @returns {Promise<import('sqlite').Database>}
 */
async function getDb() {
    // Jika instance sudah ada dan belum tertutup (dengan better-sqlite3 bisa cek .closed),
    // gunakan instance yang ada. Dengan sqlite/sqlite3, kita asumsikan jika instance ada,
    // itu masih valid, atau error akan muncul saat menjalankan query.
    if (dbInstance) {
        return dbInstance;
    }

    try {
        console.log(`[DATABASE] Membuka database: ${dbPath}`);
        dbInstance = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });

        // Aktifkan FOREIGN KEY constraints (baik untuk integritas data)
        // Ini harus dipanggil setiap kali koneksi baru dibuka
        await dbInstance.exec('PRAGMA foreign_keys = ON;');
        console.log('[DATABASE] FOREIGN KEY constraints diaktifkan.');

        console.log('[DATABASE] Koneksi SQLite berhasil dibuat');
        return dbInstance;
    } catch (error) {
        console.error('[DATABASE] Gagal membuat koneksi SQLite:', error);
        dbInstance = null; // Reset instance jika gagal
        throw error; // Lempar kembali error fatal agar backend tahu ada masalah fatal
    }
}

/**
 * Menutup koneksi database SQLite
 * @returns {Promise<void>}
 */
async function closeDatabase() {
    // Periksa apakah instance dbInstance ada sebelum mencoba menutup
    if (dbInstance) {
        console.log('[DATABASE] Menutup koneksi database...'); // Log hanya jika ada instance untuk ditutup
        try {
            // Metode .close() dari library sqlite (pembungkus sqlite3)
            await dbInstance.close();
            console.log('[DATABASE] Koneksi database ditutup.'); // Log sukses di sini
        } catch (error) {
             console.error('[DATABASE] Gagal menutup koneksi database:', error);
             // Log error tapi jangan lempar agar shutdown berlanjut
        } finally {
            dbInstance = null; // Selalu reset instance setelah percobaan tutup
        }
    } else {
         // console.log('[DATABASE] Koneksi database sudah tertutup atau tidak ada instance.'); // Opsional: log jika tidak ada yang perlu ditutup
    }
}


/**
 * Inisialisasi skema database
 */
async function initDatabase() {
    // Dapatkan atau buat instance database terlebih dahulu
    const db = await getDb();

    try {
        // Buat tabel untuk chat history
        await db.exec(`
            CREATE TABLE IF NOT EXISTS chat_history (
                chat_id TEXT PRIMARY KEY,
                status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Buat tabel untuk pesan
        // Menggunakan skema yang diperbarui
        await db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT,
                timestamp INTEGER,
                type TEXT, -- e.g., 'incoming', 'outgoing'
                sender TEXT, -- customer JID for incoming, admin username for outgoing
                initials TEXT, -- admin initials for outgoing
                text TEXT, -- Text content (caption for media)
                mediaType TEXT, -- Baileys message type string or custom ('text', 'location', etc.)
                mimeType TEXT, -- Actual MIME type for media
                fileName TEXT, -- Original file name for media
                mediaData TEXT, -- Base64 string for media (WARNING: INEFFICIENT for large data)
                snippet TEXT, -- Snippet for chat list preview
                unread BOOLEAN DEFAULT 1, -- For incoming messages (1=true, 0=false)
                FOREIGN KEY (chat_id) REFERENCES chat_history(chat_id) ON DELETE CASCADE
            )
        `);

        // Buat tabel untuk admin
        await db.exec(`
            CREATE TABLE IF NOT EXISTS admins (
                username TEXT PRIMARY KEY,
                password TEXT,
                initials TEXT,
                role TEXT
            )
        `);

        // Buat tabel untuk template balasan cepat
        await db.exec(`
            CREATE TABLE IF NOT EXISTS quick_reply_templates (
                id TEXT PRIMARY KEY, -- Gunakan shortcut sebagai ID
                shortcut TEXT UNIQUE,
                text TEXT
            )
        `);

        console.log('[DATABASE] Skema database berhasil diinisialisasi/diverifikasi');
    } catch (error) {
        console.error('[DATABASE] Gagal menginisialisasi skema database:', error);
        throw error; // Lempar kembali error fatal saat startup
    }
}

// Fungsi-fungsi untuk operasi chat history & messages

/**
 * Menyimpan chat history dan pesan ke database.
 * Ini akan menghapus data yang ada di DB dan menulis ulang state chatHistory dari memory.
 * PERHATIAN: Strategi ini TIDAK efisien untuk aplikasi besar atau konkurensi tinggi.
 * @param {Object} chatHistory - Objek chat history dari state memory
 */
async function saveChatHistory(chatHistory) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus *semua* data chat history dan pesan untuk sinkronisasi total dari memory state
        // Ini adalah pendekatan sederhana tapi tidak optimal
        await db.run('DELETE FROM chat_history');
        // Menghapus dari chat_history seharusnya memicu DELETE CASCADE pada messages
        // await db.run('DELETE FROM messages'); // Baris ini mungkin tidak lagi perlu jika FOREIGN KEY ON DELETE CASCADE berfungsi

        // Mempersiapkan statement INSERT untuk efisiensi
        const insertChatStmt = await db.prepare('INSERT INTO chat_history (chat_id, status) VALUES (?, ?)');
        const insertMessageStmt = await db.prepare(
            'INSERT INTO messages (id, chat_id, timestamp, type, sender, initials, text, mediaType, mimeType, fileName, mediaData, snippet, unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        for (const chatId in chatHistory) { // Gunakan chatId langsung
            if (!Object.prototype.hasOwnProperty.call(chatHistory, chatId)) continue;

            const chatData = chatHistory[chatId];

            // Pastikan chatData dan chatData.messages valid
            if (!chatData || !Array.isArray(chatData.messages)) {
                 console.warn(`[DATABASE] Data chat tidak valid untuk menyimpan chatId: ${chatId}`);
                 continue; // Lewati chat yang datanya rusak
            }

            // Tambahkan chat baru
            await insertChatStmt.run(
                chatId,
                chatData.status || 'open'
            );

            // Tambahkan pesan-pesan baru
            for (const message of chatData.messages) {
                // Pastikan objek pesan valid dan memiliki ID
                if (!message || !message.id || typeof message.id !== 'string') {
                     console.warn(`[DATABASE] Pesan tidak valid untuk menyimpan di chatId ${chatId}:`, message);
                     continue; // Lewati pesan yang rusak
                }

                await insertMessageStmt.run(
                    message.id,
                    chatId, // Gunakan chatId yang sudah dinormalisasi
                    message.timestamp ? Math.floor(new Date(message.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000), // Simpan timestamp sebagai INTEGER (Unix timestamp)
                    message.type || 'unknown',
                    // sender: gunakan JID untuk incoming, username admin untuk outgoing
                    message.type === 'incoming' ? message.from : message.from,
                    message.initials || null, // admin initials (null for incoming)
                    message.text || null,
                    message.mediaType || null,
                    message.mimeType || null,
                    message.fileName || null,
                    message.mediaData || null, // WARNING: Storing large media as Base64 is INEFFICIENT
                    message.snippet || (message.text ? message.text.substring(0, 50) + '...' : null), // Generate snippet if not present
                    message.unread ? 1 : 0 // Simpan boolean sebagai INTEGER 1 atau 0
                );
            }
        }

        // Finalisasi prepared statements
        await insertChatStmt.finalize();
        await insertMessageStmt.finalize();

        await db.run('COMMIT');
        // console.log('[DATABASE] Chat history dan pesan berhasil disimpan ke database'); // Verbose log disabled in backend.js
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan chat history dan pesan ke database:', error);
        // Jangan lempar error agar aplikasi tidak crash hanya karena gagal save
    }
}


/**
 * Memuat chat history dari database
 * Membangun kembali objek state memory dari data chat_history dan messages.
 * @returns {Promise<Object>} - Objek chat history { chatId: { status, messages: [] } }
 */
async function loadChatHistory() {
    const db = await getDb();

    try {
        const chatHistory = {};

        // Ambil semua chat dari tabel chat_history
        const chats = await db.all('SELECT chat_id, status FROM chat_history');

        // Siapkan prepared statement untuk mengambil pesan per chat
        // Ambil semua kolom yang relevan dari tabel messages
        const messagesStmt = await db.prepare('SELECT id, timestamp, type, sender, initials, text, mediaType, mimeType, fileName, mediaData, snippet, unread FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');

        for (const chat of chats) {
            // Ambil pesan-pesan untuk chat ini menggunakan prepared statement
            const messageRows = await messagesStmt.all(chat.chat_id);

            // Rekonstruksi objek pesan dari baris database
            const messages = messageRows.map(row => ({
                id: row.id,
                chatId: chat.chat_id, // Tambahkan chatId ke objek pesan
                timestamp: new Date(row.timestamp * 1000).toISOString(), // Konversi Unix timestamp ke ISO string
                type: row.type,
                // 'from' di objek pesan di memory state digunakan untuk menampilkan siapa pengirim di UI
                // Untuk incoming, pengirimnya adalah customer (sender kolom DB). Untuk outgoing, pengirimnya adalah admin (initials kolom DB).
                from: row.type === 'incoming' ? row.sender : row.initials || row.sender, // Gunakan sender/initials sesuai type
                sender: row.sender, // Simpan sender asli dari DB juga
                initials: row.initials, // Simpan initials asli dari DB juga
                text: row.text,
                mediaType: row.mediaType,
                mimeType: row.mimeType,
                fileName: row.fileName,
                mediaData: row.mediaData, // WARNING: Base64 data loaded here can be huge
                snippet: row.snippet,
                unread: row.unread === 1 ? true : false // Konversi INTEGER ke Boolean
            }));

            chatHistory[chat.chat_id] = {
                status: chat.status || 'open', // Default status open
                messages: messages
            };
        }

        // Finalisasi prepared statement
        await messagesStmt.finalize();

        console.log(`[DATABASE] Chat history berhasil dimuat dari database. Total chat: ${Object.keys(chatHistory).length}`);
        return chatHistory;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat chat history dari database:', error);
        // Error SQLITE_ERROR di sini menandakan skema DB tidak cocok
        // Jika ini terjadi saat startup, aplikasi mungkin tidak bisa jalan dengan benar
        throw error; // Lempar kembali error agar backend tahu ada masalah fatal
    }
}


/**
 * Menghapus chat history dan pesan terkait berdasarkan chat ID
 * @param {string} chatId - ID chat yang akan dihapus
 * @returns {Promise<boolean>} - True jika berhasil, false jika gagal
 */
async function deleteChatHistory(chatId) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus chat history. Karena FOREIGN KEY ON DELETE CASCADE,
        // pesan-pesan terkait di tabel 'messages' akan otomatis terhapus.
        await db.run('DELETE FROM chat_history WHERE chat_id = ?', [chatId]);

        await db.run('COMMIT');
        console.log(`[DATABASE] Chat history untuk ${chatId} berhasil dihapus dari database`);
        return true;
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(`[DATABASE] Gagal menghapus chat history untuk ${chatId} dari database:`, error);
        return false;
    }
}

/**
 * Menghapus semua chat history dan pesan
 * @returns {Promise<boolean>} - True jika berhasil, false jika gagal
 */
async function deleteAllChatHistory() {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua pesan
        await db.run('DELETE FROM messages');

        // Hapus semua chat history
        await db.run('DELETE FROM chat_history');

        await db.run('COMMIT');
        console.log('[DATABASE] Semua chat history berhasil dihapus dari database');
        return true;
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menghapus semua chat history dari database:', error);
        return false;
    }
}

// Fungsi-fungsi untuk operasi admin

/**
 * Menyimpan data admin ke database.
 * Menghapus semua admin dan menulis ulang dari state memory.
 * @param {Object} admins - Objek admin { username: { password, initials, role } }
 */
async function saveAdmins(admins) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua admin yang ada
        await db.run('DELETE FROM admins');

        const insertStmt = await db.prepare('INSERT INTO admins (username, password, initials, role) VALUES (?, ?, ?, ?)');

        // Tambahkan admin baru
        for (const username in admins) {
            if (!Object.prototype.hasOwnProperty.call(admins, username)) continue;

            const admin = admins[username];
            if (!admin || !admin.password || !admin.initials || !admin.role) {
                 console.warn(`[DATABASE] Melewati admin dengan data tidak lengkap saat menyimpan: ${username}`);
                 continue;
            }

            await insertStmt.run(
                username,
                admin.password,
                admin.initials,
                admin.role
            );
        }

        await insertStmt.finalize();
        await db.run('COMMIT');
        console.log('[DATABASE] Data admin berhasil disimpan ke database');
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan data admin ke database:', error);
        // Jangan lempar error
    }
}

/**
 * Memuat data admin dari database
 * @returns {Promise<Object>} - Objek admin { username: { password, initials, role } }
 */
async function loadAdmins() {
    const db = await getDb();

    try {
        const admins = {};

        // Ambil semua admin
        const adminRows = await db.all('SELECT username, password, initials, role FROM admins');

        for (const admin of adminRows) {
             if (!admin || !admin.username || !admin.password || !admin.initials || !admin.role) {
                 console.warn('[DATABASE] Melewati baris admin dengan data tidak lengkap saat memuat:', admin);
                 continue;
             }
            admins[admin.username] = {
                password: admin.password,
                initials: admin.initials,
                role: admin.role
            };
        }

        console.log(`[DATABASE] Data admin berhasil dimuat dari database. Total admin: ${Object.keys(admins).length}`);
        return admins;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat data admin dari database:', error);
        return {}; // Kembalikan objek kosong jika gagal
    }
}

// Fungsi-fungsi untuk operasi template balasan cepat

/**
 * Menyimpan template balasan cepat ke database.
 * Menghapus semua template dan menulis ulang dari state memory.
 * @param {Object} templates - Objek template { shortcut: { id, shortcut, text } }
 */
async function saveQuickReplyTemplates(templates) {
    const db = await getDb();

    try {
        await db.run('BEGIN TRANSACTION');

        // Hapus semua template
        await db.run('DELETE FROM quick_reply_templates');

        const insertStmt = await db.prepare('INSERT INTO quick_reply_templates (id, shortcut, text) VALUES (?, ?, ?)');

        // Tambahkan template baru
        for (const shortcut in templates) {
            if (!Object.prototype.hasOwnProperty.call(templates, shortcut)) continue;

            const template = templates[shortcut];
             if (!template || !template.id || !template.shortcut || !template.text) {
                 console.warn(`[DATABASE] Melewati template dengan data tidak lengkap saat menyimpan: ${shortcut}`);
                 continue;
            }

            await insertStmt.run(
                template.id,
                template.shortcut,
                template.text
            );
        }

        await insertStmt.finalize();
        await db.run('COMMIT');
        console.log('[DATABASE] Quick reply templates berhasil disimpan ke database');
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan quick reply templates ke database:', error);
        // Jangan lempar error
    }
}

/**
 * Memuat template balasan cepat dari database
 * @returns {Promise<Object>} - Objek template { shortcut: { id, shortcut, text } }
 */
async function loadQuickReplyTemplates() {
    const db = await getDb();

    try {
        const templates = {};

        // Ambil semua template
        const templateRows = await db.all('SELECT id, shortcut, text FROM quick_reply_templates');

        for (const template of templateRows) {
             if (!template || !template.id || !template.shortcut || !template.text) {
                  console.warn('[DATABASE] Melewati baris template dengan data tidak lengkap saat memuat:', template);
                 continue;
            }
            templates[template.shortcut] = {
                id: template.id,
                shortcut: template.shortcut,
                text: template.text
            };
        }

        console.log(`[DATABASE] Quick reply templates berhasil dimuat dari database. Total template: ${Object.keys(templates).length}`);
        return templates;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat quick reply templates dari database:', error);
        return {}; // Kembalikan objek kosong jika gagal
    }
}

export {
    getDb, // Mungkin tidak perlu diekspor jika hanya digunakan internal
    initDatabase,
    closeDatabase, // <-- EKSPOR FUNGSI closeDatabase
    saveChatHistory,
    loadChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins,
    loadAdmins,
    saveQuickReplyTemplates,
    loadQuickReplyTemplates
};