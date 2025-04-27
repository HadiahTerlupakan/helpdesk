# Helpdesk Admin WhatsApp

Aplikasi helpdesk berbasis WhatsApp untuk manajemen percakapan pelanggan dengan fitur:
- **Multi-admin** dengan role berbeda (admin/superadmin)
- **Penyimpanan data percakapan** menggunakan SQLite
- **Timer rilis otomatis** (default: 15 menit)
- **Delegasi chat** antar admin
- **Antarmuka admin** yang responsif
- **Fitur superadmin** untuk manajemen admin dan percakapan

## Fitur Utama

1. **Sistem Admin**
   - Login dengan username dan password
   - Dua level akses: admin dan superadmin
   - Session management yang aman
   - Daftar admin yang sedang online
   - Superadmin dapat menambah/menghapus admin

2. **Manajemen Chat**
   - Daftar chat masuk dari pelanggan
   - Ambil chat (pick) untuk ditangani
   - Balas chat langsung dari antarmuka
   - Timer rilis otomatis (dikonfigurasi di config.js)
   - Delegasi chat ke admin lain
   - Superadmin dapat menghapus percakapan

3. **Penyimpanan Data**
   - Penyimpanan riwayat percakapan menggunakan SQLite
   - Penyimpanan data admin menggunakan SQLite

4. **Notifikasi Real-time**
   - Pemberitahuan chat baru
   - Status chat yang diambil admin lain
   - Notifikasi ketika chat dilepas otomatis

## Instalasi

1. Pastikan sudah terinstall:
   - Node.js (versi 14 atau lebih baru)
   - NPM

2. Clone repository ini atau download source code

3. Install dependencies:
```bash
npm install
```

4. Konfigurasi:
   - Edit file `config.js` untuk:
     - Menambahkan/mengubah data admin
     - Mengatur waktu rilis otomatis (`chatAutoReleaseTimeoutMinutes`)
     - Mengubah port server jika diperlukan

5. Jalankan server:
```bash
node backend.js
```

6. Buka browser dan akses:
```
http://localhost:3000
```

## Penggunaan

1. Login sebagai admin menggunakan username dan password yang sudah dikonfigurasi
2. Pilih chat dari daftar chat masuk
3. Balas pesan pelanggan melalui antarmuka
4. Chat akan otomatis dilepas setelah waktu yang ditentukan
5. Admin lain dapat melihat status chat yang sedang ditangani

## Struktur File

- `backend.js` - Logika server utama
- `config.js` - Konfigurasi aplikasi
- `index.html` - Antarmuka pengguna
- `auth_info_baileys/` - Folder penyimpanan session WhatsApp
- `chat_history.json` - File penyimpanan riwayat chat (terbuat otomatis)

## Catatan

1. Pastikan folder `auth_info_baileys` ada untuk menyimpan session WhatsApp
2. Scan QR code WhatsApp saat pertama kali menjalankan aplikasi
3. File `chat_history.json` akan dibuat otomatis untuk menyimpan riwayat chat
4. Waktu rilis otomatis dapat diubah di `config.js` (dalam menit)