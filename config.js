// config.js

const config = {
  // Daftar admin. Tambahkan sesuai kebutuhan.
  // Struktur: 'username': { password: 'password', initials: 'XX', role: 'admin' | 'superadmin' }
  // Role 'superadmin' memiliki akses ke fungsi admin tambahan (misal: menghapus chat, menambah admin).
  // Role 'admin' hanya memiliki fungsi dasar (pick, unpick, reply, delegate).
  // **CATATAN PENTING:** Data admin akan dimuat dari database SQLite saat server pertama kali dimulai.
  // Jika tidak ada admin di database, data admin dari file ini akan digunakan.
  // Setelah admin ditambahkan/diubah melalui fitur Super Admin di aplikasi, database SQLite
  // akan menjadi sumber kebenaran. Mengedit file ini TIDAK akan berpengaruh lagi
  // setelah admin tersimpan di database, kecuali jika data database dihapus.
  // Password sebaiknya di-HASH (misal: menggunakan library bcrypt) untuk keamanan produksi.
  // Untuk contoh ini, kita menggunakan plain text.

  admins: {
    'admin': { password: 'admin123', initials: 'AD', role: 'admin' }, // Contoh: admin biasa
    'admin2': { password: 'password', initials: 'A2', role: 'admin' }, // Contoh: admin biasa
    'superadmin': { password: 'superpassword', initials: 'SA', role: 'superadmin' }, // Contoh: super admin
    // Anda bisa menambahkan admin lain di sini:
    // 'budi': { password: 'rahasia123', initials: 'BU', role: 'admin' },
  },

  // Tentukan username mana dari daftar 'admins' di atas yang memiliki role 'superadmin'
  // Username ini digunakan server untuk memverifikasi izin Super Admin.
  // Pastikan username ini ada dalam daftar 'admins' di atas ATAU di data admin di database SQLite
  // dan memiliki properti `role: 'superadmin'`.
  superAdminUsername: 'superadmin', // <-- PASTIKAN INI SAMA DENGAN USERNAME SUPER ADMIN DI OBJEK ADMINS DI ATAS

  // Port server Express
  serverPort: 3000,

  // Waktu (dalam menit) sebelum chat yang diambil dilepas otomatis jika tidak ada balasan
  // Set ke 0 atau null untuk menonaktifkan fitur ini.
  chatAutoReleaseTimeoutMinutes: 15, // Diubah menjadi 15 menit sebagai contoh

  // Waktu (dalam menit) sebelum admin otomatis logout karena tidak ada aktivitas (AFK)
  // Set ke 0 atau null untuk menonaktifkan fitur ini.
  adminAfkTimeoutMinutes: 30, // <-- Tambahkan ini (contoh: 30 menit)

  // Waktu (dalam menit) sebelum timeout AFK, admin akan menerima peringatan
  // Set ke 0 atau null untuk menonaktifkan peringatan.
  adminAfkWarningMinutes: 20, // <-- Tambahkan ini (contoh: 20 menit sebelum logout)


  // Kunci rahasia untuk sesi Express. GANTI INI dengan string acak yang panjang dan sulit ditebak.
  sessionSecret: 'ganti-dengan-string-acak-yang-panjang-dan-kuat', // <--- GANTI INI !!!

  // Opsi Baileys (jika diperlukan)
  baileysOptions: {
     // Uncomment baris di bawah jika ingin menampilkan QR Code di terminal saat pertama kali login
     // printQRInTerminal: true, // Opsi ini akan diabaikan jika usePairingCode true
     logLevel: 'warn' // Diubah kembali ke warn agar lihat pesan penting Baileys
     // Level yang tersedia: 'trace', 'debug', 'info', 'warn', 'error', 'fatal'
     // logLevel: 'warn'
  },

  // Versi aplikasi (ditampilkan di footer frontend)
  version: '1.0.3', // Tingkatkan nomor versi

  // Konfigurasi untuk mengaktifkan/menonaktifkan log di konsol browser
  enableConsoleLogs: true, // Setel ke 'false' untuk menonaktifkan console.log, console.warn, dll. di frontend
  usePairingCode: false, // <-- Menggunakan Pairing Code seperti yang Anda inginkan
  // Konfigurasi lain bisa ditambahkan di sini
};

export default config;
