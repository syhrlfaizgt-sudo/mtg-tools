# Struktur proyek

Repository ini menggunakan struktur sederhana agar fitur baru mudah ditemukan
dan tidak bercampur dengan konfigurasi atau dokumentasi.

```text
.
├── src/
│   ├── bot.js                  # entrypoint runtime bot
│   └── features/
│       ├── README.md           # aturan penulisan modul fitur
│       └── tracker.js          # fitur pertama: LP wallet tracking
├── test/                       # automated tests, satu file per fitur
├── docs/                       # dokumentasi teknis dan keputusan struktur
├── data/                       # data runtime lokal (di-ignore Git)
├── main.js                     # launcher tipis untuk npm start
├── .env.example                # daftar environment variable tanpa secret
└── package.json
```

## Alur dependency

`main.js` menjalankan `src/bot.js`. Bot kemudian menggunakan modul fitur di
`src/features/`. Test mengimpor modul fitur secara langsung agar logika bisnis
bisa diuji tanpa harus menyalakan Telegram atau API eksternal.

Import fitur dilakukan langsung melalui `src/features/tracker.js`.

## Aturan data dan secret

- Secret hanya di `.env` lokal atau secret manager; jangan commit `.env`.
- Snapshot runtime disimpan di `data/` dan tidak di-commit.
- Perubahan API eksternal harus memiliki timeout dan penanganan error.
- Perubahan fitur harus disertai test yang menjelaskan perilaku baru.
