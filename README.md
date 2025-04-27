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
   - Backup data otomatis

4. **Notifikasi Real-time**
   - Pemberitahuan chat baru
   - Status chat yang diambil admin lain
   - Notifikasi ketika chat dilepas otomatis

## Instalasi

1. Clone repository ini
2. Install dependencies dengan `npm install`
3. Konfigurasi file `config.js` sesuai kebutuhan
4. Jalankan aplikasi dengan `npm start`

## Struktur File

```
helpdesk/
├── backend.js        # Main application
├── config.js         # Configuration file
├── database.js       # Database operations
├── package.json      # Dependencies
└── README.md         # Documentation
```

## Catatan Penting
- Pastikan Node.js versi terbaru terinstall
- Untuk produksi, ganti sessionSecret di config.js
- Backup database secara berkala
- Versi saat ini: 1.0.3