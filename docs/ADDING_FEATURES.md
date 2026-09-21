# Panduan menambahkan fitur

## 1. Buat modul fitur

Tambahkan file baru di `src/features/`, misalnya:

```text
src/features/next-feature.js
```

Gunakan nama yang menjelaskan kemampuan, bukan nama tanggal atau nama
eksperimen. Jaga agar modul memiliki API kecil dan tidak membaca environment
variable secara langsung kecuali memang menjadi tanggung jawabnya.

## 2. Buat test bersamaan

Tambahkan:

```text
test/next-feature.test.js
```

Uji perilaku publik modul tersebut. Untuk API eksternal, gunakan fake client
atau dependency injection agar test tetap cepat dan deterministik.

## 3. Hubungkan ke bot

Tambahkan wiring di `src/bot.js` atau modul komposisi yang relevan. Hindari
menaruh logika bisnis baru langsung di `main.js`; file itu hanya launcher.

## 4. Perbarui dokumentasi

Jelaskan command, environment variable, format data, atau batasan baru di
`README.md` dan/atau `docs/`. Jika fitur memiliki state runtime, pastikan
folder dan format penyimpanannya tercatat serta masuk `.gitignore` bila perlu.

## 5. Jalankan pemeriksaan lokal

```bash
npm test
npm start
```

Sebelum membuat pull request, pastikan tidak ada secret, file database, atau
hasil build yang ikut ter-commit.
