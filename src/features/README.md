# Features

Setiap fitur aplikasi diletakkan sebagai satu modul di direktori ini.

## Aturan penamaan

- Gunakan nama file berdasarkan fungsi, misalnya `tracker.js` atau
  `next-feature.js`.
- Satu file memiliki satu tanggung jawab utama.
- Export hanya API yang memang dipakai oleh `src/bot.js`, test, atau fitur
  lain.
- Jangan menyimpan token, secret, database runtime, atau file hasil polling di
  dalam direktori source.

## Fitur pertama

`tracker.js` menangani pemantauan posisi LP, snapshot wallet, komunikasi ke LP
Agent, format alert, dan adapter Telegram yang dipakai bot saat ini.

Saat fitur berikutnya ditambahkan, buat modul baru di sini dan tambahkan test
terpisah di `test/` dengan pola `<nama-fitur>.test.js`.
