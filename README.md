# MTG Tools

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
4. Isi `ALLOWED_USER_ID` dengan Telegram user ID yang boleh memakai bot.
5. Jalankan:

```bash
node main.js
```

Command bot:

```text
/track <address> <name> <emoji>
/track-list
/track-remove <id|address|name|all>

Chain dideteksi otomatis dari alamat EVM (`ROBINHOOD`) atau Solana (`SOL`). Nama dan emoji disimpan bersama wallet dan dipakai pada alert.
```

Chain dideteksi otomatis dari format address jika argumen chain tidak diberikan. Posisi yang sudah ada ketika wallet pertama kali ditambahkan menjadi baseline dan tidak mengirim alert. Polling berikutnya hanya mengirim event `OPENED` atau `CLOSED`.

Bot hanya memproses pesan dari user yang ID-nya ada di `ALLOWED_USER_ID`. Beberapa ID dapat ditulis dengan koma, misalnya `123456789,987654321`. Jika variable ini kosong atau tidak valid, bot tidak akan start.

Saat `/track` diproses, bot langsung mengirim status sementara sebelum mengambil baseline dari LP Agent. Permintaan `/track` kedua dari user yang sama ditahan sampai proses pertama selesai agar request tidak menumpuk.

Default polling adalah 60 detik dan dapat diubah melalui `POLL_INTERVAL_SECONDS`. Jika LP Agent mengembalikan HTTP 429, bot membaca `Retry-After` dan menunda request berikutnya tanpa mengubah snapshot atau mengirim false `CLOSED` alert.

## Pengembangan

```bash
npm install
npm test
```

Jangan commit `.env` atau data runtime. Gunakan [`.env.example`](.env.example)
sebagai daftar konfigurasi yang diperlukan.

## Data dan alert

Snapshot disimpan sebagai JSON atomik pada `DATABASE_PATH` (default `data/tracker.json`). Snapshot mempertahankan pool, protocol, base fee, range saat open, umur posisi, alias wallet, serta nominal token dan nilai USD untuk alert penutupan.

Enrichment pool (`TVL`, volume 24 jam, dan APR) diambil dari LP Agent hanya saat ada posisi baru, lalu disimpan bersama snapshot. Data tersebut digunakan kembali untuk alert penutupan. Cache in-memory memakai kunci `chain + protocol + pool ID` dengan TTL lima menit.

Pengiriman utama memakai method Telegram `sendRichMessage` dengan rich HTML table. Jika method tersebut ditolak oleh endpoint Bot API, bot memakai pesan teks biasa sebagai fallback agar alert tidak hilang.

Range persentase saat open dipulihkan dari tick bounds dan log opening LP Agent
(`increase`, `open`, atau `add_liquidity`). Untuk posisi single-sided, range
dinormalisasi dari boundary pembukaan, misalnya `+0% | -70%`. Jika log historis
tidak tersedia, bot tetap mengirim alert tetapi menggunakan range saat ini sebagai
fallback.

Beberapa `position_id` yang dibuka atau terdeteksi tertutup bersamaan pada wallet,
pool, dan protocol yang sama digabung menjadi satu alert logical position dengan
jendela waktu default 60 detik. Snapshot tiap `position_id` tetap disimpan untuk
deteksi berikutnya. Nominal token dijumlahkan lalu persentase dihitung ulang;
range gabungan memakai batas terluar opening range (plus terbesar dan minus
terkecil), sehingga single-sided seperti `+0% | -70%` tetap ditampilkan dengan
benar.
