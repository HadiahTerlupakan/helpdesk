// Contoh perubahan untuk konsistensi penyimpanan media
if (isMedia) {
    try {
        const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger });
        mediaData = buffer.toString('base64');
        // Tambahkan penanganan error yang lebih baik
    } catch (error) {
        console.error(`Gagal mengunduh media: ${error}`);
        // Tambahkan pesan error yang lebih informatif
    }
}