// database.js

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Mendapatkan __dirname yang setara di ES Modules
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
// Menggunakan 'let' karena instance akan di-reassign saat pertama kali dibuat dan saat ditutup
let dbInstance = null;

/**
 * Mendapatkan koneksi database SQLite. Menggunakan pola singleton.
 * Jika koneksi belum ada, akan dibuat dan disimpan.
 * @returns {Promise<import('sqlite').Database>} Instance koneksi database.
 * @throws {Error} Jika gagal membuat koneksi database.
 */
export async function getDb() {
    // Jika instance sudah ada, kembalikan instance yang ada.
    // Dengan sqlite/sqlite3, kita asumsikan jika instance ada, itu masih valid,
    // atau error akan muncul saat menjalankan query.
    if (dbInstance) {
        return dbInstance;
    }

    try {
        console.log(`[DATABASE] Membuka database: ${dbPath}`);
        // Menggunakan library 'sqlite' sebagai pembungkus 'sqlite3' untuk Promise API
        dbInstance = await open({
            filename: dbPath,
            driver: sqlite3.Database // Gunakan driver sqlite3
        });

        // Aktifkan FOREIGN KEY constraints (baik untuk integritas data)
        // Ini harus dipanggil setiap kali koneksi baru dibuka
        await dbInstance.exec('PRAGMA foreign_keys = ON;');
        console.log('[DATABASE] FOREIGN KEY constraints diaktifkan.');

        console.log('[DATABASE] Koneksi SQLite berhasil dibuat');
        return dbInstance;
    } catch (error) {
        console.error('[DATABASE] Gagal membuat koneksi SQLite:', error);
        dbInstance = null; // Reset instance jika gagal agar percobaan berikutnya membuat koneksi baru
        throw error; // Lempar kembali error fatal agar backend tahu ada masalah fatal saat startup
    }
}

/**
 * Menutup koneksi database SQLite.
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
 * Inisialisasi skema database (membuat tabel jika belum ada).
 * Fungsi ini aman dipanggil berulang kali.
 * @async
 * @function initDatabase
 * @returns {Promise<void>}
 * @throws {Error} Jika gagal mengeksekusi perintah SQL untuk membuat tabel.
 */
