# APLIKASI SPJ BOSP

**Sistem Informasi Pertanggungjawaban Dana Bantuan Operasional Satuan Pendidikan**

Aplikasi ini dirancang untuk membantu bendahara sekolah dan instansi pendidikan dalam mengelola data pendukung, mencetak bukti fisik, dan merekapitulasi penggunaan dana BOSP secara efisien.

> ⚠️ **DISCLAIMER / PENTING:**
> Aplikasi ini dikembangkan sebagai **alat bantu (pendamping)** untuk mempermudah pengelolaan pemberkasan internal sekolah. Aplikasi ini **BUKAN SEBAGAI PENGGANTI** aplikasi resmi **ARKAS** (Aplikasi Rencana Kegiatan dan Anggaran Sekolah) dari Kemendikdasmen. Harap tetap menggunakan ARKAS untuk pelaporan resmi yang legal dan sah.

---

## ✨ Fitur Utama

* **Manajemen Data Referensi**: Impor data referensi Kegiatan dan Rekening Belanja.
* **Pencatatan Transaksi**: Input manual data pembelanjaan dari dana BOSP.
* **Otomatisasi Dokumen**: Ekstrak data BKU menjadi dokumen SPJ BOSP siap cetak.
* **Laporan & Rekapitulasi**: Rekapitulasi Belanja Pertahap dan Per Tahun.
* **Foto AI**: Tersedia Pollinations (memerlukan secret key), Hugging Face, Google Gemini, OpenAI Images, dan endpoint gambar OpenAI-compatible kustom.
* **Dukung Kami**: Pindai QR Saweria dari menu aplikasi untuk mendukung pengembangan.

## 🛠️ Teknologi

* **Backend**: Python (FastAPI, SQLAlchemy)
* **Frontend**: HTML, CSS, JavaScript (Electron)
* **Database**: SQLite

---

## 🚀 Cara Instalasi & Menjalankan

1.  **Download Installer**
   Download installer rilis terbaru dari repository kami beserta perlengkapannya (master_kegiatan.xlsx dan master_rekening.xlsx)
    ```bash
    https://github.com/rofiq2774/Aplikasi-SPJ-BOSP-v2
    ```

3.  **Instalasi**
    a. Klik 2 kali pada Installer_Aplikasi-SPJ_x64_vx.x.x.exe, lalu pilih all user kemudian pencet next sampai finish
    b. Buka pada aplikasi yang telah terinstall, kemudian lengkapi mulai dari identitas satuan pendidikan sampai logo dan kop surat

4.  **Impor Data Referensi Kegiatan dan Referensi Rekening Belanja**
    Silahkan impor file excel master_kegiatan.xlsx dan master_rekening.xlsx pada menu Referensi Kegiatan dan Rekening Belanja

5.  **Upload Data BKU dan BHP/BHM**
    Ekstrak data BKU melalui menu Upload BKU, filenya dapat di download dari ARKAS terdiri dari file Buku Kas Umum, Rekapitulasi Realisasi Barang Habis Pakai,
    dan Rekapitulasi Realisasi Barang Modal/Aset (sesuaikan dengan kebutuhan)
    
7. **Data SPJ**
    Lengkapi data SPJ dari menu Daftar SPJ. Kelengkapannya terdiri dari nama kegiatan, tanggal nota, nama toko dan lain-lain sampai foto bukti.

   Untuk membuat foto AI, gunakan tombol bot pada baris barang. Pada penggunaan pertama, pilih provider melalui popup. Pollinations memerlukan secret key berawalan `sk_`; App Key `pk_` tidak dapat digunakan langsung. Izin model dan budget key mengikuti akun Pollinations. Gemini memerlukan API key Google AI Studio dan ketersediaan kuotanya mengikuti akun Google. OpenAI Images memerlukan API key serta billing API tersendiri; langganan ChatGPT tidak mencakup saldo API. Provider lain mungkin mengenakan biaya. Pengaturan provider/API key dapat diubah dari tombol roda gigi. API key disimpan terenkripsi oleh penyimpanan aman sistem operasi pada komputer ini.
   
9. **Download SPJ**
    Setelah data SPJ lengkap, maka Anda dapat mendownload dokumen SPJ untuk digunakan sebagai lampiran laporan BOSP

10. **Rekap Belanja**
    Setelah data SPJ lengkap, maka Anda dapat melihat Rekapitulasi Belanja yang berasal dari Data Referensi Rekening Belanja. Anda dapat mendownload
    Rekapitulasi Belanja Dana BOSP pertahap maupun tahunan dalam bentuk excel dengan mengunggah file template seperti yang ada di contoh pada repository
    kami.
    Anda dapat menyesuaikan format template sesuai kebijakan pemerintah daerah masing-masing, **Kode Template** yang Anda copy dari data rekap dan dipastekan
    pada file excel template rekap akan berubah menjadi angka setelah Anda mendownload rekap tersebut.

---

## 📄 LICENSE / LISENSI

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

---

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


![Total Downloads](https://img.shields.io/github/downloads/rofiq2774/Aplikasi-SPJ-BOSP-v2/total?style=for-the-badge&label=Pengguna%20&color=2ea44f)
