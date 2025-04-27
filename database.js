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
    if (dbInstance) {
        return dbInstance;
    }

    try {
        dbInstance = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });

        console.log('[DATABASE] Koneksi SQLite berhasil dibuat');
        return dbInstance;
    } catch (error) {
        console.error('[DATABASE] Gagal membuat koneksi SQLite:', error);
        throw error;
    }
}

/**
 * Inisialisasi skema database
 */
async function initDatabase() {
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
        await db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT,
                message TEXT,
                timestamp INTEGER,
                from_me BOOLEAN,
                sender TEXT,
                FOREIGN KEY (chat_id) REFERENCES chat_history(chat_id)
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
                id TEXT PRIMARY KEY,
                shortcut TEXT UNIQUE,
                text TEXT
            )
        `);

        console.log('[DATABASE] Skema database berhasil diinisialisasi');
    } catch (error) {
        console.error('[DATABASE] Gagal menginisialisasi skema database:', error);
        throw error;
    }
}

// Fungsi-fungsi untuk operasi chat history

/**
 * Menyimpan chat history ke database
 * @param {Object} chatHistory - Objek chat history
 */
async function saveChatHistory(chatHistory) {
    const db = await getDb();
    
    try {
        await db.run('BEGIN TRANSACTION');
        
        for (const encodedChatId in chatHistory) {
            if (!Object.prototype.hasOwnProperty.call(chatHistory, encodedChatId)) continue;
            
            const chatData = chatHistory[encodedChatId];
            const decodedChatId = encodedChatId; // Tidak perlu decode lagi karena kita tidak menggunakan encoding Firebase
            
            // Periksa apakah chat sudah ada
            const existingChat = await db.get('SELECT chat_id FROM chat_history WHERE chat_id = ?', decodedChatId);
            
            if (!existingChat) {
                // Tambahkan chat baru
                await db.run(
                    'INSERT INTO chat_history (chat_id, status) VALUES (?, ?)',
                    decodedChatId,
                    chatData.status || 'open'
                );
            } else {
                // Update status chat yang sudah ada
                await db.run(
                    'UPDATE chat_history SET status = ? WHERE chat_id = ?',
                    chatData.status || 'open',
                    decodedChatId
                );
            }
            
            // Hapus pesan lama untuk chat ini
            await db.run('DELETE FROM messages WHERE chat_id = ?', decodedChatId);
            
            // Tambahkan pesan-pesan baru
            if (chatData.messages && Array.isArray(chatData.messages)) {
                for (const message of chatData.messages) {
                    if (!message || !message.id) continue;
                    
                    await db.run(
                        'INSERT INTO messages (id, chat_id, message, timestamp, from_me, sender) VALUES (?, ?, ?, ?, ?, ?)',
                        message.id,
                        decodedChatId,
                        JSON.stringify(message),
                        message.timestamp || Date.now(),
                        message.fromMe ? 1 : 0,
                        message.sender || ''
                    );
                }
            }
        }
        
        await db.run('COMMIT');
        console.log('[DATABASE] Chat history berhasil disimpan ke database');
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan chat history ke database:', error);
    }
}

/**
 * Memuat chat history dari database
 * @returns {Promise<Object>} - Objek chat history
 */
async function loadChatHistory() {
    const db = await getDb();
    
    try {
        const chatHistory = {};
        
        // Ambil semua chat
        const chats = await db.all('SELECT * FROM chat_history');
        
        for (const chat of chats) {
            // Ambil pesan-pesan untuk chat ini
            const messages = await db.all('SELECT message FROM messages WHERE chat_id = ? ORDER BY timestamp ASC', chat.chat_id);
            
            chatHistory[chat.chat_id] = {
                status: chat.status,
                messages: messages.map(row => JSON.parse(row.message))
            };
        }
        
        console.log('[DATABASE] Chat history berhasil dimuat dari database');
        return chatHistory;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat chat history dari database:', error);
        return {};
    }
}

/**
 * Menghapus chat history berdasarkan chat ID
 * @param {string} chatId - ID chat yang akan dihapus
 * @returns {Promise<boolean>} - True jika berhasil, false jika gagal
 */
async function deleteChatHistory(chatId) {
    const db = await getDb();
    
    try {
        await db.run('BEGIN TRANSACTION');
        
        // Hapus pesan-pesan terlebih dahulu
        await db.run('DELETE FROM messages WHERE chat_id = ?', chatId);
        
        // Hapus chat history
        await db.run('DELETE FROM chat_history WHERE chat_id = ?', chatId);
        
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
 * Menghapus semua chat history
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
 * Menyimpan data admin ke database
 * @param {Object} admins - Objek admin
 */
async function saveAdmins(admins) {
    const db = await getDb();
    
    try {
        await db.run('BEGIN TRANSACTION');
        
        // Hapus semua admin
        await db.run('DELETE FROM admins');
        
        // Tambahkan admin baru
        for (const username in admins) {
            if (!Object.prototype.hasOwnProperty.call(admins, username)) continue;
            
            const admin = admins[username];
            
            await db.run(
                'INSERT INTO admins (username, password, initials, role) VALUES (?, ?, ?, ?)',
                username,
                admin.password,
                admin.initials,
                admin.role
            );
        }
        
        await db.run('COMMIT');
        console.log('[DATABASE] Data admin berhasil disimpan ke database');
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan data admin ke database:', error);
    }
}

/**
 * Memuat data admin dari database
 * @returns {Promise<Object>} - Objek admin
 */
async function loadAdmins() {
    const db = await getDb();
    
    try {
        const admins = {};
        
        // Ambil semua admin
        const adminRows = await db.all('SELECT * FROM admins');
        
        for (const admin of adminRows) {
            admins[admin.username] = {
                password: admin.password,
                initials: admin.initials,
                role: admin.role
            };
        }
        
        console.log('[DATABASE] Data admin berhasil dimuat dari database');
        return admins;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat data admin dari database:', error);
        return {};
    }
}

// Fungsi-fungsi untuk operasi template balasan cepat

/**
 * Menyimpan template balasan cepat ke database
 * @param {Object} templates - Objek template
 */
async function saveQuickReplyTemplates(templates) {
    const db = await getDb();
    
    try {
        await db.run('BEGIN TRANSACTION');
        
        // Hapus semua template
        await db.run('DELETE FROM quick_reply_templates');
        
        // Tambahkan template baru
        for (const shortcut in templates) {
            if (!Object.prototype.hasOwnProperty.call(templates, shortcut)) continue;
            
            const template = templates[shortcut];
            
            await db.run(
                'INSERT INTO quick_reply_templates (id, shortcut, text) VALUES (?, ?, ?)',
                template.id,
                shortcut,
                template.text
            );
        }
        
        await db.run('COMMIT');
        console.log('[DATABASE] Quick reply templates berhasil disimpan ke database');
    } catch (error) {
        await db.run('ROLLBACK');
        console.error('[DATABASE] Gagal menyimpan quick reply templates ke database:', error);
    }
}

/**
 * Memuat template balasan cepat dari database
 * @returns {Promise<Object>} - Objek template
 */
async function loadQuickReplyTemplates() {
    const db = await getDb();
    
    try {
        const templates = {};
        
        // Ambil semua template
        const templateRows = await db.all('SELECT * FROM quick_reply_templates');
        
        for (const template of templateRows) {
            templates[template.shortcut] = {
                id: template.id,
                shortcut: template.shortcut,
                text: template.text
            };
        }
        
        console.log('[DATABASE] Quick reply templates berhasil dimuat dari database');
        return templates;
    } catch (error) {
        console.error('[DATABASE] Gagal memuat quick reply templates dari database:', error);
        return {};
    }
}

export {
    getDb,
    initDatabase,
    saveChatHistory,
    loadChatHistory,
    deleteChatHistory,
    deleteAllChatHistory,
    saveAdmins,
    loadAdmins,
    saveQuickReplyTemplates,
    loadQuickReplyTemplates
};