async function initDatabase() {
    // Dapatkan atau buat instance database terlebih dahulu
    const db = await getDb();

    try {
        // Buat tabel untuk chat history
        await db.exec(`
            CREATE TABLE IF NOT EXISTS chat_history (
                chat_id TEXT PRIMARY KEY,
                status TEXT DEFAULT 'open', -- e.g., 'open', 'closed'
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Buat tabel untuk pesan
        // Menggunakan skema yang diperbarui sesuai diskusi
        await db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY, -- Message ID dari Baileys
                chat_id TEXT, -- FOREIGN KEY ke chat_history
                timestamp INTEGER, -- Unix timestamp (detik)
                type TEXT, -- e.g., 'incoming', 'outgoing'
                sender TEXT, -- customer JID for incoming, admin username for outgoing (ini yang di DB)
                initials TEXT, -- admin initials for outgoing
                text TEXT, -- Text content (caption for media)
                mediaType TEXT, -- Baileys message type string or custom ('text', 'location', etc.)
                mimeType TEXT, -- Actual MIME type for media
                fileName TEXT, -- Original file name for media
                mediaData TEXT, -- Base64 string for media (WARNING: INEFFICIENT for large data, pertimbangkan penyimpanan file)
                snippet TEXT, -- Snippet untuk preview di daftar chat
                unread BOOLEAN DEFAULT 1, -- Untuk incoming messages (1=true, 0=false)

                -- Definisi Foreign Key constraint
                FOREIGN KEY (chat_id) REFERENCES chat_history(chat_id) ON DELETE CASCADE
            )
        `);

        // Buat tabel untuk admin
        await db.exec(`
            CREATE TABLE IF NOT EXISTS admins (
                username TEXT PRIMARY KEY,
                password TEXT, -- (PERTIMBANGKAN HASHING PASSWORD DI PRODUKSI!)
                initials TEXT,
                role TEXT -- e.g., 'admin', 'superadmin'
            )
        `);

        // Buat tabel untuk template balasan cepat
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
        // Lempar kembali error fatal saat startup
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

        // Hapus semua data yang ada untuk melakukan write-ulang
        // Karena FOREIGN KEY ON DELETE CASCADE, menghapus dari chat_history akan menghapus pesan terkait.
        await db.run('DELETE FROM chat_history');
        // Opsional: Hapus pesan secara terpisah jika ingin memastikan, tapi cascade harusnya cukup.
        // await db.run('DELETE FROM messages');


        // Persiapkan statement untuk operasi INSERT baru
        const insertChatStmt = await db.prepare('INSERT INTO chat_history (chat_id, status, created_at) VALUES (?, ?, ?)');
        const insertMessageStmt = await db.prepare(
            'INSERT INTO messages (id, chat_id, timestamp, type, sender, initials, text, mediaType, mimeType, fileName, mediaData, snippet, unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        // Iterasi melalui state chatHistory di memory
        for (const chatId in chatHistory) {
            // Pastikan properti adalah milik objek itu sendiri, bukan dari prototype chain
            if (!Object.prototype.hasOwnProperty.call(chatHistory, chatId)) continue;

            const chatData = chatHistory[chatId];

            // Validasi dasar struktur data chat
            if (!chatData || !Array.isArray(chatData.messages)) {
                console.warn(`[DATABASE] Data chat tidak valid atau array messages missing/invalid untuk chatId: ${chatId}. Melewati.`);
                continue;
            }

            // Tambahkan chat baru ke tabel chat_history
             // Ambil created_at dari pesan pertama jika ada, atau gunakan waktu saat ini sebagai fallback
            const firstMessageTimestamp = chatData.messages.length > 0 ? new Date(chatData.messages[0].timestamp).toISOString() : new Date().toISOString();
             await insertChatStmt.run(
                 chatId,
                 chatData.status || 'open', // Default status 'open'
                 firstMessageTimestamp // Gunakan timestamp pesan pertama atau waktu saat ini
             );

            // Tambahkan pesan-pesan untuk chat ini ke tabel messages
            for (const message of chatData.messages) {
                // Validasi dasar struktur data pesan
                if (!message || typeof message !== 'object' || !message.id || !message.type) {
                    console.warn(`[DATABASE] Pesan tidak valid dalam chat ${chatId}:`, message, '. Melewati.');
                    continue;
                }

                 // Sesuaikan data pesan dari state memory agar sesuai dengan skema DB
                 // 'sender' di DB adalah JID pengirim untuk incoming, username admin untuk outgoing
                 // 'from' di memory state bisa jadi JID atau username admin.
                 // 'initials' di DB hanya untuk pesan outgoing.
                 const dbSender = message.type === 'incoming' ? message.from : message.from; // message.from di memory state untuk outgoing adalah username admin
                 const dbInitials = message.type === 'outgoing' ? message.initials : null;

                 // Pastikan unread adalah 0 atau 1
                 const dbUnread = message.unread ? 1 : 0;

                 // Konversi timestamp ISO string ke Unix timestamp (detik)
                 const dbTimestamp = message.timestamp ? Math.floor(new Date(message.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);


                await insertMessageStmt.run(
                    message.id,
                    chatId,
                    dbTimestamp,
                    message.type,
                    dbSender,
                    dbInitials,
                    message.text || null, // Simpan null jika teks kosong
                    message.mediaType || null,
                    message.mimeType || null,
                    message.fileName || null,
                    message.mediaData || null, // WARNING: Base64 data
                    message.snippet || null, // Simpan null jika snippet kosong
                    dbUnread
                );
            }
        }

        // Finalisasi prepared statements
        await insertChatStmt.finalize();
        await insertMessageStmt.finalize();

        await db.run('COMMIT');
        // console.log('[DATABASE] Chat history dan pesan berhasil disimpan ke database'); // Log sukses
    } catch (error) {
        // Rollback transaksi jika ada error selama proses
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan chat history dan pesan ke database (ROLLBACK):', error);
        // Lempar kembali error agar pemanggil tahu transaksi gagal
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

        // Ambil semua chat dari tabel chat_history
        const chats = await db.all('SELECT chat_id, status FROM chat_history');

        // Siapkan prepared statement untuk mengambil pesan per chat, diurutkan berdasarkan timestamp
        // Ambil semua kolom yang relevan dari tabel messages
        const messagesStmt = await db.prepare('SELECT id, timestamp, type, sender, initials, text, mediaType, mimeType, fileName, mediaData, snippet, unread FROM messages WHERE chat_id = ? ORDER BY timestamp ASC');

        for (const chat of chats) {
            // Ambil pesan-pesan untuk chat ini menggunakan prepared statement
            const messageRows = await messagesStmt.all(chat.chat_id);

            // Rekonstruksi objek pesan dari baris database
            const messages = messageRows.map(row => {
                // Pastikan row adalah objek yang valid
                if (!row || typeof row !== 'object' || !row.id) {
                     console.warn('[DATABASE] Melewati baris pesan dengan data tidak lengkap saat memuat:', row);
                     return null; // Lewati baris yang tidak valid
                }

                return {
                    id: row.id,
                    chatId: chat.chat_id, // Tambahkan chatId ke objek pesan
                    timestamp: row.timestamp ? new Date(parseInt(row.timestamp) * 1000).toISOString() : new Date().toISOString(), // Konversi Unix timestamp ke ISO string
                    type: row.type || 'unknown', // Default type jika null
                    // 'from' di objek pesan di memory state digunakan untuk menampilkan siapa pengirim di UI
                    // Untuk incoming, pengirimnya adalah customer (sender kolom DB). Untuk outgoing, pengirimnya adalah admin (initials kolom DB).
                    // Jika initials null (misal admin pertama belum set), fallback ke sender (yang harusnya username admin).
                    from: row.type === 'incoming' ? row.sender : row.initials || row.sender || 'Unknown Admin', // Gunakan sender/initials sesuai type
                    sender: row.sender || null, // Simpan sender asli dari DB juga
                    initials: row.initials || null, // Simpan initials asli dari DB juga
                    text: row.text || null, // Simpan null jika teks kosong di DB
                    mediaType: row.mediaType || null,
                    mimeType: row.mimeType || null,
                    fileName: row.fileName || null,
                    mediaData: row.mediaData || null, // WARNING: Base64 data loaded here can be huge
                    snippet: row.snippet || null, // Simpan null jika snippet kosong di DB
                    unread: row.unread === 1 ? true : false // Konversi INTEGER ke Boolean
                };
            }).filter(msg => msg !== null); // Filter pesan yang mungkin null karena data tidak valid

            chatHistory[chat.chat_id] = {
                status: chat.status || 'open', // Default status open jika null
                messages: messages
            };
        }

        // Finalisasi prepared statement
        await messagesStmt.finalize();

        // console.log(`[DATABASE] Chat history berhasil dimuat dari database. Total chat: ${Object.keys(chatHistory).length}`); // Log ini ada di backend.js
        return chatHistory;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat chat history dari database:', error);
        // Error SQLITE_ERROR di sini menandakan skema DB tidak cocok atau error DB lainnya
        // Jika ini terjadi saat startup, aplikasi mungkin tidak bisa jalan dengan benar
        throw error; // Lempar kembali error agar backend tahu ada masalah fatal
    }
}


/**
 * Menghapus chat history dan pesan terkait berdasarkan chat ID dari database.
 * @async
 * @function deleteChatHistory
 * @param {string} chatId - ID chat yang akan dihapus
 * @returns {Promise<boolean>} - True jika berhasil, false jika gagal.
 * @throws {Error} Jika transaksi database gagal.
 */
async function deleteChatHistory(chatId) {
    const db = await getDb();

    // Validasi input chatId
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
        // console.log(`[DATABASE] Chat history untuk ${chatId} berhasil dihapus dari database`); // Log sukses di backend.js
        return result.changes > 0; // Mengembalikan true jika setidaknya satu baris terpengaruh (chat_id ditemukan)
    } catch (error) {
        await db.run('ROLLBACK');
        console.error(`[DATABASE] Gagal menghapus chat history untuk ${chatId} dari database (ROLLBACK):`, error);
        throw error; // Lempar error agar pemanggil tahu ada masalah
    }
}

/**
 * Menghapus semua chat history dan pesan dari database.
 * @async
 * @function deleteAllChatHistory
 * @returns {Promise<boolean>} - True jika berhasil, false jika gagal.
 * @throws {Error} Jika transaksi database gagal.
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
        console.log('[DATABASE] Semua chat history berhasil dihapus dari database'); // Log sukses
        return true;
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menghapus semua chat history dari database (ROLLBACK):', error);
        throw error; // Lempar error
    }
}

// Fungsi-fungsi untuk operasi admin

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

// Fungsi-fungsi untuk operasi template balasan cepat

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
    // getDb, // Biasanya tidak perlu diekspor jika hanya digunakan internal oleh fungsi-fungsi di file ini
    initDatabase,
    closeDatabase, // Diekspor untuk shutdown handling di backend
    saveChatHistory,
    loadChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins, // Diekspor untuk inisialisasi/update admin
    loadAdmins, // Diekspor untuk memuat admin saat startup/login
    saveQuickReplyTemplates, // Diekspor untuk menyimpan template dari backend
    loadQuickReplyTemplates // Diekspor untuk memuat template saat startup
};