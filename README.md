# LP Wallet Tracker

Bot Telegram minimal untuk memantau posisi LP baru dibuka dan ditutup pada Solana atau Robinhood Chain.

## Struktur proyek

Kode aplikasi berada di `src/`. Fitur pertama ada di
`src/features/tracker.js`, sedangkan `src/bot.js` menjadi entrypoint runtime.
Panduan penambahan fitur dan aturan direktori tersedia di
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) dan
[`docs/ADDING_FEATURES.md`](docs/ADDING_FEATURES.md).

```text
src/
├── bot.js
└── features/
    ├── README.md
    └── tracker.js
test/
docs/
```

## Menjalankan

1. Salin `.env.example` menjadi `.env` atau export variabelnya ke environment.
2. Isi `TELEGRAM_BOT_TOKEN` dari BotFather.
3. Isi `LPAGENT_API_KEY` dari LP Agent.
4. Jalankan:

```bash
node main.js
```

Command bot:

```text
/track <wallet>
/track <wallet> SOL
/track <wallet> ROBINHOOD
```

Chain dideteksi otomatis dari format address jika argumen chain tidak diberikan. Posisi yang sudah ada ketika wallet pertama kali ditambahkan menjadi baseline dan tidak mengirim alert. Polling berikutnya hanya mengirim event `OPENED` atau `CLOSED`.

Default polling adalah 60 detik dan dapat diubah melalui `POLL_INTERVAL_SECONDS`.

## Pengembangan

```bash
npm install
npm test
```

Jangan commit `.env` atau data runtime. Gunakan [`.env.example`](.env.example)
sebagai daftar konfigurasi yang diperlukan.

## Data dan alert

Snapshot disimpan sebagai JSON atomik pada `DATABASE_PATH` (default `data/tracker.json`). Snapshot mempertahankan pool, protocol, range saat open, umur posisi, serta nominal token dan nilai USD untuk alert penutupan.

Pengiriman utama memakai method Telegram `sendRichMessage` dengan rich HTML table. Jika method tersebut ditolak oleh endpoint Bot API, bot memakai pesan teks biasa sebagai fallback agar alert tidak hilang.

Range persentase saat open dipulihkan dari log `add_liquidity` LP Agent. Jika log historis tidak tersedia, bot tetap mengirim alert tetapi menggunakan range saat ini sebagai fallback.
