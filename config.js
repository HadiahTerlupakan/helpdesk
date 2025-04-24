// config.js

const config = {
  admins: {
    // Tambahkan admin sebanyak yang dibutuhkan
    // Format: 'username': { password: 'password', initials: 'XX' }
    'admin': { password: 'admin123', initials: 'AD' },
    'admin2': { password: 'password', initials: 'A2' },
    // Contoh admin lain:
    // 'budi': { password: 'password123', initials: 'BU' }
  },
  // Konfigurasi lain bisa ditambahkan di sini jika perlu
  serverPort: 3000,
  sessionSecret: 'rahasia-helpdesk-super-aman'
};

module.exports = config;