# Aplikasi SPJ BOSP

**Sistem Informasi Pertanggungjawaban Dana Bantuan Operasional Satuan Pendidikan**

Aplikasi desktop untuk membantu sekolah mengelola data transaksi BOSP, menyiapkan dokumen pendukung SPJ, dan membuat rekap belanja.

> **Penting:** Aplikasi ini merupakan alat bantu untuk pengelolaan dan pemberkasan internal. Aplikasi ini **bukan pengganti ARKAS** dan tidak menggantikan kewajiban pelaporan melalui sistem resmi yang berlaku.

## Daftar Isi

- [Fitur](#fitur)
- [Panduan Pengguna](#panduan-pengguna)
- [Panduan Pengembang](#panduan-pengembang)
- [Struktur Proyek](#struktur-proyek)
- [Lisensi](#lisensi)

## Fitur

- Impor data referensi kegiatan dan rekening belanja dari Excel.
- Catat transaksi dan olah data BKU serta data BHP/BHM sesuai kebutuhan.
- Lengkapi data dan bukti pendukung SPJ, termasuk foto.
- Buat dokumen SPJ untuk diunduh atau dicetak.
- Lihat dan unduh rekap belanja per tahap atau per tahun menggunakan template Excel.
- Buat gambar pendukung dengan layanan AI yang tersedia di aplikasi.

## Panduan Pengguna

### Instalasi

1. Buka halaman [Releases](https://github.com/rofiq2774/Aplikasi-SPJ-BOSP-v2/releases) dan unduh installer versi terbaru.
2. Unduh juga file referensi dan template yang diperlukan dari [repository proyek](https://github.com/rofiq2774/Aplikasi-SPJ-BOSP-v2):
   - `master_kegiatan.xlsx`
   - `master_rekening.xlsx`
   - `contoh_template_rekap_belanja.xlsx` (untuk melihat contoh template rekap)
3. Jalankan installer dan ikuti petunjuk di layar sampai selesai.
4. Buka aplikasi, lalu isi identitas satuan pendidikan, data pejabat, logo, dan kop surat.

> Installer rilis ditujukan untuk pengguna Windows. Pengguna tidak perlu memasang Python atau Node.js untuk menjalankan aplikasi yang sudah terinstal.

### Alur penggunaan

1. **Impor referensi.** Buka menu Referensi Kegiatan dan Rekening Belanja, lalu impor file master yang sesuai.
2. **Unggah data.** Gunakan menu Upload BKU untuk memproses file Buku Kas Umum dari ARKAS. Unggah file realisasi BHP/BHM jika diperlukan untuk pekerjaan Anda.
3. **Lengkapi SPJ.** Buka menu Daftar SPJ, pilih data yang akan dilengkapi, lalu isi informasi seperti nama kegiatan, tanggal nota, nama dan alamat toko, serta foto bukti.
4. **Unduh dokumen.** Setelah data SPJ lengkap, gunakan tindakan unduh pada aplikasi untuk membuat dokumen SPJ.
5. **Buat rekap belanja.** Pilih rekap per tahap atau per tahun, lalu unggah template Excel yang sesuai. `contoh_template_rekap_belanja.xlsx` dapat digunakan sebagai acuan format.

Format template rekap dapat disesuaikan dengan kebijakan pemerintah daerah. Jika template memerlukan kode, salin kode template yang tersedia di data rekap ke file Excel sebelum mengunggahnya.

### Gambar dengan AI

Untuk membuat gambar pendukung, gunakan tombol bot pada baris barang. Pada penggunaan pertama, pilih penyedia layanan melalui jendela pengaturan.

- Setiap penyedia dapat memiliki persyaratan akun, API key, kuota, dan biaya sendiri. Periksa ketentuan penyedia sebelum menggunakannya.
- Pollinations memerlukan secret key berawalan `sk_`; App Key berawalan `pk_` tidak dapat langsung digunakan sebagai secret key.
- Gemini memerlukan API key Google AI Studio. OpenAI Images memerlukan API key dan billing API; langganan ChatGPT tidak termasuk saldo API.
- Pengaturan penyedia dan API key dapat diubah melalui tombol roda gigi.
- API key disimpan menggunakan fasilitas penyimpanan aman sistem operasi pada komputer yang digunakan. Permintaan pembuatan gambar dikirim ke penyedia layanan yang dipilih.

## Panduan Pengembang

### Teknologi

- **Aplikasi desktop:** Electron
- **Antarmuka:** HTML, CSS, JavaScript, dan Vite
- **Backend:** Python, FastAPI, dan SQLAlchemy
- **Database:** SQLite
- **Dokumen PDF:** pdfmake di sisi frontend

### Persyaratan

- Node.js dan npm
- Python yang dapat dijalankan dengan perintah `python`, beserta pip
- Python 3.10 64-bit untuk proses build installer sesuai skrip proyek

### Menyiapkan lingkungan pengembangan

Dari direktori utama repository, buat dan aktifkan virtual environment Python, pasang dependensi, lalu pasang dependensi Node.js untuk root dan frontend:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
npm install
npm install --prefix frontend
```

Jalankan aplikasi dalam mode pengembangan:

```powershell
npm start
```

Perintah tersebut menjalankan Vite dan Electron. Electron menjalankan backend Python sebagai proses anak; backend memilih port lokal secara dinamis. Karena itu, backend tidak menggunakan port tetap `8000`.

### Build aplikasi

Pada Windows, setelah persyaratan dan dependensi di atas tersedia, jalankan dari direktori utama:

```powershell
npm run build
```

Skrip build menjalankan PyInstaller untuk backend Python 3.10 64-bit, build frontend, lalu membuat paket Electron. Konfigurasi dan lokasi output ditentukan oleh skrip serta konfigurasi proyek.

### Tes

Tes PDF frontend dapat dijalankan dari folder `frontend`:

```powershell
Set-Location frontend
node --test tests\spjPdf.font.test.mjs
```

Tes backend menggunakan `pytest` dan dependensi backend:

```powershell
python -m pytest backend\tests -q
```

Jika `pytest` belum tersedia di lingkungan pengembangan, pasang terlebih dahulu menggunakan pip.

### Struktur proyek

```text
backend/
  main.py             API FastAPI dan alur bisnis backend
  database.py         Koneksi dan sesi database
  models.py           Model tabel SQLAlchemy
  alembic/            Migrasi skema database
  tests/              Tes backend
frontend/
  index.js            Proses utama Electron
  preload.js          Jembatan API aman antara Electron dan antarmuka
  Index.html          Dokumen HTML aplikasi
  src/
    app.js            Antarmuka dan alur aplikasi
    ui.js             Komponen antarmuka bersama
    styles.css        Gaya aplikasi
    spjConfig.js      Konfigurasi jenis belanja dan lampiran
    pdf/spjPdf.js     Pembuatan dokumen PDF SPJ
  tests/              Tes frontend
```

Untuk detail paket, skrip, dan konfigurasi build, lihat `package.json` di direktori utama dan `frontend/package.json`.

## Lisensi

Berikut adalah lisensi penggunaan perangkat lunak ini:

### LICENSE — APLIKASI SPJ BOSP

**Bahasa Indonesia (BAHASA INDONESIA):**

**Hak Cipta © 2026 Muh. Rofiq**

**Izin Penggunaan:**
Pemilik (Muh. Rofiq) memberikan izin non-eksklusif dan tanpa biaya untuk menggunakan (hanya biaya donasi pengembangan aplikasi), menyalin, memodifikasi, dan mendistribusikan perangkat lunak ini untuk keperluan internal sekolah atau instansi pemerintahan. Perjanjian lisensi terpisah diperlukan untuk penggunaan komersial, redistribusi tertutup, atau integrasi pihak ketiga yang menghasilkan pendapatan — silakan hubungi pemilik proyek.

**Ketentuan Umum:**
- **Atribusi:** Sertakan file `license.txt` ini atau catatan atribusi setara pada distribusi sumber atau dokumentasi.
- **Larangan:** Dilarang menghapus atau mengaburkan pemberitahuan hak cipta.
- **Penafian:** Perangkat lunak disediakan "SEBAGAIMANA ADANYA" tanpa jaminan tersurat atau tersirat. Pemilik tidak bertanggung jawab atas kerusakan atau kehilangan data yang timbul dari penggunaan perangkat lunak ini.

**Ringkasan Proyek — Fitur Utama:**
- Impor data referensi kegiatan dan rekening belanja.
- Input manual data pembelanjaan dari dana BOSP.
- Ekstrak BKU menjadi dokumen SPJ BOSP.
- Rekapitulasi Belanja Pertahap dan Per Tahun

**Lisensi Alternatif:**
Jika Anda memerlukan lisensi standar (mis. MIT, Apache 2.0) atau perjanjian tertulis, silakan hubungi pemilik proyek untuk pembahasan dan penyesuaian lisensi.

### LICENSE — SPJ BOSP APPLICATION

**English (ENGLISH):**

**Copyright © 2026 Muh. Rofiq**

**Permission of Use:**
The owner (Muh. Rofiq) grants a non-exclusive and royalty-free license to use (development support may be provided via voluntary donations), copy, modify, and distribute this software for internal use by schools or government institutions.
A separate license agreement is required for commercial use, closed redistribution, or third-party integration that generates revenue — please contact the project owner.

**General Terms:**
- **Attribution:** Include this `license.txt` file or an equivalent attribution notice in any source distribution or documentation.
- **Restriction:** Removal or obscuring of copyright notices is strictly prohibited.
- **Disclaimer:** This software is provided "AS IS", without any express or implied warranties. The owner shall not be liable for any damages or data loss arising from the use of this software.

**Project Summary — Main Features:**
- Import reference data for activities and expenditure accounts.
- Manual input of expenditure data from BOSP funds.
- Extract BKU data into SPJ BOSP documents.
- Expenditure recap by phase and by fiscal year.

**Alternative Licensing:**
If you require a standard open-source license (e.g., MIT, Apache 2.0) or a formal written agreement, please contact the project owner to discuss licensing options and customization.

---

[![Total Downloads](https://img.shields.io/github/downloads/rofiq2774/Aplikasi-SPJ-BOSP-v2/total?style=for-the-badge&label=Pengguna%20&color=2ea44f)](https://github.com/rofiq2774/Aplikasi-SPJ-BOSP-v2/releases)
