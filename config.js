// config.js

const config = {
  // Daftar admin. Tambahkan sesuai kebutuhan.
  // Format: 'username': { password: 'password', initials: 'XX' }
  admins: {
    'admin': { password: 'admin123', initials: '-AD' },
    'admin2': { password: 'password', initials: '-A2' },
    // 'budi': { password: 'rahasia123', initials: 'BU' },
  },

  // Port server Express
  serverPort: 3000,

  // Waktu (dalam menit) sebelum chat yang diambil dilepas otomatis jika tidak ada balasan
  // Set ke 0 atau null untuk menonaktifkan fitur ini.
  chatAutoReleaseTimeoutMinutes: 1,

  // Kunci rahasia untuk sesi Express
  sessionSecret: 'ganti-dengan-kunci-rahasia-yang-kuat',

  // Opsi Baileys (jika diperlukan)
  baileysOptions: {
    // Contoh: printQRInTerminal: true (jika ingin QR di terminal lagi)
  },

  // Tambahkan versi aplikasi
  version: '1.0.1'
};

export default config;