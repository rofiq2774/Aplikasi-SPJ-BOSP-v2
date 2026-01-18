import * as XLSX from "xlsx";
const API_BASE = "http://127.0.0.1:8000/api";
let appVersion = "-";
document.title = `Aplikasi SPJ BOSP v${appVersion}`;

// State
let bkuData = null;
let pengaturan = {
    nama_sekolah: "",
    nama_kepala_sekolah: "",
    nip_kepala_sekolah: "",
    nama_bendahara: "",
    nip_bendahara: "",
    nama_pengurus_barang: "",
    nip_pengurus_barang: "",
    alamat_sekolah: ""
};
let masterKegiatan = [];
let masterRekeningBelanja = [];
let activeTab = "pengaturan";

// Helper
function formatRupiah(num) {
    return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(num);
}

function showMessage(type, text) {
    const msgDiv = document.getElementById("message");
    msgDiv.innerHTML = `<div class="alert alert-${type}">${text}</div>`;
    setTimeout(() => msgDiv.innerHTML = "", 3000);
}

function showToast(title, message, actionText = null, actionCallback = null) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    
    let actionBtnHtml = '';
    if (actionText) {
        actionBtnHtml = `<button class="toast-action-btn toast-btn">${actionText}</button>`;
    }

    toast.innerHTML = `
        <div class="toast-content">
            <span class="toast-title">${title}</span>
            <span class="toast-msg">${message}</span>
        </div>
        ${actionBtnHtml}
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    `;

    container.appendChild(toast);

    // Event Listener untuk tombol aksi (misal: "Lihat Progress")
    if (actionText && actionCallback) {
        const btn = toast.querySelector('.toast-action-btn');
        btn.addEventListener('click', () => {
            actionCallback();
            toast.remove(); // Tutup toast setelah diklik
        });
    }

    // Hilang otomatis setelah 10 detik
    setTimeout(() => {
        if (toast.parentElement) toast.remove();
    }, 10000);
}

// Load settings
async function loadPengaturan() {
    try {
        const res = await fetch(`${API_BASE}/pengaturan`);
        const data = await res.json();
        if (data.data) {
            pengaturan = data.data;
            renderPengaturanForm();
        }
    } catch (err) {
        showToast("Error loading pengaturan:", err);
    }
}

//render pengaturan
function renderPengaturanForm() {
    if (!pengaturan) return;
    const fields = {
        "nama_sekolah": pengaturan.nama_sekolah,
        "nama_kepala": pengaturan.nama_kepala_sekolah,
        "nip_kepala": pengaturan.nip_kepala_sekolah,
        "nama_bendahara": pengaturan.nama_bendahara,
        "nip_bendahara": pengaturan.nip_bendahara,
        "nama_pengurus_barang": pengaturan.nama_pengurus_barang,
        "nip_pengurus_barang": pengaturan.nip_pengurus_barang,
        "alamat_sekolah": pengaturan.alamat_sekolah
    };

    for (const [id, value] of Object.entries(fields)) {
        const el = document.getElementById(id);
        if (el) {
            el.value = value || "";
        }
    }
}

// Load referensi kegiatan
async function loadMasterKegiatan() {
    try {
        const res = await fetch(`${API_BASE}/master-kegiatan`);
        const data = await res.json();
        if (data.data) {
            masterKegiatan = data.data;
            renderMasterKegiatan();
        }
    } catch (err) {
        showToast("Error loading referensi kegiatan:", err);
    }
}

// Save pengaturan
async function savePengaturan() {
    try {
        pengaturan.nama_sekolah = document.getElementById("nama_sekolah").value;
        pengaturan.nama_kepala_sekolah = document.getElementById("nama_kepala").value;
        pengaturan.nip_kepala_sekolah = document.getElementById("nip_kepala").value;
        pengaturan.nama_bendahara = document.getElementById("nama_bendahara").value;
        pengaturan.nip_bendahara = document.getElementById("nip_bendahara").value;
        pengaturan.nama_pengurus_barang = document.getElementById("nama_pengurus_barang").value;
        pengaturan.nip_pengurus_barang = document.getElementById("nip_pengurus_barang").value;
        pengaturan.alamat_sekolah = document.getElementById("alamat_sekolah").value;

        const res = await fetch(`${API_BASE}/pengaturan`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(pengaturan)
        });
        if (res.ok) {
            showToast("Berhasil!", "Pengaturan berhasil disimpan!");
        } else {
            showToast("Gagal!", "Gagal menyimpan pengaturan");
        }
    } catch (err) {
        showToast("Error!", "Error: " + err);
    }
}

// Gunakan window.namaFungsi agar pasti terbaca oleh HTML
window.updateFileList = function() {
    const input = document.getElementById('bkuFile');
    const display = document.getElementById('selected-files');
    if (!input || !display) return;

    // Bersihkan daftar sebelumnya
    display.innerHTML = ""; 

    if (input.files.length > 0) {
        // Validasi Maksimal 12
        if (input.files.length > 12) {
            showToast("Error!", "Maksimal 12 file!");
            try { input.value = ''; } catch(e) {}
            return;
        }

        // Judul List (selaras dengan gaya BHP uploader)
        const title = document.createElement('div');
        title.style.cssText = 'margin: 8px 0 6px 0; font-weight: bold; font-size: 13px; color: #333;';
        title.innerHTML = `📄 File Terpilih (${input.files.length}/12):`;
        display.appendChild(title);

        // Render Daftar File (gaya konsisten dengan BHP)
        Array.from(input.files).forEach((file, index) => {
            const item = document.createElement('div');
            item.style.cssText = 'background: #f8f9fa; padding:8px 12px; margin-bottom:6px; border-radius:6px; display:flex; justify-content:space-between; align-items:center;';
            item.innerHTML = `<div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:85%">${index+1}. ${file.name}</div><div style="color:#666; font-size:12px">${(file.size/1024).toFixed(0)} KB</div>`;
            display.appendChild(item);
        });
    }
};

// Extract Data BKU
async function uploadBKU() {
    const fileInput = document.getElementById("bkuFile");
    const files = fileInput.files;

    // 1. Validasi Minimal 1 File
    if (!files.length) {
        showToast("Error!", "Pilih file PDF terlebih dahulu!");
        return;
    }

    // 2. Validasi Maksimal 12 File
    if (files.length > 12) {
        showToast("Error!", "Maksimal pengunggahan adalah 12 file sekaligus!");
        return;
    }

    const formData = new FormData();
    
    // 3. Masukkan semua file ke dalam FormData
    // Kita gunakan key "files" (jamak) agar backend bisa menerima sebagai list
    for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
    }

    showToast("info!", `Sedang memproses ${files.length} file BKU...`);

    try {
        // Ganti endpoint jika perlu (sesuaikan dengan nama di backend Anda)
        const res = await fetch(`${API_BASE}/extract-bku`, {
            method: "POST",
            body: formData
        });

        if (res.ok) {
            const result = await res.json();
            
            // Pastikan bkuData didefinisikan secara global jika ingin diakses fungsi lain
            bkuData = result.data;

            showToast(
                "Berhasil!",
                `Berhasil extract ${bkuData.transaksi.length} data BKU dari ${files.length} file.`
            );

            renderBKUResult(null, true);
        } else {
            const err = await res.json();
            showToast("Error!", err.detail || "Error extract BKU");
        }
    } catch (err) {
        showToast("Error!", "Error: " + err);
    }
}

// Save data BKU
async function saveTransaksi() {
    if (!bkuData || !bkuData.transaksi || bkuData.transaksi.length === 0) {
        showToast("Warning!", 'Tidak ada data BKU untuk disimpan');
        return;
    }

    // Step 1: request preview (no DB writes)
    showToast("info!", 'Meminta preview sebelum menyimpan...');
    try {
        const previewRes = await fetch(`${API_BASE}/save-transaksi?force=false`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bkuData)
        });

        if (!previewRes.ok) {
            const e = await previewRes.json();
            showToast("Error!", e.detail || 'Gagal mendapatkan preview penyimpanan');
            return;
        }

        const preview = await previewRes.json();

        // If server returned a preview, ask for confirmation (especially if BPU rows would be removed)
        if (preview && preview.status === 'preview') {
            const wouldDelete = preview.would_delete_rows || 0;
            const wouldDeleteBpu = preview.would_delete_bpu_rows || 0;
            const wouldInsert = preview.would_insert || 0;

            let msg = `Aksi ini akan menghapus ${wouldDelete} baris data Buku Kas Umum dan memasukkan ${wouldInsert} baris data Buku Kas Umum yang baru.`;
            if (wouldDeleteBpu > 0) msg += `\nIni juga akan menghapus data Buku Kas Umum yang mungkin sudah diperbaiki!`;
            msg += '\nApakah Anda yakin ingin melanjutkan?';

            if (!confirm(msg)) {
                showToast("info!", 'Simpan dibatalkan oleh pengguna.');
                return;
            }

            // User confirmed — perform actual save with force=true
            const finalRes = await fetch(`${API_BASE}/save-transaksi?force=true`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bkuData)
            });

            if (!finalRes.ok) {
                const err = await finalRes.json();
                showToast('Error!', err.detail || 'Error menyimpan transaksi');
                return;
            }

            const result = await finalRes.json();
            showToast('Berhasil!', `Berhasil menyimpan ${result.saved_count || 0} data BKU`);
            
            // Refresh transaksi dari server
            try {
                const trxRes = await fetch(`${API_BASE}/transaksi`);
                if (!trxRes.ok) throw new Error('Gagal fetch transaksi');
                
                const trxJson = await trxRes.json();
                const transactions = trxJson.data || [];
                
                // Pertahankan kwitansi_list jika ada
                bkuData = { 
                    transaksi: transactions, 
                    kwitansi_list: bkuData?.kwitansi_list || [] 
                };
                
                // Render ulang tabel
                renderBKUResult();
                
            } catch (refreshErr) {
                showToast('Warning!', 'Data disimpan tapi gagal refresh: ' + refreshErr.message);
                // Coba render ulang dengan data yang ada
                renderBKUResult();
            }

        } else if (preview && preview.status === 'success') {
            // If server already applied (unlikely) show success
            showToast('Berhasil!', `Berhasil menyimpan ${preview.saved_count || 0} data BKU`);
        } else {
            showToast('Error!', preview?.detail || 'Respon preview tidak dikenal');
        }

    } catch (err) {
        console.error('saveTransaksi error:', err);
        showToast('Error!', 'Error: ' + (err.message || err));
    }
}

// --------------------------
// BHP/BHM Upload & Mapping
// --------------------------
function updateBhpFileList() {
    const input = document.getElementById('bhpFile');
    const display = document.getElementById('selected-bhp-files');
    display.innerHTML = '';
    if (!input || !display) return;
    if (input.files.length > 24) {
        showToast('Error!', 'Maksimal 24 file untuk BHP/BHM!');
        input.value = '';
        return;
    }
    if (input.files.length === 0) return;
    const title = document.createElement('div');
    title.style.cssText = 'margin: 8px 0 6px 0; font-weight: bold; font-size: 13px; color: #333;';
    title.innerHTML = `📄 File BHP/BHM Terpilih (${input.files.length}/24):`;
    display.appendChild(title);
    Array.from(input.files).forEach((file, idx) => {
        const item = document.createElement('div');
        item.style.cssText = `background: #f8f9fa; padding:8px 12px; margin-bottom:6px; border-radius:6px; display:flex; justify-content:space-between; align-items:center;`;
        item.innerHTML = `<div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:85%">${idx+1}. ${file.name}</div><div style="color:#666; font-size:12px">${(file.size/1024).toFixed(0)} KB</div>`;
        display.appendChild(item);
    });
}

function resetBhpSelection() {
    const input = document.getElementById('bhpFile');
    const display = document.getElementById('selected-bhp-files');
    if (input) try { input.value = ''; } catch(e) {}
    if (display) display.innerHTML = '';
    const res = document.getElementById('bhp-result'); if (res) res.innerHTML = '';
}

function resetBkuSelection() {
    const input = document.getElementById('bkuFile');
    const display = document.getElementById('selected-files');
    if (input) try { input.value = ''; } catch(e) {}
    if (display) display.innerHTML = '';
    const res = document.getElementById('bku-result'); if (res) res.innerHTML = '';
    // Clear any previously extracted data
    bkuData = null;
}

async function extractBHP() {
    const input = document.getElementById('bhpFile');
    if (!input || !input.files.length) { showToast('Error!', 'Pilih file BHP/BHM terlebih dahulu!'); return; }
    // BHP/BHM can be applied independently from BKU extraction — it directly updates transaksi table
    if (input.files.length > 24) { showToast('Error!', 'Maksimal 24 file!'); return; }

    const formData = new FormData();
    Array.from(input.files).forEach(f => formData.append('files', f));
    const jenis = document.getElementById('bhp-type') ? document.getElementById('bhp-type').value : 'BHP';
    formData.append('jenis', jenis);

    showToast('Info!', `Sedang mengekstrak ${input.files.length} file ${jenis}...`);

    try {
        const res = await fetch(`${API_BASE}/extract-bhp`, { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json();
            showToast('Error!', err.detail || 'Gagal ekstrak BHP/BHM');
            return;
        }
        const json = await res.json();
        const bhpData = json.data || [];
        // Send extracted BHP data to backend to apply changes server-side
        try {
            const applyRes = await fetch(`${API_BASE}/apply-bhp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bhpData)
            });

            if (!applyRes.ok) {
                const err2 = await applyRes.json();
                showToast('Error!', err2.detail || 'Gagal menerapkan perbaikan BHP/BHM');
                return;
            }

            const applyJson = await applyRes.json();
            const deleted = applyJson.deleted || 0;
            const inserted = applyJson.inserted || 0;
            window.lastBhpAppliedCount = inserted;

            // Refresh BKU data from server so frontend mirrors DB
            try {
                const trxRes = await fetch(`${API_BASE}/transaksi`);
                const trxJson = await trxRes.json();
                bkuData = { transaksi: trxJson.data || [] };
            } catch (err3) {
                showToast("Error!", 'Gagal refresh transaksi: ' + err3);
            }

            showToast('Berhasil!', `Ekstrak selesai — ${deleted} baris diganti, ${inserted} baris dimasukkan`);
            const resDiv = document.getElementById('bhp-result');
            if (resDiv) resDiv.innerHTML = `<div class="alert alert-info">Ekstrak selesai — <strong>${deleted}</strong> baris diganti, <strong>${inserted}</strong> baris dimasukkan.</div>`;
            renderBKUResult();

        } catch (err2) {
           
            showToast('Error!', 'Error applying BHP/BHM: ' + (err2.message || err2));
        }
    } catch (err) {
        
        showToast('Error!', 'Error: ' + (err.message || err));
    }
}

function normalizeNoBukti(v) {
    if (!v) return '';
    return v.toString().replace(/\s|\W/g, '').toLowerCase();
}

function normalizeDateToDDMMYYYY(input) {
    if (!input) return '';
    // Try parsing common formats
    let d = null;
    // If already dd-mm-yyyy or dd/mm/yyyy
    if (/^\d{2}[\-\/]\d{2}[\-\/]\d{4}$/.test(input)) {
        return input.replace(/\//g, '-');
    }
    // If yyyy-mm-dd
    if (/^\d{4}\-\d{2}\-\d{2}$/.test(input)) {
        const parts = input.split('-');
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    // Fallback: try Date parsing
    const tmp = new Date(input);
    if (!isNaN(tmp.getTime())) {
        const dd = String(tmp.getDate()).padStart(2, '0');
        const mm = String(tmp.getMonth() + 1).padStart(2, '0');
        const yyyy = tmp.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    }
    return '';
}

function applyBhpToBKU(bhpItems) {
    if (!bkuData || !Array.isArray(bhpItems) || bhpItems.length === 0) return 0;
    let modified = 0;
    bhpItems.forEach(b => {
        const nbRaw = (b.no_bukti || b['No Bukti'] || b['no_bukti'] || '').toString().trim();
        if (!nbRaw) return;
        const nb = normalizeNoBukti(nbRaw);
        // try exact matches first
        const matches = bkuData.transaksi.filter(t => normalizeNoBukti(t.no_bukti) === nb);
        const candidates = matches.length ? matches : bkuData.transaksi.filter(t => normalizeNoBukti((t.no_bukti||'')).includes(nb) || nb.includes(normalizeNoBukti((t.no_bukti||''))));

        candidates.forEach(t => {
            // Update tanggal (if present)
            const newTanggal = normalizeDateToDDMMYYYY(b.tanggal || b.Tanggal || b.tanggal_bhp || b.tgl || '');
            if (newTanggal) t.tanggal = newTanggal;

            // Update harga_satuan (if present and numeric)
            const rawHarga = b.harga_satuan || b['Harga Satuan'] || b.harga || b.harga_satuan_bhp || '';
            const h = parseFloat(String(rawHarga).toString().replace(/[^0-9\-\.]/g, ''));
            if (!isNaN(h) && h > 0) {
                t.harga_satuan = h;
            }

            // Recalculate pengeluaran from volume * harga_satuan
            const vol = parseFloat(t.volume) || 0;
            const harga = parseFloat(t.harga_satuan) || 0;
            t.pengeluaran = vol * harga;

            // NOTE: id barang and realisasi from BHP/BHM are intentionally ignored per spec
            modified++;
        });
    });
    return modified;
}

//load Kwitansi
async function loadKwitansiList() {
    try {
        const res = await fetch(`${API_BASE}/kwitansi`);
        const json = await res.json();

        if (json.status === "success") {
            // SIMPAN KE VARIABEL GLOBAL bkuData UNTUK PENCARIAN
            bkuData = { transaksi: bkuData?.transaksi || [], kwitansi_list: json.data };
            renderKwitansiList(json.data);
        }
    } catch (err) {
        showToast("Error!", "Gagal memuat data SPJ: " + err.message);
    }
}

// Generate Kwitansi
async function generateKwitansi() {
    if (!confirm("Generate ulang semua Data SPJ? Data lama akan dihapus.")) {
        return;
    }

    const res = await fetch(`${API_BASE}/kwitansi/generate`, {
        method: "POST"
    });

    const json = await res.json();
    showToast("Berhasil!", `Berhasil generate ${json.generated} SPJ`);
    loadKwitansiList();
}

// Download Kwitansi
async function downloadKwitansi(id, noBukti = "") {
    showToast("Info", "Mengunduh SPJ...");

    try {
        const res = await fetch(`${API_BASE}/kwitansi/${id}/pdf`);

        if (!res.ok) {
            const err = await res.json();
            showToast("Error!", err.detail || "Gagal mengunduh SPJ");
            return;
        }

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const safeFileName = noBukti ? noBukti.replace(/\//g, "-") : id;
        a.download = `SPJ-${safeFileName}.pdf`;
        
        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        showToast("Berhasil!", "SPJ berhasil diunduh");

    } catch (err) {
        showToast("Error!", "Error: " + err.message);
    }
}

// Import referensi kegiatan from Excel
async function importMasterKegiatan() {
    const fileInput = document.getElementById("excelFile");
    if (!fileInput.files.length) {
        showToast("Error!", "Pilih file Excel terlebih dahulu!");
        return;
    }

    showToast("Info", "Sedang import...");
    try {
        const data = await fileInput.files[0].arrayBuffer();
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet);

        if (!json.length) {
            showToast("Error!", "File Excel kosong atau format salah");
            return;
        }

        const masterData = json
            .map(row => ({
                kode_kegiatan: String(row.kode_kegiatan || row["Kode Kegiatan"] || row["kode"] || "").trim(),
                nama_kegiatan: String(row.nama_kegiatan || row["Nama Kegiatan"] || row["nama"] || "").trim()
            }))
            .filter(item => item.kode_kegiatan && item.nama_kegiatan);

        const res = await fetch(`${API_BASE}/master-kegiatan/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: masterData })
        });

        if (res.ok) {
            const result = await res.json();
            const total = result.saved_count ?? result.total ?? 0;

            showToast("Berhasil!", `Berhasil import ${total} data referensi kegiatan`);
            loadMasterKegiatan();
        } else {
            showToast("Error!", "Gagal import data referensi kegiatan");
        }

    } catch (err) {
        showToast("Error!", "Error: " + err);
    }

    fileInput.value = "";
}

// Import referensi rekening belanja from Excel
async function importMasterRekeningBelanja() {
    const fileInput = document.getElementById("excelFileRekening");
    if (!fileInput || !fileInput.files.length) {
        showToast("Error!", "Pilih file Excel terlebih dahulu!");
        return;
    }

    showToast("Info", "Sedang import rekening belanja...");
    try {
        const data = await fileInput.files[0].arrayBuffer();
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet);

        if (!json.length) {
            showToast("Error!", "File Excel kosong atau format salah");
            return;
        }

        const masterData = json
            .map(row => ({
                kode_rekening_belanja: String(row.kode_rekening_belanja || row["kode_rekening_belanja"] || row["kode"] || "").trim(),
                nama_rekening_belanja: String(row.nama_rekening_belanja || row["nama_rekening_belanja"] || row["nama"] || "").trim(),
                rekap_rekening_belanja: String(row.rekap_rekening_belanja || row["rekap_rekening_belanja"] || "").trim(),
                nilai_kapitalisasi_belanja: parseFloat(row.nilai_kapitalisasi_belanja || row["nilai_kapitalisasi_belanja"] || 0) || 0
            }))
            .filter(item => item.kode_rekening_belanja && item.nama_rekening_belanja);

        const res = await fetch(`${API_BASE}/master-rekening-belanja/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: masterData })
        });

        if (res.ok) {
            const result = await res.json();
            const total = result.saved_count ?? result.total ?? 0;

            showToast("Berhasil!", `Berhasil import ${total} data rekening belanja`);
            loadMasterRekeningBelanja();
        } else {
            showToast("Error!", "Gagal import data rekening belanja");
        }

    } catch (err) {
        showToast("Error!", "Error: " + err);
    }

    fileInput.value = "";
}

// Load referensi rekening belanja
async function loadMasterRekeningBelanja() {
    try {
        const res = await fetch(`${API_BASE}/master-rekening-belanja`);
        const json = await res.json();
        if (json.status === "success") {
            masterRekeningBelanja = json.data || [];
            renderMasterRekeningBelanja();
        }
    } catch (err) {
        showToast("Error!", "Error loading master rekening belanja: " + err);
    }
}

// render referensi rekening belanja
function renderMasterRekeningBelanja(data = null) {
    const container = document.getElementById("master-rekening-list");
    const countSpan = document.getElementById("master-rekening-count");
    if (!container) return;
    const list = data || masterRekeningBelanja;
    countSpan.innerText = list.length;

    if (list.length === 0) {
        container.innerHTML = "<p style='text-align:center; padding:20px;'>Belum ada data referensi rekening belanja.</p>";
        return;
    }

    let html = `
        <div class="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th style="width:180px">Kode Rekening</th>
                        <th>Nama Rekening</th>
                        <th style="width:180px">Rekap</th>
                        <th style="width:140px; text-align:right">Nilai Kapitalisasi</th>
                        <th style="width:120px; text-align:center">Aksi</th>
                    </tr>
                </thead>
                <tbody>
    `;

    list.forEach(item => {
        html += `
            <tr>
                <td><strong>${item.kode_rekening_belanja}</strong></td>
                <td>${item.nama_rekening_belanja}</td>
                <td>${item.rekap_rekening_belanja || "-"}</td>
                <td style="text-align:right">${item.nilai_kapitalisasi_belanja ? Number(item.nilai_kapitalisasi_belanja).toLocaleString('id-ID') : '-'}</td>
                <td style="text-align:center">
                    <button class="btn btn-danger btn-sm" onclick="deleteMasterRekening(${item.id})">Hapus</button>
                </td>
            </tr>
        `;
    });

    html += "</tbody></table></div>";
    container.innerHTML = html;
}

// Hapus master rekening (frontend) — akan memanggil endpoint DELETE di backend jika tersedia
// Ganti fungsi deleteMasterRekening yang lama dengan ini:
async function deleteMasterRekening(id) {
    if (!confirm("Hapus rekening belanja ini?")) return;

    try {
        const response = await fetch(`${API_BASE}/master-rekening-belanja/${id}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.detail || "Gagal menghapus rekening.");
        }

        // Hapus dari array lokal masterRekeningBelanja
        masterRekeningBelanja = masterRekeningBelanja.filter(item => item.id !== id);
        
        // Render ulang tabel Master Rekening
        renderMasterRekeningBelanja(); 
        
        showToast("Berhasil!", "Data Referensi Rekening Belanja berhasil dihapus.");

    } catch (error) {
        
        showToast("Gagal!",`Gagal menghapus: ${error.message}`);
    }
}

// Generate / Render Rekap Transaksi
async function generateRekapTransaksi(forceDetails = false) {
    showToast('info!', 'Memproses rekap...');
    try {
        const include = forceDetails || document.getElementById('rekap-include-details')?.checked;
        const thp = document.getElementById('rekap-thp-select') ? document.getElementById('rekap-thp-select').value : 'all';
        const res = await fetch(`${API_BASE}/rekap-transaksi?details=${include ? 1 : 0}&thp=${encodeURIComponent(thp)}`);
        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.detail || 'Gagal memproses rekap');
        renderRekapTransaksi(json.data, include);
        showToast('Berhasil!', 'Rekap selesai');
    } catch (err) {
       
        showToast('Error!', err.message || err);
    }
}

// 1. FUNGSI HELPER (Untuk membuat kode placeholder: "Belanja ATK" -> "BELANJA_ATK")
function getPlaceholderCode(text) {
    if (!text) return "";
    return text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

// 2. EDIT FUNGSI RENDER (Menambahkan Kolom Kode Template)
function renderRekapTransaksi(data, withDetails = false) {
    const container = document.getElementById('rekap-result');
    if (!container) return;

    if (!Array.isArray(data) || data.length === 0) {
        container.innerHTML = "<p style='text-align:center; padding:20px;'>Tidak ada data rekap.</p>";
        return;
    }

    // Tambahkan header kolom 'Kode Template'
    let html = `
        <div class="table-container">
            <table>
                <thead>
                    <tr>
                        <th>Uraian Rekap</th>
                        <th style="width:250px; background:#eef;">Kode Template (Copy Ini)</th>
                        <th style="text-align:right">Jumlah</th>
                    </tr>
                </thead>
                <tbody>
    `;

    data.forEach(group => {
        // Generate kode untuk ditampilkan
        const code = getPlaceholderCode(group.rekap);

        html += `
            <tr>
                <td><strong>${group.rekap}</strong></td>
                
                <td style="background:#f4faff;">
                    <code 
                        style="cursor:pointer; display:block; padding:4px; background:#fff; border:1px solid #ddd; font-size:11px; color:#d63384;"
                        onclick="navigator.clipboard.writeText('${code}'); showToast('Info','Kode ${code} disalin!');"
                        title="Klik untuk copy"
                    >${code}</code>
                </td>

                <td style="text-align:right">Rp ${Number(group.total_pengeluaran || 0).toLocaleString('id-ID')}</td>
            </tr>
        `;

        // ... (Bagian Detail di bawahnya TETAP SAMA seperti kode lama Anda) ...
        if (withDetails && Array.isArray(group.items) && group.items.length > 0) {
            html += `
                <tr>
                    <td colspan="3"> <div style="padding:10px; background:#fafafa; border-radius:8px; margin-top:6px;">
                            <strong>Detail:</strong>
                            <table style="width:100%; margin-top:8px; border-collapse:collapse;">
                                <thead>
                                    <tr>
                                        <th>No Bukti</th>
                                        <th>Kode Rekening</th>
                                        <th>Harga Satuan</th>
                                        <th style="text-align:right">Jumlah</th>
                                    </tr>
                                </thead>
                                <tbody>
            `;
            group.items.forEach(it => {
                html += `
                    <tr>
                        <td>${it.no_bukti}</td>
                        <td>${it.kode_rekening}</td>
                        <td>Rp ${Number(it.harga_satuan || 0).toLocaleString('id-ID')}</td>
                        <td style="text-align:right">Rp ${Number(it.pengeluaran || 0).toLocaleString('id-ID')}</td>
                    </tr>
                `;
            });
            html += `</tbody></table></div></td></tr>`;
        }
    });

    html += "</tbody></table></div>";
    container.innerHTML = html;
}

// 3. FUNGSI BARU: PROSES UPLOAD EXCEL
async function processTemplateExcel() {
    const fileInput = document.getElementById('template-file');
    const thpSelect = document.getElementById('rekap-thp-select');

    if (!fileInput.files || fileInput.files.length === 0) {
        showToast('Warning', 'Silakan pilih file template Excel (.xlsx) dulu.');
        return;
    }

    const formData = new FormData();
    const originalFile = fileInput.files[0]; // Simpan referensi file asli
    formData.append('file', originalFile);
    formData.append('thp', thpSelect.value);

    showToast('Info', 'Sedang memproses Excel...');

    try {
        const res = await fetch(`${API_BASE}/generate-rekap-excel`, {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            const errJson = await res.json();
            throw new Error(errJson.detail || 'Gagal memproses file');
        }

        const blob = await res.blob();

        // --- LOGIC RENAME DI SINI (FRONTEND) ---
        // 1. Ambil nama asli dari input file
        const originalName = originalFile.name; 
        
        // 2. Regex: Hapus kata template (case insensitive) dan separatornya
        // /.../gi -> g = global, i = insensitive (huruf besar/kecil dianggap sama)
        let cleanName = originalName.replace(/[_-\s]*template[_-\s]*/gi, '');

        // 3. Validasi: Jika hasil rename jadi aneh (misal cuma ".xlsx"), pakai nama default
        if (cleanName.length < 5) { // ".xlsx" itu 5 karakter
            cleanName = `Rekap_Hasil_${thpSelect.value}.xlsx`;
        }
        // ---------------------------------------

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // Gunakan nama hasil olahan JS di sini
        a.download = cleanName; 
        
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        
        showToast('Success', `File berhasil diunduh: ${cleanName}`);
    } catch (err) {
        console.error(err);
        showToast('Error', err.message);
    }
}

// Delete referensi kegiatan
async function deleteMasterKegiatan(kode) {
    if (!confirm(`Hapus master kegiatan ${kode}?`)) return;
    
    try {
        const res = await fetch(`${API_BASE}/master-kegiatan/${encodeURIComponent(kode)}`, {
            method: "DELETE"
        });
        if (res.ok) {
            showToast("Berhasil!", "Data Referensi Kegiatan berhasil dihapus.");
            loadMasterKegiatan();
        }
    } catch (err) {
        showToast("Gagal!", "Error: " + err);
    }
}

// Tab switching
window.switchTab = function(tab) {
    // 1. Update State Active Tab
    activeTab = tab;

    // 2. UI Toggle (Button & Content)
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    
    document.querySelectorAll(".tab-content").forEach(content => {
        // Cek ID: sesuaikan dengan HTML Anda (apakah 'tab-master' atau hanya 'master')
        // Kode asli Anda menggunakan prefix 'tab-', jadi saya pertahankan:
        content.classList.toggle("active", content.id === `tab-${tab}`);
    });

    // 3. LOGIC PENCARIAN GLOBAL (BARU)
    const searchInput = document.getElementById("globalSearchInput");
    
    if (searchInput) {
        // A. Reset isi kotak pencarian setiap pindah tab
        searchInput.value = ""; 
        
        // B. Ambil container search untuk hide/show (opsional)
        const searchContainer = searchInput.parentElement; 

        // C. Atur Placeholder & Render Ulang Data Asli (Reset Filter)
        switch (tab) {
            case 'master':
                searchInput.placeholder = "🔍 Cari data...";
                if(searchContainer) searchContainer.style.display = 'flex'; // Tampilkan search
                // Reset tabel ke data penuh (unfiltered)
                if (typeof renderMasterKegiatan === 'function') renderMasterKegiatan(masterKegiatan);
                break;

            case 'rekening':
                searchInput.placeholder = "🔍 Cari data...";
                if(searchContainer) searchContainer.style.display = 'flex';
                if (typeof renderMasterRekeningBelanja === 'function') renderMasterRekeningBelanja(masterRekeningBelanja);
                break;

            case 'data-bku':
                searchInput.placeholder = "🔍 Cari data...";
                if(searchContainer) searchContainer.style.display = 'flex';
                // Pastikan bkuData ada sebelum akses transaksi
                if (typeof renderBKUResult === 'function') {
                    renderBKUResult(bkuData ? bkuData.transaksi : []);
                }
                break;

            case 'kwitansi':
                searchInput.placeholder = "🔍 Cari data...";
                if(searchContainer) searchContainer.style.display = 'flex';
                // Pastikan fungsi renderKwitansiList ada
                if (typeof renderKwitansiList === 'function' && bkuData) {
                    renderKwitansiList(bkuData.kwitansi_list);
                }
                break;

            case 'pengaturan':
                // Sembunyikan search bar di menu pengaturan karena tidak relevan
                if(searchContainer) searchContainer.style.display = 'none';
                break;
            
            case 'pemda':
                // Sembunyikan search bar di menu pengaturan karena tidak relevan
                if(searchContainer) searchContainer.style.display = 'none';
                break;

            case 'rekap':
                // Sembunyikan search bar di menu pengaturan karena tidak relevan
                if(searchContainer) searchContainer.style.display = 'none';
                break;
            
            case 'bku':
                // Sembunyikan search bar di menu pengaturan karena tidak relevan
                if(searchContainer) searchContainer.style.display = 'none';
                break;            

            case 'update':
                // Sembunyikan search bar di menu pengaturan karena tidak relevan
                if(searchContainer) searchContainer.style.display = 'none';
                break;

            default:
                // Default behavior untuk tab lain (misal Rekap)
                searchInput.placeholder = "🔍 Cari data...";
                if(searchContainer) searchContainer.style.display = 'flex';
                break;
        }
    }

    // 4. Auto-load Rekap (Logic Lama Anda)
    if (tab === 'rekap') {
        const includeDetails = document.getElementById('rekap-include-details')?.checked || false;
        if (typeof generateRekapTransaksi === 'function') {
            generateRekapTransaksi(includeDetails);
        }
        // Opsional: Jika menu Rekap belum support search, sembunyikan search bar di sini:
        // if(searchInput && searchInput.parentElement) searchInput.parentElement.style.display = 'none';
    }
};

//render referensi kegiatan
function renderMasterKegiatan(data = null) {
    const container = document.getElementById("master-list");
    const countSpan = document.getElementById("master-count");
    if (!container) return;
    const list = data || masterKegiatan;
    countSpan.innerText = list.length;

    if (list.length === 0) {
        container.innerHTML = "<p style='text-align:center; padding:20px;'>Belum ada data referensi kegiatan.</p>";
        return;
    }

    let html = `
        <div class="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th style="width:150px">Kode Kegiatan</th>
                        <th>Nama Kegiatan</th>
                        <th style="width:100px; text-align:center">Aksi</th>
                    </tr>
                </thead>
                <tbody>
    `;

    list.forEach(item => {
        html += `
            <tr>
                <td><strong>${item.kode_kegiatan}</strong></td>
                <td>${item.nama_kegiatan}</td>
                <td style="text-align:center">
                    <button class="btn btn-sm btn-danger" onclick="deleteMasterKegiatan('${item.kode_kegiatan}')">
                    Hapus
                    </button>
                </td>
            </tr>
        `;
    });

    html += "</tbody></table></div>";
    container.innerHTML = html;
}

// Render functions
// Tambahkan parameter isExtractMode (default: false)
function renderBKUResult(filteredData = null, isExtractMode = false) {
    const tbody = document.getElementById("bku-body");
    const btnArea = document.getElementById("bku-action-buttons");

    if (!tbody) return;

    const dataToRender = filteredData || (bkuData ? bkuData.transaksi : []);

    if (dataToRender.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px;">Tidak ada data ditemukan.</td></tr>';
        if (btnArea) btnArea.style.display = "none";
        return;
    }

    // LOGIKA BARU: Tombol hanya muncul JIKA ada data DAN isExtractMode bernilai true
    if (isExtractMode && dataToRender.length > 0) {
        if (btnArea) btnArea.style.display = "block";
    } else {
        if (btnArea) btnArea.style.display = "none";
    }

    tbody.innerHTML = '';
    dataToRender.forEach(item => {
        const row = `
            <tr>
                <td>${item.no_bukti || '-'}</td>
                <td>${item.tanggal || '-'}</td>
                <td>${item.kode_kegiatan || '-'}</td>
                <td>${item.uraian || '-'}</td>
                <td>${item.volume || 0}</td>
                <td>${item.satuan || ''}</td>
                <td>${formatCurrencyLabel(item.harga_satuan || 0)}</td>
                <td>${formatCurrencyLabel(item.pengeluaran || 0)}</td>
                <td style="text-align:center">
                    <button class="btn btn-danger btn-sm" onclick="deleteTransaksi('${item.no_bukti}')">Hapus</button>
                </td>
            </tr>
        `;
        tbody.insertAdjacentHTML('beforeend', row);
    });
}
 

function parseTanggalToDate(value) {
    if (!value) return null;
    const parts = value.split("-");
    if (parts.length !== 3) return null;

    const [dd, mm, yyyy] = parts.map(Number);
    const d = new Date(yyyy, mm - 1, dd);

    return isNaN(d.getTime()) ? null : d;
}

function formatTanggalID(value) {
    const d = parseTanggalToDate(value);
    return d ? d.toLocaleDateString("id-ID") : "-";
}

function downloadBAST(noBukti) {
    if (!noBukti) {
        alert("No bukti belum tersedia");
        return;
    }

    const url = `${API_BASE}/kwitansi/bast/${encodeURIComponent(noBukti)}`;
    
    // Membuat elemen jangkar (anchor) sementara
    const link = document.createElement('a');
    link.href = url;
    
    // Menentukan bahwa link ini harus mendownload (bukan navigasi)
    // Nama file di sini akan dioverride oleh header dari backend
    link.setAttribute('download', `BAST-${noBukti}.pdf`);
    
    // Sembunyikan elemen dari dokumen
    link.style.display = 'none';
    document.body.appendChild(link);
    
    // Jalankan perintah klik
    link.click();
    
    // Hapus elemen setelah selesai
    document.body.removeChild(link);
}


// --- Fungsi Render Kwitansi ---
function renderKwitansiList(list) {
    const container = document.getElementById("kwitansi-list");

    if (!Array.isArray(list)) {
        container.innerHTML = "<div class='alert alert-danger'>Data kwitansi tidak valid</div>";
        return;
    }

    list.sort((a, b) => {
        const dA = parseTanggalToDate(a.tanggal);
        const dB = parseTanggalToDate(b.tanggal);
        if (dA && dB && dA.getTime() !== dB.getTime()) return dA - dB;
        return (a.nomor_kwitansi || "").localeCompare(b.nomor_kwitansi || "", undefined, { numeric: true });
    });

    let html = `
        <style>
            .table-responsive { width: 100%; overflow-x: auto; margin-top: 10px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
            .main-table { width: 100%; border-collapse: collapse; min-width: 900px; background: white; }
            .main-table th { background: #f8f9fa; padding: 15px 10px; border-bottom: 2px solid #dee2e6; text-align: left; color: #495057; }
            .main-table td { padding: 12px 10px; border-bottom: 1px solid #eee; vertical-align: middle; }
            .btn-sm { padding: 6px 12px; font-size: 12px; cursor: pointer; border-radius: 4px; border: none; transition: 0.2s; }
            .btn-sm:hover { opacity: 0.8; }
            
            /* Popup Styling */
            .popup-content { width: 700px; max-width: 95%; background: white; border-radius: 12px; overflow: hidden; animation: slideDown 0.3s ease-out; }
            @keyframes slideDown { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            .popup-header { background: #f8f9fa; padding: 20px 25px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
            .popup-body { padding: 25px; max-height: 70vh; overflow-y: auto; }
            .popup-footer { padding: 15px 25px; background: #f8f9fa; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 10px; }
            
            .form-group { margin-bottom: 15px; }
            .form-group label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 5px; }
            .form-control { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
            .form-control:focus { border-color: #4a90e2; outline: none; box-shadow: 0 0 0 2px rgba(74,144,226,0.2); }
            
            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
            
            @media (max-width: 600px) {
                .grid-2 { grid-template-columns: 1fr; }
                .uraian-row { flex-direction: column; align-items: stretch !important; gap: 5px !important; border-bottom: 1px solid #eee; padding-bottom: 10px; }
            }
        </style>
        
        <div style="margin-bottom:20px">
            <button class="btn btn-primary" style="padding: 10px 20px; font-weight: bold;" onclick="generateKwitansi()">
                ⚡ Generate SPJ
            </button>
        </div>

        <div class="table-scroll">
            <table class="main-table">
                <thead>
                    <tr>
                        <th style="width:120px">Tanggal</th>
                        <th style="width:180px">No Kwitansi</th>
                        <th>Kegiatan</th>
                        <th style="width:140px">Jumlah</th>
                        <th style="width:110px; text-align:center">Status</th>
                        <th style="width:160px; text-align:center">Aksi</th>
                    </tr>
                </thead>
                <tbody>
    `;

    if (list.length === 0) {
        html += `<tr><td colspan="6" style="text-align:center; padding: 40px; color: #999;">Belum ada data SPJ</td></tr>`;
    } else {
        list.forEach(k => {
    const isBlank = (val) => !val || val.toString().trim() === "";
    
    const needsUpdate = isBlank(k.no_bast) &&
                        isBlank(k.tanggal_nota) && 
                        isBlank(k.nama_toko) && 
                        isBlank(k.alamat_toko) &&
                        isBlank(k.npwp_toko) && 
                        (!Array.isArray(k.uraian) || k.uraian.length === 0);

    html += `
        <tr>
            <td>${formatTanggalID(k.tanggal)}</td>
            <td>${k.nomor_kwitansi || "<span style='color:orange'>DRAFT</span>"}</td>
            <td>${k.nama_kegiatan}</td>
            <td>Rp ${Number(k.jumlah).toLocaleString("id-ID")}</td>
            <td style="text-align:center">
                <button class="btn-sm ${needsUpdate ? "btn-danger" : "btn-success"}" 
                    onclick="openUpdateDetailPopup(${k.id})">
                    ${needsUpdate ? "✏️ Lengkapi" : "✅ Edit"}
                </button>
            </td>
<td style="text-align:center; display: flex; gap: 5px; justify-content: center;">
    ${k.nomor_kwitansi
        ? `
            <button class="btn-sm btn-outline-primary" onclick="downloadKwitansi(${k.id}, '${k.no_bukti}')">
                  📦 SPJ
            </button>
          `
        : `<span style="color:#aaa; font-size:11px; font-style: italic;">Menunggu Generate</span>`
    }
</td>
        </tr>
    `;
});
    }

    html += "</tbody></table></div>";
    container.innerHTML = html;
}

function formatCurrencyID(input) {
    let value = input.value.replace(/\D/g, "");
    if (value !== "") {
        input.value = Number(value).toLocaleString("id-ID");
    } else {
        input.value = "";
    }
}

/**
 * 1. FUNGSI VALIDASI (Wajib berada di scope global)
 * Kita daftarkan ke window agar selalu bisa dipanggil oleh oninput
 */
window.updateValidasiPengeluaran = function(el) {
    const row = el.closest('tr');
    if (!row) return;

    const volInput = row.querySelector('.edit-uraian-vol');
    const hargaInput = row.querySelector('.edit-uraian-harga');
    const pengeluaranInput = row.querySelector('.edit-uraian-pengeluaran');

    // 1. Ambil Volume (Handle string kosong jadi 0)
    const volume = parseFloat(volInput.value) || 0;

    // 2. Ambil Harga (Bersihkan format Rp: 10.000 -> 10000)
    // Pastikan replace hanya jalan jika value ada
    const hargaRaw = hargaInput.value ? hargaInput.value.replace(/\./g, '').replace(/,/g, '.') : "0";
    const harga = parseFloat(hargaRaw) || 0;
    
    // 3. Ambil nilai asli database yang sudah kita inject di Langkah 1
    const pengeluaranDb = parseFloat(pengeluaranInput.getAttribute('data-db-value')) || 0;

    // 4. Hitung
    const hasilHitungUser = volume * harga;

    // 5. Logika Validasi
    // Kita cek apakah hasil input user menyimpang dari data DB?
    const selisih = Math.abs(hasilHitungUser - pengeluaranDb);

    // Toleransi 1 rupiah untuk pembulatan desimal
    if (selisih > 1) {
        // JIKA BEDA: Merah
        pengeluaranInput.style.backgroundColor = '#fff5f5';
        pengeluaranInput.style.borderColor = '#fc8181';
        pengeluaranInput.style.color = '#c53030';
        pengeluaranInput.style.fontWeight = 'bold';
        
        // Opsional: Tampilkan tooltip hasil hitungan user agar user sadar
        pengeluaranInput.title = `Hitungan saat ini: ${hasilHitungUser.toLocaleString('id-ID')}`;
    } else {
        // JIKA SAMA/VALID: Normal (atau hijau tipis)
        pengeluaranInput.style.backgroundColor = '#f8f9fa';
        pengeluaranInput.style.borderColor = '#e2e8f0'; // Warna border default modern
        pengeluaranInput.style.color = '#333';
        pengeluaranInput.style.fontWeight = 'normal';
        pengeluaranInput.title = "Valid";
    }
};

// ===============================
// FINAL – UPLOAD FOTO BUKTI (SUDAH SINKRON BACKEND)
// Endpoint backend:
// POST /kwitansi/{id}/upload-foto
// menerima:
// - files (multiple)
// - jenis_foto (string tunggal)
// ===============================

function previewFotoKwitansi(input, kwitansiId) {
    const previewContainer = document.getElementById("preview-foto-kwitansi");
    const files = Array.from(input.files || []);

    if (!previewContainer) return;

    const existingCount = previewContainer.querySelectorAll(".foto-item").length;
    if (existingCount + files.length > 15) {
        showToast("Error!", "Maksimal upload 15 foto bukti.");
        input.value = "";
        return;
    }

    const validFiles = files.filter(f => f.type.startsWith("image/"));
    if (validFiles.length !== files.length) {
        showToast("Error!", "Hanya file gambar yang diperbolehkan.");
        input.value = "";
        return;
    }

    // ===============================
    // PREVIEW SAJA (TANPA SELECT PER FOTO)
    // ===============================
    validFiles.forEach(file => {
        const reader = new FileReader();
        reader.onload = e => {
            const div = document.createElement("div");
            div.className = "foto-item";
            div.innerHTML = `
                <img src="${e.target.result}"
                     style="width:100%; height:80px; object-fit:cover;">
            `;
            previewContainer.appendChild(div);
        };
        reader.readAsDataURL(file);
    });

    // ===============================
    // UPLOAD KE BACKEND (FINAL & SINKRON)
    // ===============================
    setTimeout(async () => {
        const formData = new FormData();

        // ambil jenis foto GLOBAL (1 jenis = 1 upload)
        const jenisFoto = document.getElementById("jenis-foto").value;

        validFiles.forEach(file => {
            formData.append("files", file);
        });

        // ⬅⬅⬅ NAMA FIELD HARUS SAMA DENGAN BACKEND
        formData.append("jenis_foto", jenisFoto);

        try {
            const res = await fetch(
                `${API_BASE}/kwitansi/${kwitansiId}/upload-foto`,
                {
                    method: "POST",
                    body: formData
                }
            );

            const result = await res.json();
            if (result.status !== "success") {
                throw new Error(result.detail || "Upload gagal");
            }

            showToast("Berhasil!", "📷 Foto berhasil diupload");
            input.value = "";

            // refresh popup agar foto + label jenis muncul
            openUpdateDetailPopup(kwitansiId);

        } catch (err) {
            showToast("Error!", err.message || "Gagal upload foto");
            input.value = "";
        }
    }, 300);
}


window.generateGambarAIItem = async function (kwitansiId, rowIndex) {
    const row = document.querySelector(
        `.uraian-item-row[data-index="${rowIndex}"]`
    );

    if (!row) {
        showToast("Error!", "Baris barang tidak ditemukan");
        return;
    }

    const namaBarang = row.querySelector(".edit-uraian-nama")?.value?.trim();
    const volume = row.querySelector(".edit-uraian-vol")?.value;
    const satuan = row.querySelector(".edit-uraian-satuan")?.value?.trim();

    if (!namaBarang) {
        showToast("Error!", "Nama barang masih kosong");
        return;
    }

    // 🔥 PROMPT FINAL (ANTI RANDOM)
    let promptText = namaBarang;

    if (volume && volume > 0) {
        promptText = `${namaBarang} sebanyak ${volume} ${satuan || "buah"}`;
    }

    try {
        const res = await fetch(
            `${API_BASE}/kwitansi/${kwitansiId}/generate-ai-image`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt_items: promptText,
                    jenis_foto: "barang"
                })
            }
        );

        const result = await res.json();
        if (result.status !== "success") {
            throw new Error(result.detail || "Gagal generate AI");
        }

        openUpdateDetailPopup(kwitansiId);

    } catch (err) {
        showToast("Error!", err.message);
    }
};



function openUpdateDetailPopup(kwitansiId) {
    fetch(`${API_BASE}/kwitansi/${kwitansiId}`)
        .then(res => res.json())
        .then(k => {
            if (k.status !== "success") throw new Error("Gagal memuat detail");

            const kw = k.data;
            const uraian = kw.uraian || [];
            const fotoBukti = kw.foto_bukti || [];

            // -------------------------------
            // STYLE CSS INJECTION
            // -------------------------------
            const customStyle = `
                <style>
                    .popup-modern { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; }
                    .popup-header-modern { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
                    .popup-header-modern h3 { margin: 0; font-size: 1.25rem; color: #2c3e50; }
                    .badge-ref { background: #eef2f7; color: #4a69bd; padding: 4px 10px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; }
                    
                    .form-section { background: #f9f9f9; padding: 15px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #eee; }
                    .form-section-title { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 10px; font-weight: 700; display: block; }
                    
                    .modern-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
                    .form-group { margin-bottom: 12px; }
                    .form-group label { display: block; margin-bottom: 5px; font-weight: 500; font-size: 0.9rem; }
                    .form-control { width: 100%; padding: 8px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; transition: border 0.2s; box-sizing: border-box; }
                    .form-control:focus { border-color: #4a69bd; outline: none; box-shadow: 0 0 0 2px rgba(74, 105, 189, 0.1); }
                    
                    /* Table Styles */
                    .table-wrapper { overflow-x: auto; border: 1px solid #e0e0e0; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.02); }
                    .modern-table { width: 100%; border-collapse: collapse; font-size: 13px; }
                    .modern-table th { background: #f8f9fa; color: #495057; font-weight: 600; text-align: left; padding: 10px 12px; border-bottom: 2px solid #e9ecef; }
                    .modern-table td { padding: 8px; border-bottom: 1px solid #eee; vertical-align: middle; }
                    .modern-table input { border: 1px solid #e2e8f0; border-radius: 4px; padding: 6px; font-size: 13px; width: 100%; box-sizing: border-box; }
                    .modern-table input:focus { border-color: #4a69bd; }
                    .text-right { text-align: right; }
                    
                    /* Upload Area - Updated for Paste Support */
                    .upload-area { border: 2px dashed #cbd5e0; border-radius: 8px; padding: 20px; text-align: center; background: #fff; transition: 0.2s; position: relative; }
                    .upload-area:hover { border-color: #4a69bd; background: #f8fbff; }
                    .upload-area.highlight-paste { border-color: #2ecc71; background: #e8f8f5; } /* Visual cue saat paste */

                    .preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 10px; margin-top: 15px; }
                    .foto-item img { width: 100%; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid #ddd; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }

                    .popup-footer { margin-top: 25px; display: flex; justify-content: flex-end; gap: 10px; padding-top: 15px; border-top: 1px solid #eee; }
                    .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 14px; }
                    .btn-secondary { background: #e2e6ea; color: #444; }
                    .btn-success { background: #2ecc71; color: white; }
                    .btn-success:hover { background: #27ae60; }
                    
                    /* ===== FOTO GRID + TOMBOL HAPUS ===== */
                    .foto-item { position: relative; }
                    .foto-delete-btn {
                        position: absolute; top: 4px; right: 4px; width: 22px; height: 22px;
                        border-radius: 50%; border: none; background: rgba(220, 53, 69, 0.9);
                        color: #fff; font-size: 14px; font-weight: bold; cursor: pointer;
                        line-height: 22px; padding: 0; display: flex; align-items: center; justify-content: center;
                    }
                    .foto-delete-btn:hover { background: rgba(200, 35, 51, 1); }
                </style>
            `;

            // -------------------------------
            // RINCIAN BARANG / JASA (TABLE)
            // -------------------------------
            let uraianHtml = `
                <div class="table-wrapper">
                    <table class="modern-table">
                        <thead>
                            <tr>
                                <th style="width: 30%;">Nama Barang / Uraian</th>
                                <th style="width: 10%;">Volume</th>
                                <th style="width: 10%;">Satuan</th>
                                <th style="width: 25%;" class="text-right">Harga Satuan</th>
                                <th style="width: 25%;" class="text-right">Total Harga</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            uraian.forEach((u, index) => {
                const volume = Math.round(u.volume || 0);
                const harga = Number(u.harga_satuan || 0);
                const pengeluaran = Number(u.pengeluaran || 0);
                const isValid = pengeluaran === (volume * harga);
                const validationStyle = isValid 
                    ? "background-color: #f8f9fa;" 
                    : "background-color: #fff5f5; border-color: #fc8181; color: #c53030; font-weight:bold;";

                uraianHtml += `
                    <tr class="uraian-item-row" data-index="${index}">
                        <td><input type="text" class="edit-uraian-nama" value="${u.nama_barang || ""}" placeholder="Nama Item..."></td>
                        <td><input type="number" class="edit-uraian-vol text-center" value="${volume}" oninput="updateValidasiPengeluaran(this)"></td>
                        <td><input type="text" class="edit-uraian-satuan text-center" value="${u.satuan || ""}"></td>
                        <td>
                            <input type="text" class="edit-uraian-harga text-right"
                                   value="${harga.toLocaleString("id-ID")}"
                                   oninput="formatCurrencyID(this); updateValidasiPengeluaran(this)">
                        </td>
                        <td style="display:flex; gap:6px; align-items:center;">
                            <input type="text"
                                   class="edit-uraian-pengeluaran text-right"
                                   value="${pengeluaran.toLocaleString("id-ID")}"
                                   data-db-value="${pengeluaran}"
                                   style="${validationStyle}"
                                   readonly>
                            <button type="button" class="btn btn-secondary" style="padding:4px 6px; font-size:11px;"
                                    title="Generate Foto AI untuk barang ini"
                                    onclick="generateGambarAIItem(${kwitansiId}, ${index})">
                                🤖
                            </button>
                        </td>
                    </tr>
                `;
            });

            uraianHtml += `</tbody></table></div>`;

            // -------------------------------
            // POPUP HTML CONSTRUCTION
            // -------------------------------
            const formHtml = `
                ${customStyle}
                <div class="popup-content popup-modern">
                    
                    <div class="popup-header-modern">
                        <div>
                            <h3>Update Transaksi</h3>
                            <small style="color:#888;">Edit detail kelengkapan kwitansi</small>
                        </div>
                        <span class="badge-ref">#${kw.nomor_kwitansi || "Draft"}</span>
                    </div>

                    <div class="popup-body">
                        
                        <div class="form-section">
                            <span class="form-section-title">Informasi Kegiatan</span>
                            <div class="form-group">
                                <label>Nama Kegiatan</label>
                                <input id="edit-nama-kegiatan" class="form-control" value="${kw.nama_kegiatan || ""}" placeholder="Masukkan nama kegiatan...">
                            </div>

                            <div class="modern-grid">
                                <div class="form-group">
                                    <label>Nomor BAST</label>
                                    <input id="edit-no-bast" class="form-control" value="${kw.no_bast || ""}">
                                </div>
                                <div class="form-group">
                                    <label>Tanggal Nota</label>
                                    <input type="date" id="edit-tanggal-nota" class="form-control" value="${kw.tanggal_nota || ""}">
                                </div>
                            </div>
                        </div>

                        <div class="form-section">
                            <span class="form-section-title">Data Toko / Penerima</span>
                            <div class="form-group">
                                <label>Nama Toko / Penerima</label>
                                <input id="edit-nama-toko" class="form-control" value="${kw.nama_toko || ""}">
                            </div>

                            <div class="modern-grid">
                                <div class="form-group">
                                    <label>NPWP / NIK</label>
                                    <input id="edit-npwp-toko" class="form-control" value="${kw.npwp_toko || ""}">
                                </div>
                                <div class="form-group">
                                    <label>Alamat Toko</label>
                                    <input id="edit-alamat-toko" class="form-control" value="${kw.alamat_toko || ""}">
                                </div>
                            </div>
                        </div>

                        <div style="margin-top:20px; margin-bottom: 25px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                <label style="font-weight:700; font-size:1rem;">📦 Rincian Barang/Jasa</label>
                            </div>
                            ${uraianHtml}
                        </div>

                        <div class="upload-area" id="drop-area-foto">
                            <label style="font-weight:600; display:block; margin-bottom:8px;">
                                📷 Foto Bukti / Dokumentasi
                            </label>
                            <small style="color:#666; display:block; margin-bottom:10px;">
                                Upload manual, <b>Paste (Ctrl+V)</b>, atau generate dari AI. (Max 15)
                            </small>

                            <select id="jenis-foto" class="form-control"
                                    style="max-width:220px; margin:10px auto;">
                                <option value="barang">📦 Barang</option>
                                <option value="kegiatan">📍 Kegiatan</option>
                                <option value="sebelum">⏪ Sebelum</option>
                                <option value="proses">⚙️ Proses</option>
                                <option value="sesudah">✅ Sesudah</option>
                            </select>

                            <input type="file"
                                   id="upload-foto-kwitansi"
                                   class="form-control"
                                   style="max-width:300px; margin:0 auto 12px;"
                                   multiple
                                   accept="image/*" 
                                   onchange="previewFotoKwitansi(this, ${kwitansiId})">
                                   
                            <div id="preview-foto-kwitansi" class="preview-grid"></div>
                        </div>

                        <div class="popup-footer">
                            <button class="btn btn-secondary" onclick="closePopup()">Batal</button>
                            <button class="btn btn-success" onclick="saveUpdateDetail(${kwitansiId})">
                                <span style="margin-right:5px;">💾</span> Simpan Perubahan
                            </button>
                        </div>
                    </div>
                </div>
            `;

            // --- EKSEKUSI POPUP ---
            showPopup(formHtml);

            // ==========================================
            // LOGIKA BARU: HANDLE PASTE (CTRL+V) IMAGE
            // ==========================================
            setTimeout(() => {
                const uploadInput = document.getElementById("upload-foto-kwitansi");
                const uploadArea = document.getElementById("drop-area-foto");

                if (uploadInput && uploadArea) {
                    // Handler agar user bisa klik area box untuk upload
                    uploadArea.addEventListener("click", (e) => {
                         // Cegah loop jika user klik langsung di input file atau select
                        if (e.target !== uploadInput && e.target.id !== 'jenis-foto') {
                            uploadInput.click();
                        }
                    });

                    // Handler Global Paste untuk jendela ini
                    // Menggunakan event handler yang otomatis terhapus saat popup tertutup (secara UI)
                    // karena elemen-nya hilang.
                    const pasteHandler = function(event) {
                        // Cek apakah input masih ada di dokumen (popup masih buka)
                        if(!document.body.contains(uploadInput)) return;

                        const items = (event.clipboardData || event.originalEvent.clipboardData).items;
                        let blob = null;

                        // Cari item yang berupa gambar
                        for (let i = 0; i < items.length; i++) {
                            if (items[i].type.indexOf("image") === 0) {
                                blob = items[i].getAsFile();
                                break;
                            }
                        }

                        if (blob) {
                            // Efek Visual
                            uploadArea.classList.add("highlight-paste");
                            setTimeout(() => uploadArea.classList.remove("highlight-paste"), 500);

                            // Buat container file baru
                            const dataTransfer = new DataTransfer();
                            
                            // Beri nama file unik
                            const ext = blob.type.split("/")[1];
                            const file = new File([blob], `pasted_image_${Date.now()}.${ext}`, { type: blob.type });
                            
                            dataTransfer.items.add(file);
                            uploadInput.files = dataTransfer.files;

                            // Trigger fungsi preview bawaan
                            // Memanggil onchange secara manual
                            if(uploadInput.onchange) {
                                uploadInput.dispatchEvent(new Event('change'));
                            }
                            
                            if (typeof showToast === 'function') {
                                showToast("Sukses", "Foto dari clipboard berhasil ditempel!");
                            }
                        }
                    };

                    // Pasang listener pada window agar user tidak perlu fokus ke input
                    window.addEventListener('paste', pasteHandler, { once: false });
                }
            }, 500); // Delay sedikit memastikan elemen render

            // -------------------------------
            // RENDER FOTO DARI DATABASE
            // -------------------------------
            const preview = document.getElementById("preview-foto-kwitansi");
            if(preview) preview.innerHTML = ""; 

            let daftarFoto = [];

            // ===============================
            // NORMALISASI FOTO BUKTI
            // ===============================
            if (fotoBukti) {
                // ... (Logic normalisasi sama seperti kode asli Anda) ...
                if (typeof fotoBukti === "object" && !Array.isArray(fotoBukti)) {
                    Object.keys(fotoBukti).forEach(jenis => {
                        if (Array.isArray(fotoBukti[jenis])) {
                            fotoBukti[jenis].forEach(f => {
                                if (typeof f === "string") {
                                    daftarFoto.push({ path: f, jenis });
                                } else {
                                    daftarFoto.push({ path: f.path, jenis: f.jenis || jenis });
                                }
                            });
                        }
                    });
                } else if (Array.isArray(fotoBukti)) {
                    fotoBukti.forEach(f => {
                        if (typeof f === "string") {
                            daftarFoto.push({ path: f, jenis: "barang" });
                        } else {
                            daftarFoto.push({ path: f.path, jenis: f.jenis || "barang" });
                        }
                    });
                } else if (typeof fotoBukti === "string") {
                    try {
                        const parsed = JSON.parse(fotoBukti);
                        parsed.forEach(f => {
                            if (typeof f === "string") {
                                daftarFoto.push({ path: f, jenis: "barang" });
                            } else {
                                daftarFoto.push({ path: f.path, jenis: f.jenis || "barang" });
                            }
                        });
                    } catch {
                        fotoBukti.split(",").forEach(f => {
                            daftarFoto.push({ path: f.replace(/[\[\]"]/g, ""), jenis: "barang" });
                        });
                    }
                }
            }

            // ===============================
            // RENDER FOTO
            // ===============================
            const serverRoot = API_BASE.replace(/\/api\/?$/, "");

            if (daftarFoto.length > 0) {
                daftarFoto.forEach((foto, index) => {
                    if (!foto.path) return;
                    const fullUrl = `${serverRoot}/${foto.path}`;
                    const div = document.createElement("div");
                    div.className = "foto-item";
                    div.innerHTML = `
                        <button class="foto-delete-btn"
                            onclick="event.stopPropagation(); deleteExistingFoto(${kwitansiId}, ${index})">
                            ×
                        </button>
                        <span style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,.65); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; text-transform:uppercase;">
                            ${foto.jenis}
                        </span>
                        <img src="${fullUrl}" style="width:100%; height:80px; object-fit:cover; cursor:pointer;" onclick="window.open('${fullUrl}', '_blank')">
                    `;
                    preview.appendChild(div);
                });
            } else {
                preview.innerHTML = `
                    <p style="grid-column:1/-1; color:#bbb; font-size:12px; text-align:center;">
                        Tidak ada foto tersimpan
                    </p>
                `;
            }
        })
        .catch(err => showToast("Error!", err.message));
}

// --- Manual BKU Form ---
async function openManualBKUForm() {
    // 1. Ensure refs loaded (LOGIKA TIDAK DIUBAH)
    if (!Array.isArray(masterKegiatan) || masterKegiatan.length === 0) await loadMasterKegiatan();
    if (!Array.isArray(masterRekeningBelanja) || masterRekeningBelanja.length === 0) await loadMasterRekeningBelanja();

    const kegiatanOptionsDatalist = (masterKegiatan || []).map(k => `<option value="${k.kode_kegiatan} - ${k.nama_kegiatan}"></option>`).join('');
    const rekeningOptionsDatalist = (masterRekeningBelanja || []).map(r => `<option value="${r.kode_rekening_belanja} - ${r.nama_rekening_belanja}"></option>`).join('');

    // expose arrays for parsing / resolving user input
    window._manualMasterKegiatan = masterKegiatan || [];
    window._manualMasterRekening = masterRekeningBelanja || []; 

    // -------------------------------
    // STYLE CSS INJECTION (Agar fitur Copy-Paste & Tampilan konsisten)
    // -------------------------------
    const customStyle = `
        <style>
            /* Upload Area Styles */
            .upload-area { border: 2px dashed #cbd5e0; border-radius: 8px; padding: 20px; text-align: center; background: #fffcf5; transition: 0.2s; position: relative; }
            .upload-area:hover { border-color: #4a69bd; background: #f0f7ff; }
            .upload-area.highlight-paste { border-color: #2ecc71; background: #e8f8f5; } /* Visual cue saat paste */

            .preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 10px; margin-top: 15px; }
            
            /* Tombol Hapus pada Preview (jika renderManualBKUPreview menggunakannya) */
            .foto-item { position: relative; }
            .foto-delete-btn {
                position: absolute; top: -5px; right: -5px; width: 20px; height: 20px;
                border-radius: 50%; background: red; color: white; border: none;
                cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px;
            }
        </style>
    `;

    // 2. Form HTML (TAMPILAN DIPERBAIKI)
    const formHtml = `
        ${customStyle}
        <div class="popup-content" style="max-height:85vh; overflow-y:auto; border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,0.18);">
            <div style="padding:28px; max-width:1200px; width:94%; box-sizing:border-box; background: #fff; font-size:14px;">
                
                <div style="border-bottom: 2px solid #f0f0f0; padding-bottom: 15px; margin-bottom: 20px;">
                    <h3 style="margin:0; color:#333; font-weight:600;">Tambah Data BKU Manual</h3>
                    <small style="color:#666;">Isi formulir di bawah ini dengan lengkap.</small>
                </div>

                <h5 style="color:#007bff; margin-bottom:10px; border-left: 4px solid #007bff; padding-left: 8px;">A. Informasi Transaksi</h5>
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:15px; margin-bottom: 20px;">
                    <div class="form-group">
                        <label style="font-weight:500; font-size:0.9em;">No Bukti <span style="color:red">*</span></label>
                        <input id="manual-no-bukti" class="form-control" required style="border:1px solid #ddd;">
                    </div>
                    <div class="form-group">
                        <label style="font-weight:500; font-size:0.9em;">Tanggal Kwitansi</label>
                        <input id="manual-tanggal" type="date" class="form-control" style="border:1px solid #ddd;">
                    </div>
                    <div class="form-group">
                        <label style="font-weight:500; font-size:0.9em;">Tanggal Nota</label>
                        <input id="manual-tanggal-nota" type="date" class="form-control" style="border:1px solid #ddd;">
                    </div>
                    <div class="form-group">
                        <label style="font-weight:500; font-size:0.9em;">No BAST</label>
                        <input id="manual-no-bast" class="form-control" style="border:1px solid #ddd;">
                    </div>
                </div>

                <div style="display:grid; grid-template-columns: 1fr; gap:15px; margin-bottom: 20px;">
                    <div class="form-group">
                        <label style="font-weight:500; font-size:0.9em;">Nama Kegiatan</label>
                        <input id="manual-kode-kegiatan" class="form-control" style="border:1px solid #ddd;" placeholder="Ketik kode atau nama..." list="manual-kegiatan-list" autocomplete="off">
                        <datalist id="manual-kegiatan-list">
                            <option value="">-- Pilih Kegiatan --</option>
                            ${kegiatanOptionsDatalist}
                        </datalist>
                    </div>
                    <div class="form-group">
                        <label style="font-weight:500; font-size:0.9em;">Rekening Belanja</label>
                        <input id="manual-kode-rekening" class="form-control" style="border:1px solid #ddd;" placeholder="Ketik kode atau nama..." list="manual-rekening-list" autocomplete="off">
                        <datalist id="manual-rekening-list">
                            <option value="">-- Pilih Rekening --</option>
                            ${rekeningOptionsDatalist}
                        </datalist>
                    </div> 
                </div>

                <h5 style="color:#007bff; margin-bottom:10px; border-left: 4px solid #007bff; padding-left: 8px; margin-top:25px;">B. Data Penyedia / Toko</h5>
                <div style="background: #f9f9f9; padding: 15px; border-radius: 6px; border: 1px solid #eee;">
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px;">
                        <div class="form-group">
                            <label style="font-weight:500; font-size:0.9em;">Nama Toko</label>
                            <input id="manual-nama-toko" class="form-control">
                        </div>
                        <div class="form-group">
                            <label style="font-weight:500; font-size:0.9em;">NPWP</label>
                            <input id="manual-npwp" class="form-control">
                        </div>
                        <div class="form-group" style="grid-column: 1 / -1;">
                            <label style="font-weight:500; font-size:0.9em;">Alamat</label>
                            <input id="manual-alamat" class="form-control">
                        </div>
                    </div>
                </div>

                <div style="margin-top:25px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h5 style="color:#007bff; margin:0; border-left: 4px solid #007bff; padding-left: 8px;">C. Rincian Belanja</h5>
                    <button class="btn btn-sm btn-primary" onclick="addManualUraianRow()" style="border-radius:20px; padding: 5px 15px;">
                        <i class="fa fa-plus"></i> ＋ Tambah Baris
                    </button>
                </div>

                <div style="max-height:420px; overflow:auto; border:1px solid #e6e6e6; border-radius:8px; box-shadow: inset 0 1px 6px rgba(0,0,0,0.06);">
                    <table style="width:100%; border-collapse:collapse; font-size:0.9em;" id="manual-uraian-table" class="table table-striped">
                        <thead style="background:#f1f1f1; position:sticky; top:0; z-index:1;">
                            <tr>
                                <th style="width:50%; min-width:380px; padding:10px; border-bottom:2px solid #ddd;">Nama Barang</th>
                                <th style="width:8%; min-width:80px; padding:10px; border-bottom:2px solid #ddd; text-align:center;">Volume</th>
                                <th style="width:8%; min-width:80px; padding:10px; border-bottom:2px solid #ddd; text-align:center;">Satuan</th>
                                <th style="width:16%; min-width:120px; padding:10px; border-bottom:2px solid #ddd; text-align:right;">Harga</th>
                                <th style="width:16%; min-width:140px; padding:10px; border-bottom:2px solid #ddd; text-align:right;">Total</th>
                                <th style="width:50px; min-width:50px; padding:10px; border-bottom:2px solid #ddd; text-align:center;">#</th>
                            </tr>
                        </thead>
                        <tbody style="background: white;">
                            </tbody>
                    </table>
                </div>

                <div style="display:flex; justify-content:flex-end; margin-top:8px; margin-bottom:6px;">
                    <div style="font-weight:700; font-size:1rem;">
                        Sub Total: <span id="manual-uraian-subtotal">Rp 0</span>
                    </div>
                </div>

                <h5 style="color:#007bff; margin-bottom:10px; border-left: 4px solid #007bff; padding-left: 8px; margin-top:25px;">D. Dokumentasi & Bukti</h5>
                
                <div class="upload-area" id="manual-drop-area">
                    <label style="font-weight:600; display:block; margin-bottom:5px;">
                        📷 Foto Bukti / Dokumentasi
                    </label>
                    <small style="color:#666; display:block; margin-bottom:12px;">
                        Klik untuk upload, atau <b>Paste (Ctrl+V)</b> gambar di sini. (Max 15)
                    </small>

                    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:10px;">
                        <div style="width: 200px;">
                            <select id="manual-jenis-foto" class="form-control" style="text-align:center;">
                                <option value="barang">📦 Barang</option>
                                <option value="kegiatan">📍 Kegiatan</option>
                                <option value="sebelum">⏪ Sebelum</option>
                                <option value="proses">⚙️ Proses</option>
                                <option value="sesudah">✅ Sesudah</option>
                            </select>
                        </div>
                    </div>

                    <input type="file" 
                           id="manual-bku-foto" 
                           accept="image/*" 
                           multiple 
                           class="form-control" 
                           style="max-width:300px; margin:0 auto;"
                           onchange="handleManualBKUPhotos(this)">
                    
                    <div id="manual-bku-counter" style="font-size:11px; color:#888; margin-top:4px; font-style:italic; display:none;">Maksimal 15 foto.</div>
                    
                    <div id="manual-bku-preview" class="preview-grid"></div>
                </div>

                <div style="margin-top:30px; padding-top:15px; border-top:1px solid #eee; display:flex; gap:10px; justify-content:flex-end;">
                    <button class="btn btn-secondary" onclick="closePopup()" style="padding: 8px 20px;">Batal</button>
                    <button class="btn btn-success" onclick="saveManualBKU()" style="padding: 8px 25px; font-weight:bold;">
                        <span style="margin-right:5px;">💾</span> Simpan Data
                    </button>
                </div>
            </div>
        </div>
    `;

    showPopup(formHtml);
    
    // 3. Initialize Logic (TIDAK DIUBAH)
    window.manualBKUFiles = [];
    // Reset jika sebelumnya ada sisa
    if (window.renderManualBKUPreview) window.renderManualBKUPreview();

    // ==========================================
    // LOGIKA BARU: HANDLE PASTE (CTRL+V) IMAGE
    // ==========================================
    setTimeout(() => {
        const uploadInput = document.getElementById("manual-bku-foto");
        const uploadArea = document.getElementById("manual-drop-area");

        if (uploadInput && uploadArea) {
            
            // Klik area kotak untuk trigger upload
            uploadArea.addEventListener("click", (e) => {
                // Jangan trigger jika yang diklik adalah input itu sendiri atau select atau tombol hapus
                if (e.target !== uploadInput && 
                    e.target.id !== 'manual-jenis-foto' && 
                    !e.target.classList.contains('foto-delete-btn')) {
                    uploadInput.click();
                }
            });

            // Handler Global Paste untuk jendela ini
            const pasteHandler = function(event) {
                // Cek apakah input masih ada di dokumen (popup masih buka)
                if(!document.body.contains(uploadInput)) return;

                const items = (event.clipboardData || event.originalEvent.clipboardData).items;
                let blob = null;

                // Cari item yang berupa gambar
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf("image") === 0) {
                        blob = items[i].getAsFile();
                        break;
                    }
                }

                if (blob) {
                    // Efek Visual
                    uploadArea.classList.add("highlight-paste");
                    setTimeout(() => uploadArea.classList.remove("highlight-paste"), 500);

                    // Buat container file baru
                    const dataTransfer = new DataTransfer();
                    
                    // Beri nama file unik
                    const ext = blob.type.split("/")[1];
                    const file = new File([blob], `pasted_manual_${Date.now()}.${ext}`, { type: blob.type });
                    
                    dataTransfer.items.add(file);
                    uploadInput.files = dataTransfer.files;

                    // Trigger fungsi preview bawaan (handleManualBKUPhotos)
                    if(uploadInput.onchange) {
                        uploadInput.dispatchEvent(new Event('change'));
                    }
                    
                    if (typeof showToast === 'function') {
                        showToast("Sukses", "Foto dari clipboard berhasil ditempel!");
                    }
                }
            };

            // Pasang listener pada window
            window.addEventListener('paste', pasteHandler, { once: false });
        }

        // Setup resolver listeners for searchable inputs
        try {
            const kegInput = document.getElementById('manual-kode-kegiatan');
            const rekInput = document.getElementById('manual-kode-rekening');
            if (kegInput) {
                kegInput.addEventListener('blur', () => window.resolveManualKegiatanInput && window.resolveManualKegiatanInput());
                kegInput.addEventListener('keydown', e => { if (e.key === 'Enter') window.resolveManualKegiatanInput && window.resolveManualKegiatanInput(); });
            }
            if (rekInput) {
                rekInput.addEventListener('blur', () => window.resolveManualRekeningInput && window.resolveManualRekeningInput());
                rekInput.addEventListener('keydown', e => { if (e.key === 'Enter') window.resolveManualRekeningInput && window.resolveManualRekeningInput(); });
            }
        } catch(e) { /* ignore */ }

    }, 100);

    // add initial row
    addManualUraianRow(); 
}

function addManualUraianRow() {
    const tbody = document.querySelector('#manual-uraian-table tbody');
    if (!tbody) return;

    const row = document.createElement('tr');
    row.className = 'manual-uraian-row';
    
    // Style standar untuk input dalam tabel agar rapi
    const inputStyle = "width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px; border:1px solid #ddd; border-radius:4px;";
    
    // Style khusus Readonly (Total)
    const readonlyStyle = inputStyle + " background-color:#f9f9f9; border-color:#eee; font-weight:600; color:#333;";

    row.innerHTML = `
        <td style="padding: 8px 5px;">
            <input class="form-control manual-uraian-nama" 
                   placeholder="Nama barang / uraian" 
                   style="${inputStyle}">
        </td>
        <td style="padding: 8px 5px;">
            <input type="number" 
                   class="form-control manual-uraian-volume" 
                   value="1" 
                   oninput="updateManualUraianTotal(this)" 
                   style="${inputStyle} text-align:center;">
        </td>
        <td style="padding: 8px 5px;">
            <input class="form-control manual-uraian-satuan" 
                   placeholder="satuan" 
                   style="${inputStyle} text-align:center;">
        </td>
        <td style="padding: 8px 5px;">
            <input class="form-control manual-uraian-harga" 
                   placeholder="0" 
                   oninput="formatCurrencyID(this); updateManualUraianTotal(this)" 
                   style="${inputStyle} text-align:right;">
        </td>
        <td style="padding: 8px 5px;">
            <input class="form-control manual-uraian-pengeluaran" 
                   placeholder="0" 
                   readonly 
                   data-db-value="0" 
                   style="${readonlyStyle} text-align:right;">
        </td>
        <td style="padding: 8px 5px; text-align:center; vertical-align: middle;">
            <button class="btn btn-sm btn-outline-danger" 
                    onclick="deleteManualUraianRow(this)"
                    style="border-radius: 50%; width: 28px; height: 28px; padding: 0; line-height: 26px; display: inline-flex; align-items: center; justify-content: center;">
                ✕
            </button>
        </td>
    `;

    tbody.appendChild(row);
    
    // Inisialisasi hitungan (agar 0 atau 1 langsung terformat)
    try { 
        updateManualUraianTotal(row.querySelector('.manual-uraian-volume')); 
        updateManualUraianSubtotal(); 
    } catch (e) { /* ignore */ }
}

// Compute and set pengeluaran = volume * harga (formatted).
window.updateManualUraianTotal = function(el) {
    const row = el ? el.closest('tr') : null;
    if (!row) return;

    const volInput = row.querySelector('.manual-uraian-volume');
    const hargaInput = row.querySelector('.manual-uraian-harga');
    const pengeluaranInput = row.querySelector('.manual-uraian-pengeluaran');

    const volume = parseFloat(volInput.value) || 0;
    // Hapus titik ribuan sebelum kalkulasi
    const hargaRaw = hargaInput.value ? hargaInput.value.toString().replace(/\./g, '').replace(/,/g, '.') : '0';
    const harga = parseFloat(hargaRaw) || 0;
    const total = volume * harga;

    // Format hasil ke Rupiah (1.000.000)
    pengeluaranInput.value = Number(total).toLocaleString('id-ID');
    pengeluaranInput.setAttribute('data-db-value', total);

    // Update subtotal whenever a row changes
    if (window.updateManualUraianSubtotal) window.updateManualUraianSubtotal();
}

// Calculate subtotal for all uraian rows and show formatted value
window.updateManualUraianSubtotal = function() {
    const rows = document.querySelectorAll('.manual-uraian-row');
    let sum = 0;
    rows.forEach(r => {
        const input = r.querySelector('.manual-uraian-pengeluaran');
        if (!input) return;
        const dbVal = parseFloat(input.getAttribute('data-db-value'));
        if (!isNaN(dbVal)) {
            sum += dbVal;
        } else {
            const raw = (input.value || '0').toString().replace(/\./g, '').replace(/,/g, '.');
            sum += parseFloat(raw) || 0;
        }
    });
    const el = document.getElementById('manual-uraian-subtotal');
    if (el && window.formatCurrencyLabel) el.textContent = window.formatCurrencyLabel(sum);
}

window.deleteManualUraianRow = function(btn) {
    const tr = btn.closest('tr');
    if (tr) tr.remove();
    if (window.updateManualUraianSubtotal) window.updateManualUraianSubtotal();
}

// Helper: parse input value into kode (supports "CODE - Name", code, name, partial matches)
function parseManualKode(inputId, listArray) {
    try {
        if (!inputId || !listArray || !Array.isArray(listArray)) return '';
        const el = document.getElementById(inputId);
        if (!el) return '';
        const v = (el.value || '').trim();
        if (!v) return '';
        // If typed as "CODE - Name", return the code part
        if (v.includes(' - ')) return v.split(' - ')[0].trim();
        const lower = v.toLowerCase();
        const kodeKey = listArray[0] && listArray[0].kode_kegiatan ? 'kode_kegiatan' : 'kode_rekening_belanja';
        const nameKey = listArray[0] && listArray[0].nama_kegiatan ? 'nama_kegiatan' : 'nama_rekening_belanja';
        // exact code match
        let found = listArray.find(i => (i[kodeKey] || '').toLowerCase() === lower);
        if (found) return found[kodeKey];
        // exact name match
        found = listArray.find(i => (i[nameKey] || '').toLowerCase() === lower);
        if (found) return found[kodeKey];
        // partial match: code contains or name contains
        found = listArray.find(i => (i[kodeKey] || '').toLowerCase().includes(lower) || (i[nameKey] || '').toLowerCase().includes(lower));
        return found ? found[kodeKey] : '';
    } catch (e) {
        return '';
    }
}

// Auto-resolve and normalize input to "CODE - Name" when possible
window.resolveManualKegiatanInput = function() {
    const el = document.getElementById('manual-kode-kegiatan');
    if (!el) return;
    const kode = parseManualKode('manual-kode-kegiatan', window._manualMasterKegiatan);
    if (!kode) return;
    const found = (window._manualMasterKegiatan || []).find(k => k.kode_kegiatan === kode);
    if (found) el.value = `${found.kode_kegiatan} - ${found.nama_kegiatan}`;
}

window.resolveManualRekeningInput = function() {
    const el = document.getElementById('manual-kode-rekening');
    if (!el) return;
    const kode = parseManualKode('manual-kode-rekening', window._manualMasterRekening);
    if (!kode) return;
    const found = (window._manualMasterRekening || []).find(r => r.kode_rekening_belanja === kode);
    if (found) el.value = `${found.kode_rekening_belanja} - ${found.nama_rekening_belanja}`;
}

async function saveManualBKU() {
    try {
        const no_bukti = document.getElementById('manual-no-bukti').value.trim();
        if (!no_bukti) { showToast('Error!', 'No Bukti wajib diisi'); return; }

        const kode_kegiatan = parseManualKode('manual-kode-kegiatan', window._manualMasterKegiatan);
        const kode_rekening = parseManualKode('manual-kode-rekening', window._manualMasterRekening);
        const tanggal = document.getElementById('manual-tanggal').value || '';
        const tanggal_nota = document.getElementById('manual-tanggal-nota').value || '';
        const no_bast = document.getElementById('manual-no-bast').value || '';
        const nama_toko = document.getElementById('manual-nama-toko').value || '';
        const npwp = document.getElementById('manual-npwp').value || '';
        const alamat = document.getElementById('manual-alamat').value || '';
        const jenis_foto = document.getElementById('manual-jenis-foto').value || 'barang';

        const rows = Array.from(document.querySelectorAll('.manual-uraian-row'));
        const uraian = rows.map(r => {
            const nama = r.querySelector('.manual-uraian-nama').value || '';
            const vol = parseFloat(r.querySelector('.manual-uraian-volume').value) || 0;
            const satuan = r.querySelector('.manual-uraian-satuan').value || '';
            const hargaRaw = r.querySelector('.manual-uraian-harga').value || '0';
            const harga = parseFloat(hargaRaw.toString().replace(/\./g, '').replace(/,/g, '.')) || 0;
            const pengeluaran = parseFloat((r.querySelector('.manual-uraian-pengeluaran').value || '0').toString().replace(/\./g, '').replace(/,/g, '.')) || 0;
            return { nama_barang: nama, volume: vol, satuan: satuan, harga_satuan: harga, pengeluaran: pengeluaran };
        }).filter(i => i.nama_barang || i.pengeluaran > 0);

        if (uraian.length === 0) { showToast('Error!', 'Tambahkan minimal satu uraian belanja'); return; }

        const formData = new FormData();
        formData.append('no_bukti', no_bukti);
        formData.append('kode_kegiatan', kode_kegiatan);
        formData.append('kode_rekening', kode_rekening);
        formData.append('tanggal', tanggal);
        formData.append('tanggal_nota', tanggal_nota);
        formData.append('no_bast', no_bast);
        formData.append('nama_toko', nama_toko);
        formData.append('npwp_toko', npwp);
        formData.append('alamat_toko', alamat);
        formData.append('uraian_json', JSON.stringify(uraian));
        formData.append('jenis_foto', jenis_foto);

        // Attach photos: prefer in-memory buffer (user can remove previews) else fallback to file input
        if (window.manualBKUFiles && window.manualBKUFiles.length > 0) {
            window.manualBKUFiles.forEach(f => formData.append('files', f));
        } else {
            const fotoInput = document.getElementById('manual-bku-foto');
            if (fotoInput && fotoInput.files && fotoInput.files.length > 0) {
                Array.from(fotoInput.files).forEach(f => formData.append('files', f));
            }
        }

        showToast('info!', 'Menyimpan data...');
        const res = await fetch(`${API_BASE}/kwitansi/manual`, { method: 'POST', body: formData });
        const json = await res.json();
        if (json.status !== 'success') { showToast('Error!', json.detail || 'Gagal menyimpan'); return; }

        showToast('Berhasil!', json.message || 'Data berhasil disimpan');
        closePopup();
        loadKwitansiList();
        loadDataBKU();

    } catch (err) {
        showToast('Error!', err.message || 'Terjadi kesalahan');
    }
}

// ==========================================
// 1. HANDLE PHOTO INPUT (FIXED)
// ==========================================
window.handleManualBKUPhotos = function(input) {
    // Pastikan array global ada
    if (!window.manualBKUFiles) window.manualBKUFiles = [];

    // Ambil elemen select untuk jenis foto (PENTING: Ambil value saat upload)
    const jenisSelect = document.getElementById("manual-jenis-foto");
    const currentJenis = jenisSelect ? jenisSelect.value : "barang";

    const files = Array.from(input.files || []);

    for (const f of files) {
        // 1. Validasi Tipe File
        if (!f.type.startsWith('image/')) {
            if(typeof showToast === 'function') showToast('Error!', 'Hanya file gambar yang diperbolehkan');
            continue;
        }

        // 2. Validasi Jumlah Maksimal
        if (window.manualBKUFiles.length >= 15) {
            if(typeof showToast === 'function') showToast('Error!', 'Maksimal 15 foto');
            break;
        }

        // 3. PUSH OBJECT LENGKAP (BUKAN HANYA FILE)
        // Kita simpan url blob di sini agar konsisten
        window.manualBKUFiles.push({
            file: f,                        // File asli untuk diupload nanti
            jenis: currentJenis,            // Jenis foto (barang/kegiatan/dll)
            previewUrl: URL.createObjectURL(f) // URL untuk preview di <img>
        });
    }

    // Reset input agar user bisa memilih file yang sama jika perlu
    try { input.value = ''; } catch (e) { /* ignore */ }
    
    // Render tampilan
    if (window.renderManualBKUPreview) window.renderManualBKUPreview();
}

// ==========================================
// 2. RENDER PREVIEW (MATCHING DATA STRUCTURE)
// ==========================================
window.renderManualBKUPreview = function() {
    const container = document.getElementById('manual-bku-preview');
    const counter = document.getElementById('manual-bku-counter');
    
    if (!container) return;
    container.innerHTML = '';

    const listFoto = window.manualBKUFiles || [];

    listFoto.forEach((item, idx) => {
        // item sekarang adalah object {file, jenis, previewUrl}
        const url = item.previewUrl; 
        const jenisLabel = item.jenis || "barang";

        const div = document.createElement('div');
        div.className = 'foto-item'; 
        
        // Inject HTML
        div.innerHTML = `
            <button class="foto-delete-btn" 
                type="button"
                onclick="event.stopPropagation(); deleteManualBKUPhoto(${idx})"
                title="Hapus Foto">
                ×
            </button>

            <span style="
                position:absolute;
                bottom:4px;
                left:4px;
                background:rgba(0,0,0,.65);
                color:#fff;
                font-size:10px;
                padding:2px 6px;
                border-radius:4px;
                text-transform:uppercase;">
                ${jenisLabel}
            </span>

            <img src="${url}" 
                 style="width:100%; height:80px; object-fit:cover; border-radius:6px; border:1px solid #ddd; cursor:pointer;" 
                 onclick="window.open('${url}', '_blank')">
        `;

        container.appendChild(div);
    });

    // Update Counter Text
    if (counter) {
        counter.style.display = 'block';
        counter.innerHTML = listFoto.length > 0 
            ? `${listFoto.length} / 15 foto terpilih` 
            : `Maksimal 15 foto.`;
        
        counter.style.color = listFoto.length >= 15 ? 'red' : '#888';
    }
}

// ==========================================
// 3. DELETE PHOTO (CLEANUP MEMORY)
// ==========================================
window.deleteManualBKUPhoto = function(index) {
    if (!window.manualBKUFiles) return;
    
    // Hapus URL Blob dari memory browser agar tidak memory leak
    const item = window.manualBKUFiles[index];
    if (item && item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
    }

    // Hapus dari array
    window.manualBKUFiles.splice(index, 1);
    
    // Render ulang
    if (window.renderManualBKUPreview) window.renderManualBKUPreview();
}


async function deleteExistingFoto(kwitansiId, index) {

    try {
        const response = await fetch(`${API_BASE}/kwitansi/${kwitansiId}/foto/${index}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem("token")}` // jika pakai auth
            }
        });

        const result = await response.json();

        if (result.status === "success") {
            alert("Foto berhasil dihapus");
            // Refresh data popup atau hapus elemen dari DOM
            // Cara termudah: panggil ulang fungsi detail untuk refresh tampilan
            openUpdateDetailPopup(kwitansiId); 
        } else {
            showToast("Gagal","Gagal menghapus foto: " + result.message);
        }
    } catch (error) {
        showToast("Gagal!","Terjadi kesalahan sistem saat menghapus foto. "+error);
    }
}

// --- Fungsi Save Update Detail (dengan upload foto bukti) ---
async function saveUpdateDetail(kwitansiId) {
    try {
        // ===============================
        // 1. Ambil data uraian
        // ===============================
        const uraianRows = document.querySelectorAll(".uraian-item-row");
        const uraianData = Array.from(uraianRows).map(row => {
            const hargaRaw = row.querySelector(".edit-uraian-harga").value || "0";
            const hargaClean = hargaRaw.replace(/\./g, "");
            const volRaw = row.querySelector(".edit-uraian-vol").value || "0";

            return {
                nama_barang: row.querySelector(".edit-uraian-nama").value,
                volume: Math.round(parseFloat(volRaw) || 0),
                satuan: row.querySelector(".edit-uraian-satuan").value,
                harga_satuan: parseInt(hargaClean) || 0
            };
        });

        // ===============================
        // 2. Payload utama (JSON)
        // ===============================
        const payload = {
            nama_kegiatan: document.getElementById("edit-nama-kegiatan").value,
            no_bast: document.getElementById("edit-no-bast").value,
            tanggal_nota: document.getElementById("edit-tanggal-nota").value,
            nama_toko: document.getElementById("edit-nama-toko").value,
            npwp_toko: document.getElementById("edit-npwp-toko").value,
            alamat_toko: document.getElementById("edit-alamat-toko").value,
            uraian: uraianData
        };

        // ===============================
        // 3. Simpan detail kwitansi
        // ===============================
        const res = await fetch(`${API_BASE}/kwitansi/${kwitansiId}/update-detail`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const result = await res.json();
        if (result.status !== "success") {
            throw new Error(result.detail || "Gagal update detail");
        }

        // ===============================
        // 4. Upload foto bukti (jika ada)
        // ===============================
        const fotoInput = document.getElementById("foto-bukti-input");
        if (fotoInput && fotoInput.files.length > 0) {

            if (fotoInput.files.length > 15) {
                throw new Error("Maksimal upload 15 foto bukti");
            }

            const formData = new FormData();
            Array.from(fotoInput.files).forEach(file => {
                formData.append("files", file);
            });

            const uploadRes = await fetch(
                `${API_BASE}/kwitansi/${kwitansiId}/upload-foto`,
                {
                    method: "POST",
                    body: formData
                }
            );

            const uploadResult = await uploadRes.json();
            if (uploadResult.status !== "success") {
                throw new Error(uploadResult.detail || "Gagal upload foto bukti");
            }
        }

        // ===============================
        // 5. Selesai
        // ===============================
        closePopup();
        showToast("Berhasil!", "Data transaksi & foto bukti berhasil diperbarui");
        loadKwitansiList();

    } catch (err) {
        
        showToast("Error!", err.message || "Terjadi kesalahan");
    }
}


function showPopup(html) {
    let overlay = document.getElementById("popup-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "popup-overlay";
        overlay.style = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter: blur(4px);";
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = html;
    overlay.style.display = "flex";
}

function closePopup() {
    const overlay = document.getElementById("popup-overlay");
    if (overlay) {
        overlay.style.display = "none";
        overlay.innerHTML = "";
    }
}

// UNTUK TAMPILAN TABEL (Label)
function formatCurrencyLabel(amount) {
    if (amount === null || amount === undefined || isNaN(amount)) {
        return "Rp 0";
    }
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// UNTUK INPUT SAAT DIKETIK (Real-time)
function formatCurrencyInput(input) {
    let value = input.value.replace(/\D/g, "");
    if (value === "") {
        input.value = "";
        return;
    }
    input.value = Number(value).toLocaleString('id-ID');
}

window.formatCurrencyLabel = formatCurrencyLabel;
window.formatCurrencyInput = formatCurrencyInput;

async function loadDataBKU() {
    const tbody = document.getElementById('bku-body');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Memuat data...</td></tr>';

    try {
        const response = await fetch('http://127.0.0.1:8000/api/transaksi');
        const result = await response.json();

        // KARENA BACKEND MENGIRIM {"status": "success", "data": [...] }
        // MAKA KITA AMBIL result.data
        const transactions = result.data || [];
        
        // SIMPAN KE VARIABEL GLOBAL bkuData UNTUK PENCARIAN
        bkuData = { transaksi: transactions, kwitansi_list: bkuData?.kwitansi_list || [] };

        if (transactions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Tidak ada data BKU ditemukan.</td></tr>';
            return;
        }

        tbody.innerHTML = ''; // Bersihkan loading state
        
        transactions.forEach(item => {
    const row = `
        <tr>
            <td>${item.no_bukti || '-'}</td>
            <td>${item.tanggal || '-'}</td>
            <td>${item.kode_kegiatan || '-'}</td>
            <td>${item.uraian || '-'}</td>
            <td>${item.volume || 0}</td>
            <td>${item.satuan || ''}</td>
            <td>${formatCurrencyLabel(item.harga_satuan || 0)}</td>
            <td>${formatCurrencyLabel(item.pengeluaran || 0)}</td>
            <td style="text-align:center">
                <button class="btn btn-danger btn-sm" onclick="deleteTransaksi('${item.no_bukti}')">Hapus</button>
            </td>
        </tr>
    `;
    tbody.insertAdjacentHTML('beforeend', row);
});
    } catch (error) {
        showToast("Gagal!", error);
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:red;">Gagal terhubung ke database.</td></tr>';
    }
}

async function deleteTransaksi(no_bukti) {
    if (!confirm(`Apakah Anda yakin ingin menghapus transaksi dengan No Bukti: ${no_bukti}? Data yang dihapus tidak dapat dikembalikan.`)) {
        return;
    }

    try {
        // Panggil endpoint DELETE ke backend
        const response = await fetch(`${API_BASE}/transaksi/${encodeURIComponent(no_bukti)}`, {
            method: 'DELETE',
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.detail || "Gagal menghapus transaksi di server.");
        }
        // Jika bkuData null/kosong, blok ini dilewati tanpa error dan tanpa warning.
        if (typeof loadDataBKU() === 'function') {
                loadDataBKU();
        }

        // 2. Update tabel Draft SPJ/Kwitansi (agar sinkron)
        if (typeof loadKwitansiList === 'function') {
            loadKwitansiList(); 
        }
        
        // 3. Tampilkan Notifikasi Sukses Saja
        showToast("Berhasil!", "Data BKU dan Draft SPJ terkait berhasil dihapus.");

    } catch (error) {
        showToast("Gagal!",`Gagal menghapus: ${error.message}`);
    }
}

function previewImage(input, previewId) {
    const preview = document.getElementById(previewId);
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.src = e.target.result;
            preview.style.display = 'block';
        }
        reader.readAsDataURL(input.files[0]);
    } else {
        preview.src = "#";
        preview.style.display = 'none';
    }
}

// Fungsi Simpan Data (POST ke Backend)
async function saveDataPemda() {
    const formData = new FormData();
    
    // Ambil nilai teks
    formData.append('nama_pemda', document.getElementById('kop-1').value);
    formData.append('nama_sekolah', document.getElementById('kop-2').value);
    formData.append('alamat_sekolah', document.getElementById('kop-alamat').value);
    formData.append('tempat_surat', document.getElementById('tempat_surat')?.value || '');
    
    // Ambil file logo
    const filePemda = document.getElementById('logo-pemda').files[0];
    const fileSekolah = document.getElementById('logo-sekolah').files[0];
    
    if (filePemda) formData.append('logo_pemda', filePemda);
    if (fileSekolah) formData.append('logo_sekolah', fileSekolah);

    try {
        const response = await fetch('http://127.0.0.1:8000/api/save-pemda', {
            method: 'POST',
            body: formData
            // Jangan tambahkan Header Content-Type, browser akan mengaturnya otomatis sebagai multipart/form-data
        });
        
        const res = await response.json();
        if (res.status === "success") {
            showToast("Berhasil!", res.message);
            loadDataPemda(); // Refresh data setelah simpan
        } else {
            showToast("Gagal!", "Gagal menyimpan data");
        }
    } catch (err) {
        showToast("Gagal!", "Terjadi kesalahan koneksi ke server"+err.message);
    }
}

// Fungsi Load Data (Panggil saat aplikasi dibuka atau tab diklik)
async function loadDataPemda() {
    try {
        const response = await fetch('http://127.0.0.1:8000/api/get-pemda');
        const res = await response.json();
        if (res.data) {
            document.getElementById('kop-1').value = res.data.nama_pemda || '';
            document.getElementById('kop-2').value = res.data.nama_sekolah || '';
            document.getElementById('kop-alamat').value = res.data.alamat_sekolah || '';
            
            if (res.data.logo_pemda) {
                const img = document.getElementById('preview-logo-pemda');
                img.src = `${res.data.logo_pemda}?t=${new Date().getTime()}`; // Cache buster
                img.style.display = 'block';
            }
            if (res.data.logo_sekolah) {
                const img = document.getElementById('preview-logo-sekolah');
                img.src = `${res.data.logo_sekolah}?t=${new Date().getTime()}`;
                img.style.display = 'block';
            }

            // tempat_surat
            if (typeof res.data.tempat_surat !== 'undefined') {
                const el = document.getElementById('tempat_surat');
                if (el) el.value = res.data.tempat_surat || '';
                const preview = document.getElementById('preview-tempat-surat');
                if (preview) preview.innerText = res.data.tempat_surat || '';
            }
        }
    } catch (err) {
        showToast("Gagal!", "Error loading data:"+ err);
    }
}

// Live preview for Pemda tab (keberadaan: update preview nama & logo kecil)
function updatePemdaPreview() {
    const kop1 = document.getElementById('kop-1')?.value || 'Nama Pemda';
    const kop2 = document.getElementById('kop-2')?.value || 'Nama Satuan Pendidikan';
    const alamat = document.getElementById('kop-alamat')?.value || 'Alamat akan tampil di sini';

    const el1 = document.getElementById('preview-kop-1'); if (el1) el1.innerText = kop1;
    const el2 = document.getElementById('preview-kop-2'); if (el2) el2.innerText = kop2;
    const el3 = document.getElementById('preview-kop-alamat'); if (el3) el3.innerText = alamat;

    const tempat = document.getElementById('tempat_surat')?.value || '';
    const el4 = document.getElementById('preview-tempat-surat'); if (el4) el4.innerText = tempat;

    const large1 = document.getElementById('preview-logo-pemda');
    const small1 = document.getElementById('preview-logo-pemda-small');
    if (large1 && small1 && large1.src && large1.src !== '#' && large1.style.display !== 'none') { small1.src = large1.src; small1.style.display='block'; } else if (small1) small1.style.display='none';

    const large2 = document.getElementById('preview-logo-sekolah');
    const small2 = document.getElementById('preview-logo-sekolah-small');
    if (large2 && small2 && large2.src && large2.src !== '#' && large2.style.display !== 'none') { small2.src = large2.src; small2.style.display='block'; } else if (small2) small2.style.display='none';
}

// --- LOGIKA NOTIFIKASI TOAST --

// --- LOGIKA UPDATE ---
function initUpdateListeners() {
    const statusContainer = document.getElementById('update-status-container');
    const msgElement = document.getElementById('update-message');
    const progressBar = document.getElementById('download-bar');
    const progressBox = document.getElementById('download-progress-box');
    const restartBtn = document.getElementById('btn-restart');
    const navUpdateBtn = document.getElementById('nav-update-btn');
    const changelogContainer = document.getElementById('changelog-container');

    if (!window.electronAPI) return;

// --- Fungsi render changelog dinamis (DIPERBAIKI) ---
function renderChangelog(notes) {
    // 1. Ambil elemen dengan aman
    const changelogContainer = document.getElementById("changelog-container");
    if (!changelogContainer) return;
    
    changelogContainer.innerHTML = ""; // Bersihkan isi lama

    // Jika notes kosong/null, pakai default
    const defaultNote = "Mohon dukungannya untuk pengembangan Aplikasi SPJ BOSP dengan berdonasi melalui Bank BRI Nomor Rekening 6237 0103 6885 534 atas nama MUH. ROFIQ. Terima kasih telah menggunakan Aplikasi SPJ BOSP.🙏";
    if (!notes) notes = [defaultNote];

    const card = document.createElement("div");
    card.className = "card";
    card.style.maxWidth = "600px";
    card.style.margin = "20px auto";

    const title = document.createElement("h4");
    title.innerText = "Catatan Rilis:";
    card.appendChild(title);

    const content = document.createElement("div");
    content.style.background = "#f8fafc";
    content.style.padding = "15px";
    content.style.borderRadius = "8px";
    content.style.border = "1px solid #e2e8f0";
    content.style.fontSize = "13px";
    content.style.textAlign = "left";

    // LOGIKA BARU: Cek apakah inputnya String (Format GitHub) atau Array
    if (typeof notes === 'string') {
        // Jika dari GitHub (biasanya HTML string), masukkan sebagai innerHTML
        // Ganti newline (\n) jadi <br> jika itu plain text, tapi biasanya GitHub kirim HTML
        content.innerHTML = notes; 
    } else if (Array.isArray(notes)) {
        // Jika format Array (manual)
        notes.forEach(note => {
            const p = document.createElement("p");
            p.innerText = note;
            content.appendChild(p);
        });
    } else {
        // Fallback jika format tidak dikenali
        content.innerText = JSON.stringify(notes);
    }

    card.appendChild(content);
    changelogContainer.appendChild(card);
}

    // 1. UPDATE TERSEDIA (Auto Check)
    window.electronAPI.onUpdateAvailable((info) => {
        if (navUpdateBtn) {
            navUpdateBtn.innerHTML = "🔄 Pembaruan Aplikasi 🔴";
        }

        showToast(
            "Pembaruan Tersedia!", 
            `Versi ${info.version} tersedia.`, 
            "Lihat Progress", 
            () => switchTab('update')
        );

        statusContainer.style.display = 'block';
        msgElement.innerText = `Pembaruan ditemukan. Sedang mengunduh versi ${info.version}...`;
        progressBox.style.display = 'block';

        // Render changelog dari info.releaseNotes (asumsi berupa array string)
    if (info.releaseNotes) {
        renderChangelog(info.releaseNotes); // Kirim apa adanya (String/Array)
    } else {
        renderChangelog(); // Pakai default jika kosong
    }
    });

    // 2. PROGRESS DOWNLOAD
    window.electronAPI.onDownloadProgress((progressObj) => {
        const percent = Math.round(progressObj.percent);
        progressBar.style.width = percent + '%';
        progressBar.innerText = percent + '%';
        
        if(document.getElementById('tab-update').classList.contains('active')){
            statusContainer.style.display = 'block';
            progressBox.style.display = 'block';
        }
    });

    // 3. UPDATE SELESAI DIDOWNLOAD
    window.electronAPI.onUpdateDownloaded(() => {
        navUpdateBtn.innerHTML = "🔄 Pembaruan Aplikasi ✅"; 
        
        showToast(
            "Siap Instalasi", 
            "Pembaruan selesai diunduh. Restart aplikasi?", 
            "Restart Aplikasi Sekarang", 
            () => restartAndInstall()
        );

        msgElement.innerText = "Unduhan selesai! Restart aplikasi untuk menerapkan pembaruan.";
        progressBar.style.width = '100%';
        progressBar.innerText = 'Selesai';
        progressBar.style.backgroundColor = '#28a745';
        restartBtn.style.display = 'block';
    });

    // 4. ERROR
    window.electronAPI.onUpdateError((err) => {
        console.error(err);
        msgElement.innerText = "Terjadi kesalahan koneksi saat update.";
        msgElement.style.color = "red";
    });

    // 5. TIDAK ADA UPDATE
    window.electronAPI.onUpdateNotAvailable(() => {
        msgElement.innerText = "Aplikasi sudah versi terbaru ✅";
        msgElement.style.color = "green";
        progressBox.style.display = "none";

        showToast(
            "Tidak Ada Pembaruan",
            "Aplikasi Anda sudah versi terbaru."
        );

        // render changelog default
        renderChangelog();
    });
}


// Fungsi manual check (jika user klik tombol)
async function checkForUpdates() {
    const msgElement = document.getElementById("update-message");
    const statusContainer = document.getElementById("update-status-container");

    statusContainer.style.display = "block";
    msgElement.innerText = "Memeriksa pembaruan...";
    msgElement.style.color = "black";

    // pastikan preload jalan
    if (!window.electronAPI) {
        msgElement.innerText = "Electron API tidak tersedia.";
        msgElement.style.color = "red";
        return;
    }

    try {
        const isDev = await window.electronAPI.isDev();

        if (isDev) {
            msgElement.innerText =
                "Cek pembaruan tidak tersedia di mode development.";
            msgElement.style.color = "orange";
            return;
        }

        // PRODUCTION → cek update
        window.electronAPI.checkForUpdates();

    } catch (err) {
        msgElement.innerText = "Gagal memeriksa pembaruan.";
        msgElement.style.color = "red";
        showToast("Error!", err);
    }
}



function restartAndInstall() {
    window.electronAPI.restartApp();
}

function filterData(dataArray, keyword, keys) {
    if (!keyword || keyword.trim() === "") return dataArray;
    const lowerKeyword = keyword.toLowerCase();
    return dataArray.filter(item => {
        return keys.some(key => {
            const val = item[key];
            return val && String(val).toLowerCase().includes(lowerKeyword);
        });
    });
}

document.addEventListener("DOMContentLoaded", () => {
    initApp();
    loadPengaturan();
    loadMasterKegiatan();
    loadMasterRekeningBelanja();
    loadKwitansiList();
    loadDataBKU();
    loadDataPemda().then(() => updatePemdaPreview());
    
    // SETUP EVENT LISTENER PENCARIAN SETELAH initApp() SELESAI
    setupSearchListener();
});

// Fungsi untuk setup event listener pencarian dengan event delegation
function setupSearchListener() {
    // Gunakan event delegation pada document level agar selalu bekerja
    document.removeEventListener("keyup", handleGlobalSearch);
    document.addEventListener("keyup", handleGlobalSearch);
}

// Handler untuk global search
function handleGlobalSearch(e) {
    // Hanya proses jika event target adalah globalSearchInput
    if (e.target.id !== "globalSearchInput") return;
    
    const keyword = e.target.value;

    // Cek kita sedang di tab mana?
    switch (activeTab) {
        case 'master': // Referensi Kegiatan
            const filteredKegiatan = filterData(masterKegiatan, keyword, ['kode_kegiatan', 'nama_kegiatan']);
            renderMasterKegiatan(filteredKegiatan);
            break;

        case 'rekening': // Rekening Belanja
            const filteredRekening = filterData(masterRekeningBelanja, keyword, ['kode_rekening_belanja', 'nama_rekening_belanja','rekap_rekening_belanja','nilai_kapitalisasi_belanja']);
            renderMasterRekeningBelanja(filteredRekening);
            break;

        case 'data-bku': // Data BKU
            if (bkuData && bkuData.transaksi) {
                const filteredBKU = filterData(bkuData.transaksi, keyword, ['tanggal', 'kode_rekening','satuan','volume', 'uraian', 'no_bukti', 'kode_kegiatan','harga_satuan','pengeluaran']);
                renderBKUResult(filteredBKU);
            }
            break;

        case 'kwitansi': // Daftar SPJ
            if (bkuData && bkuData.kwitansi_list) {
                const filteredKwitansi = filterData(bkuData.kwitansi_list, keyword, ['no_bukti','nomor_kwitansi', 'nama_toko', 'nama_kegiatan', 'tanggal', 'npwp_toko', 'alamat_toko','thp','tahun','tanggal_nota','jumlah']);
                if(typeof renderKwitansiList === 'function') renderKwitansiList(filteredKwitansi);
            }
            break;
    }
}



// Initialize app
function initApp() {
    const root = document.getElementById("app");
    let appVersion = "-";
window.electronAPI.getAppVersion().then(v => {
    document.getElementById("current-version").innerText = v;
});
    root.innerHTML = `
        <style>
            :root {
                --primary: #4a90e2;
                --secondary: #6c757d;
                --success: #28a745;
                --danger: #dc3545;
                --light-bg: #f8fafc;
                --text-dark: #2c3e50;
            }

            * { box-sizing: border-box; }
            body { 
                font-family: 'Inter', 'Segoe UI', sans-serif; 
                margin: 0; 
                padding: 20px; 
                background: #f1f5f9; 
                color: var(--text-dark);
                line-height: 1.6;
            }

            h1 { color: #1e293b; margin-bottom: 8px; font-weight: 700; }
            .subtitle { color: #64748b; margin-bottom: 30px; font-size: 14px; }
            
            /* Tabs Modern */
            .tabs { 
                display: flex; 
                gap: 5px; 
                margin-bottom: 25px; 
                background: #e2e8f0;
                padding: 5px;
                border-radius: 12px;
                width: fit-content;
            }
            .tab-btn { 
                padding: 10px 20px; 
                border: none; 
                border-radius: 8px; 
                cursor: pointer; 
                background: transparent; 
                color: #64748b; 
                font-size: 14px; 
                font-weight: 600;
                transition: all 0.2s;
            }
            .tab-btn.active { 
                background: white; 
                color: var(--primary); 
                box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
            }
            .tab-btn:hover:not(.active) { background: rgba(255,255,255,0.5); }
            
            .tab-content { display: none; animation: fadeIn 0.3s ease; }
            .tab-content.active { display: block; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
            
            /* Card & Layout */
            .card { 
                background: white; 
                padding: 25px; 
                border-radius: 16px; 
                margin-bottom: 20px; 
                box-shadow: 0 1px 3px rgba(0,0,0,0.1); 
                border: 1px solid #e2e8f0;
            }
.progress-container {
                width: 100%;
                background-color: #e2e8f0;
                border-radius: 10px;
                margin-top: 15px;
                height: 20px;
                overflow: hidden;
                display: none; /* Hidden by default */
            }
            
            .progress-bar {
                width: 0%;
                height: 100%;
                background-color: var(--success);
                transition: width 0.4s ease;
                text-align: center;
                line-height: 20px;
                color: white;
                font-size: 11px;
                font-weight: bold;
            }

            .update-status-text {
                margin-top: 10px;
                font-size: 13px;
                color: var(--secondary);
                font-style: italic;
            }
            /* MODERNISED UPLOAD BKU SECTION */
            .upload-zone {
                border: 2px dashed #cbd5e0;
                background: var(--light-bg);
                padding: 40px 20px;
                border-radius: 12px;
                text-align: center;
                transition: all 0.3s ease;
                margin-bottom: 20px;
            }
            .upload-zone:hover {
                border-color: var(--primary);
                background: #f1f7ff;
            }
            .upload-icon {
                font-size: 40px;
                margin-bottom: 15px;
                display: block;
            }
            #bkuFile {
                margin: 15px auto;
                font-size: 14px;
                color: #64748b;
            }

            /* Forms */
            .form-group { margin-bottom: 20px; }
            .form-group label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 14px; color: #475569; }
            .form-group input, .form-group textarea { 
                width: 100%; 
                padding: 12px; 
                border: 1px solid #cbd5e0; 
                border-radius: 8px; 
                font-size: 14px;
                transition: border 0.2s;
            }
            .form-group input:focus { border-color: var(--primary); outline: none; ring: 2px var(--primary); }
            
            /* Buttons */
            .btn { 
                padding: 12px 24px; 
                border: none; 
                border-radius: 8px; 
                cursor: pointer; 
                font-size: 14px; 
                font-weight: 600;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
                transition: all 0.2s;
            }
            .btn-primary { background: var(--primary); color: white; }
            .btn-success { background: var(--success); color: white; }
            .btn-danger { background: var(--danger); color: white; }
            .btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
            .btn:active { transform: translateY(0); }
            
            /* Table */
            .table-container { overflow-x: auto; border-radius: 12px; border: 1px solid #e2e8f0; }
            table { width: 100%; border-collapse: collapse; font-size: 13px; }
            th { background: #f8fafc; color: #64748b; font-weight: 600; text-align: left; padding: 15px; border-bottom: 2px solid #e2e8f0; }
            td { padding: 15px; border-bottom: 1px solid #e2e8f0; background: white; }
            tr:last-child td { border-bottom: none; }

            /* Pemda (logo & header preview) */
            .logo-preview-img { max-height: 80px; border: 1px solid #e6e6e6; padding: 6px; border-radius: 6px; display: block; object-fit: contain; }
            #pemda-header-preview { background: linear-gradient(180deg, #fff 0%, #fbfdff 100%); }
            #pemda-header-preview img { display:block; }
#toast-container {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 9999;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .toast {
                background: white;
                border-left: 5px solid var(--primary);
                padding: 16px 20px;
                border-radius: 8px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.15);
                display: flex;
                align-items: center;
                justify-content: space-between;
                min-width: 300px;
                animation: slideIn 0.4s ease forwards;
                transition: all 0.3s ease;
            }

            .toast-content {
                display: flex;
                flex-direction: column;
            }

            .toast-title { font-weight: 700; font-size: 14px; color: var(--text-dark); }
            .toast-msg { font-size: 12px; color: var(--secondary); margin-top: 4px; }

            .toast-btn {
                background: var(--primary);
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 6px;
                font-size: 12px;
                cursor: pointer;
                margin-left: 15px;
            }
            .toast-btn:hover { background: #357abd; }
            
            .toast-close {
                background: transparent;
                border: none;
                color: #999;
                font-size: 18px;
                cursor: pointer;
                margin-left: 10px;
            }
@keyframes slideIn {
                from { opacity: 0; transform: translateX(100%); }
                to { opacity: 1; transform: translateX(0); }
            }                            
        </style>

        <h1>📋 Aplikasi SPJ BOSP</h1>
        <p class="subtitle">Aplikasi untuk membuat SPJ dari ARKAS.</p>
        <div class="search-container mb-3" style="display: flex; justify-content: flex-end;">
    <input type="text" 
           id="globalSearchInput" 
           class="form-control" 
           style="width: 300px;" 
           placeholder="🔍 Cari data di menu ini...">
</div>
        
        <div id="message"></div>

<div class="tabs">
    <button class="tab-btn active" data-tab="pengaturan" onclick="switchTab('pengaturan')">🏫 Identitas Satuan Pendidikan</button>
    <button class="tab-btn" data-tab="pemda" onclick="switchTab('pemda')">🏛️ Logo dan Kop Surat</button>
    <button class="tab-btn" data-tab="master" onclick="switchTab('master')">📚 Referensi Kegiatan</button>
    <button class="tab-btn" data-tab="rekening" onclick="switchTab('rekening')">💼 Rekening Belanja</button>
    <button class="tab-btn" data-tab="bku" onclick="switchTab('bku')">📄 Upload BKU</button>
    <button class="tab-btn" data-tab="data-bku" onclick="switchTab('data-bku')">📊 Data BKU</button>
    <button class="tab-btn" data-tab="kwitansi" onclick="switchTab('kwitansi')">🧾 Daftar SPJ</button>
    <button class="tab-btn" data-tab="rekap" onclick="switchTab('rekap')">📈 Rekap Belanja</button>
    <button class="tab-btn" data-tab="update" id="nav-update-btn" onclick="switchTab('update')" style="color: var(--primary);">🔄 Pembaruan Aplikasi</button>
    <div id="toast-container"></div>  
</div>
<div id="tab-update" class="tab-content">
            <div class="card" style="max-width: 600px; margin: 0 auto; text-align: center;">
                <h3>🔄 Pembaruan Aplikasi</h3>
                <div style="margin-bottom: 20px;">
                    <p style="color: #64748b;">Versi Aplikasi Saat Ini:</p>
                    <h2 style="margin-top: -10px; color: var(--primary);" id="current-version">-</h2>
                </div>
                
                <div id="update-actions">
                    <button class="btn btn-primary" id="btn-check-update" onclick="checkForUpdates()">
                        🔍 Cek Pembaruan
                    </button>
                </div>

                <div id="update-status-container" style="margin-top: 25px; display:none;">
                    <p id="update-message" style="font-weight: 600; color: var(--text-dark);">Mencari pembaruan...</p>
                    
                    <div id="download-progress-box" class="progress-container">
                        <div id="download-bar" class="progress-bar">0%</div>
                    </div>
                    
                    <div id="update-details" class="update-status-text"></div>
                    
                    <button id="btn-restart" class="btn btn-success" style="display:none; margin-top:15px; width:100%;" onclick="restartAndInstall()">
                        🚀Mulai Ulang & Terapkan Update
                    </button>
                </div>
            </div>
            
            <div id="changelog-container"></div>
        </div>
<div id="tab-pemda" class="tab-content">
    <div class="card">
        <div style="display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap;">
            <div style="flex:1; min-width:320px;">
                <h3>🏛️ Logo dan Kop Surat</h3>
<p>Atur identitas visual dan informasi kop surat untuk dokumen SPJ Anda. Logo dan nama instansi akan tercetak pada setiap halaman SPJ yang dihasilkan.</p>
                <form id="form-pemda" onsubmit="event.preventDefault(); saveDataPemda();" style="margin-top:12px;">
                    <div class="form-group">
                        <label>Nama Pemerintah Daerah / Yayasan (Baris ke-1)</label>
                        <input type="text" id="kop-1" required oninput="updatePemdaPreview()" placeholder="Contoh: PEMERINTAH KABUPATEN XYZ">
                    </div>

                    <div class="form-group">
                        <label>Nama Satuan Pendidikan (Baris ke-2)</label>
                        <input type="text" id="kop-2" required oninput="updatePemdaPreview()" readonly>
                    </div>

                    <div class="form-group">
                        <label>Alamat Lengkap dan Kontak (Baris ke-3)</label>
                        <textarea id="kop-alamat" rows="2" required oninput="updatePemdaPreview()" readonly></textarea>
                    </div>

                    <div class="form-group">
                        <label>Tempat Terbit Surat</label>
                        <input type="text" id="tempat_surat" oninput="updatePemdaPreview()" placeholder="Contoh: Jember">
                    </div>

                    <div style="display:flex; gap:10px; align-items:center; margin-top:12px;">
                        <div style="flex:1;">
                            <label>Logo Pemerintah Daerah / Yayasan (Logo Samping Kiri)</label>
                            <input type="file" id="logo-pemda" accept="image/*" onchange="previewImage(this, 'preview-logo-pemda'); updatePemdaPreview();">
                            <div style="margin-top:8px;">
                                <img id="preview-logo-pemda" src="#" alt="Preview" class="logo-preview-img" style="display:none;">
                            </div>
                        </div>
                        <div style="flex:1;">
                            <label>Logo Satuan Pendidikan (Logo Samping Kanan)</label>
                            <input type="file" id="logo-sekolah" accept="image/*" onchange="previewImage(this, 'preview-logo-sekolah'); updatePemdaPreview();">
                            <div style="margin-top:8px;">
                                <img id="preview-logo-sekolah" src="#" alt="Preview" class="logo-preview-img" style="display:none;">
                            </div>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px; margin-top:14px;">
                        <button type="submit" class="btn btn-primary" style="flex:1; padding:12px 18px; font-weight:700;">💾 Simpan Pengaturan</button>
                        <button class="btn btn-secondary" type="button" style="padding:12px 18px;" onclick="loadDataPemda(); showToast('Info!','Data berhasil dimuat ulang')">🔄 Muat Ulang</button>
                    </div>
                </form>
            </div>

        </div>
    </div>
</div>

<div id="tab-data-bku" class="tab-content">
    <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
            <h3>📊 Data BKU</h3>
                <div style="display:flex; gap:10px; align-items:center;">
                    <button class="btn-primary" onclick="loadDataBKU()">🔄 Segarkan Data</button>
                    <button class="btn btn-outline-primary" onclick="openManualBKUForm()" title="Tambah data BKU manual">＋ Tambah Manual</button>
                </div>
        </div>
                <div class="table-scroll">
                    <table id="table-bku" style="width:100%; border-collapse:collapse;">
                        <thead>
                            <tr>
                                <th>No. Bukti</th>
                                <th>Tanggal</th>
                                <th>Kode Kegiatan</th>
                                <th>Nama Barang/Jasa</th>
                                <th>Volume</th>
                                <th>Satuan</th>
                                <th>Harga Satuan</th>
                                <th>Harga</th>
                                <th style="width:120px; text-align:center">Aksi</th>
                            </tr>
                        </thead>
                        <tbody id="bku-body">
                            </tbody>
                    </table>
                </div>
    </div>
</div>
<style>
    /* Menyembunyikan input file asli */
    #bkuFile {
        display: none;
    }

    /* Membuat area upload yang bisa diklik */
    .custom-upload-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 150px;
        border: 2px dashed #4a90e2;
        border-radius: 12px;
        background: #f8fbff;
        cursor: pointer;
        transition: all 0.3s;
        margin-bottom: 15px;
    }

    .custom-upload-btn:hover {
        background: #eef5ff;
        border-color: #28a745;
    }

    .plus-icon {
        font-size: 40px;
        color: #4a90e2;
        margin-bottom: 8px;
    }

    .file-list {
        text-align: left;
        font-size: 13px;
        margin-top: 10px;
        color: #555;
        max-height: 150px;
        overflow-y: auto;
    }

    .file-item {
        background: #eee;
        padding: 4px 10px;
        border-radius: 4px;
        margin-bottom: 4px;
        display: flex;
        justify-content: space-between;
    }

    /* Scrollable table with sticky header (reusable) */
    .table-scroll {
        max-height: 60vh;
        overflow-y: auto;
        border: 1px solid #e6e6e6;
        border-radius: 8px;
        background: white;
    }
    .table-scroll table {
        width: 100%;
        border-collapse: collapse;
    }
    .table-scroll thead th {
        position: sticky;
        top: 0;
        background: #fff;
        z-index: 3;
        border-bottom: 2px solid #ddd;
        padding: 10px;
        text-align: left;
    }
    .table-scroll tbody td {
        padding: 10px;
        border-bottom: 1px solid #f1f1f1;
    }
</style>

<div id="tab-bku" class="tab-content" style="padding: 20px; background-color: #f8f9fa;">
    <div class="card" style="max-width: 850px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: none; overflow: hidden;">
        <div class="upload-zone" style="padding: 24px;">
            
            <div style="display:flex; gap:24px; align-items:stretch; justify-content:center; flex-wrap:wrap;">
                
                <div style="flex:1; min-width:300px; display: flex; flex-direction: column;">
                    <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #444; font-size: 14px;">Dokumen Utama</label>
                    <div style="border: 1px solid #edf2f7; padding: 16px; border-radius: 12px; background:#fdfdfd; flex: 1; display: flex; flex-direction: column;">
                        <div class="custom-upload-btn" onclick="document.getElementById('bkuFile').click()" 
                             style="width: 100%; padding: 20px; border: 2px dashed #d1d5db; border-radius: 10px; background: #fafafa; cursor: pointer; text-align: center; transition: all 0.3s ease;">
                            <span style="font-weight: bold; color: #2563eb; display: block; font-size: 15px;">📎 Pilih File BKU (PDF)</span>
                            <span style="font-size: 11px; color: #6b7280; margin-top: 4px; display:block;">Maksimal 12 file</span>
                        </div>
                        <input type="file" id="bkuFile" accept=".pdf" multiple onchange="updateFileList()" style="display:none;">
                        <div id="selected-files" class="file-list" style="margin-top: 10px; flex-grow: 1;"></div>
                        
                        <div style="display:flex; gap:10px; margin-top:15px;">
                            <button class="btn btn-success" style="flex:2; padding: 10px; border-radius: 8px; font-weight: 600; background-color: #10b981; border: none; color: white; font-size: 13px;" onclick="uploadBKU()">🔍 Ekstrak Data</button>
                            <button class="btn btn-secondary" style="flex:1; padding: 10px; border-radius: 8px; background-color: #6b7280; border: none; color: white; font-size: 13px;" onclick="resetBkuSelection()">Reset</button>
                        </div>
                    </div>
                </div>
                <div style="flex:1; min-width:300px; display: flex; flex-direction: column;">
                    <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #444; font-size: 14px;">Dokumen Pendukung</label>
                    <div style="border: 1px solid #edf2f7; padding: 16px; border-radius: 12px; background:#fdfdfd; flex: 1; display: flex; flex-direction: column; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">                        
                        <div class="custom-upload-btn" onclick="document.getElementById('bhpFile').click()" 
                             style="width: 100%; padding: 20px; border: 2px dashed #d1d5db; border-radius: 10px; background: #fafafa; cursor: pointer; text-align: center; transition: all 0.3s ease;">
                            <span style="font-weight: bold; color: #2563eb; display: block; font-size: 15px;">📎 Pilih File BHP/BHM</span>
                            <span style="font-size: 11px; color: #6b7280; margin-top: 4px; display:block;">File PDF pendukung</span>
                        </div>
                            <input type="hidden" id="bhp-type"  value="BHP">
                        <input type="file" id="bhpFile" accept=".pdf" multiple style="display:none" onchange="updateBhpFileList()">
                        <div id="selected-bhp-files" class="file-list" style="margin-top:10px; flex-grow: 1;"></div>
                        
                        <div style="display:flex; gap:10px; margin-top:15px;">
                            <button class="btn btn-success" style="flex:2; font-size: 13px; padding: 10px; border-radius: 8px; background-color: #10b981; border: none; color: white; font-weight: 600;" onclick="extractBHP()">🔍 Ekstrak Data</button>
                            <button class="btn btn-secondary" style="flex:1; font-size: 13px; border-radius: 8px; background-color: #6b7280; border: none; color: white;" onclick="resetBhpSelection()">Reset</button>
                        </div>
                    </div>
                </div>
                
            </div>
        </div>
                        <div id="bku-action-buttons" style="display: none;">
                <button onclick="saveTransaksi()" class="btn btn-primary">Simpan Data</button>
                </div>
    </div>
</div>

        <div id="tab-kwitansi" class="tab-content">
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h3 style="margin:0">🧾 Daftar Draft SPJ</h3>
                    <div id="kwitansi-stats"></div>
                </div>
                <div id="kwitansi-list" class="table-container"></div>
            </div>
        </div>

        <div id="tab-pengaturan" class="tab-content active">
            <div class="card" style="max-width: 650px; margin: 0 auto;">
                <h3 style="margin-top:0">🏫 Identitas Satuan Pendidikan</h3>
                <div class="form-group">
                    <label>Nama Satuan Pendidikan</label>
                    <input type="text" id="nama_sekolah" placeholder="Masukkan nama satuan pendidikan...">
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div class="form-group">
                        <label>Nama Kepala Satuan Pendidikan</label>
                        <input type="text" id="nama_kepala">
                    </div>
                    <div class="form-group">
                        <label>NIP Kepala Satuan Pendidikan</label>
                        <input type="text" id="nip_kepala">
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div class="form-group">
                        <label>Nama Bendahara</label>
                        <input type="text" id="nama_bendahara">
                    </div>
                    <div class="form-group">
                        <label>NIP Bendahara</label>
                        <input type="text" id="nip_bendahara">
                    </div>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                    <div class="form-group">
                        <label>Nama Pengurus Barang</label>
                        <input type="text" id="nama_pengurus_barang">
                    </div>
                    <div class="form-group">
                        <label>NIP Pengurus Barang</label>
                        <input type="text" id="nip_pengurus_barang">
                    </div>
                </div>
                <div class="form-group">
                    <label>Alamat Lengkap dan Kontak Satuan Pendidikan</label>
                    <textarea id="alamat_sekolah" rows="3" placeholder="Alamat lengkap sekolah..."></textarea>
                </div>
                <button class="btn btn-primary" style="width: 100%;" onclick="savePengaturan()">Simpan Pengaturan</button>
            </div>
        </div>

        <div id="tab-master" class="tab-content">
            <div class="card">
                <h3 style="margin-top:0">📚 Data Referensi Kegiatan</h3>
                <div style="background: #fffbeb; border: 1px solid #fef3c7; padding: 15px; border-radius: 12px; margin-bottom: 25px;">
                    <h4 style="margin:0 0 5px 0; color: #92400e; font-size: 14px;">📥 Import dari Excel</h4>
                    <p style="color: #b45309; margin: 0 0 15px 0; font-size: 13px;">
                        Gunakan file Excel dengan header: <strong>kode_kegiatan</strong> dan <strong>nama_kegiatan</strong>.
                    </p>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <input type="file" id="excelFile" accept=".xlsx,.xls" style="font-size: 12px;">
                        <button class="btn btn-primary btn-sm" onclick="importMasterKegiatan()">Import Data</button>
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h4 style="margin:0">Daftar Referensi Kegiatan Tersimpan (<span id="master-count">0</span>)</h4>
                </div>
                <div id="master-list" class="table-container"></div>
            </div>
        </div>

<div id="tab-rekap" class="tab-content">
    <div class="card" style="margin-top:20px;">
        <h3 style="margin-top:0">📈 Rekap Belanja</h3>
        
        <div style="display:flex; gap:10px; align-items:center; margin-top:12px; flex-wrap: wrap;">
            <label style="display:flex; align-items:center; gap:8px;">
                <select id="rekap-thp-select" style="padding:8px; border-radius:6px; border:1px solid #ddd;">
                    <option value="all">Semua Tahap</option>
                    <option value="1">Tahap 1</option>
                    <option value="2">Tahap 2</option>
                </select>
            </label>
            <button class="btn btn-primary" onclick="generateRekapTransaksi(false)">🔍 Generate Data</button>
            <button class="btn" onclick="generateRekapTransaksi(true)">🔽 Detail</button>
        </div>

        <div style="margin-top:15px; padding:15px; border:1px dashed #ccc; background:#f9f9f9; border-radius:8px; display:flex; gap:10px; align-items:center;">
            <div style="flex:1;">
                <strong>Butuh file rekap dalam bentuk excel?</strong><br>
                <small style="color:#666;">Copas "Kode Template" di bawah ini pada file excel template rekap (.xlsx) lalu upload melalui tombol di samping. Sistem akan mengganti "Kode Template" di dalam excel dengan jumlah rekap belanja Anda!.</small>
            </div>
            <input type="file" id="template-file" accept=".xlsx" style="font-size:0.9em;">
            <button class="btn btn-success" onclick="processTemplateExcel()">⬇️ Download Rekap</button>
        </div>

        <div id="rekap-result" style="margin-top:20px;"></div>
    </div>
</div>

        <div id="tab-rekening" class="tab-content">
            <div class="card" style="margin-top:20px;">
                <h3 style="margin-top:0">📥 Data Rekening Belanja</h3>
                <div style="background: #f0f9ff; border: 1px solid #e0f2fe; padding: 15px; border-radius: 12px; margin-bottom: 15px;">
                    <h4 style="margin:0 0 8px 0; font-size:14px;">📥 Import Rekening dari Excel</h4>
                    <p style="margin:0 0 12px 0; color:#0369a1; font-size:13px;">Gunakan file Excel dengan header: <strong>kode_rekening_belanja</strong>, <strong>nama_rekening_belanja</strong>, <strong>rekap_rekening_belanja</strong>, <strong>nilai_kapitalisasi_belanja</strong>.</p>
                    <div style="display:flex; gap:10px; align-items:center;">
                        <input type="file" id="excelFileRekening" accept=".xlsx,.xls" style="font-size:12px;">
                        <button class="btn btn-primary btn-sm" onclick="importMasterRekeningBelanja()">Import Rekening</button>
                    </div>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h4 style="margin:0">Daftar Rekening Belanja Tersimpan (<span id="master-rekening-count">0</span>)</h4>
                </div>
                <div id="master-rekening-list" class="table-container"></div>
            </div>
        </div>
    `;
    setTimeout(() => {
    if (document.getElementById("update-status-container")) {
        initUpdateListeners();
    }
}, 300);
}


// --- GLOBAL FUNCTIONS (UNTUK DIPANGGIL DARI HTML/TOMBOL) ---
window.switchTab = switchTab;
window.savePengaturan = savePengaturan;
window.uploadBKU = uploadBKU;
window.saveTransaksi = saveTransaksi;
window.generateKwitansi = generateKwitansi;
window.downloadKwitansi = downloadKwitansi;
window.deleteMasterKegiatan = deleteMasterKegiatan;
window.importMasterKegiatan = importMasterKegiatan;
window.importMasterRekeningBelanja = importMasterRekeningBelanja;
window.openUpdateDetailPopup = openUpdateDetailPopup;
window.saveUpdateDetail = saveUpdateDetail;
window.previewFotoKwitansi = previewFotoKwitansi;
window.closePopup = closePopup;
window.formatCurrencyID = formatCurrencyID;
window.showMessage = showMessage;
window.initApp = initApp;
window.loadPengaturan = loadPengaturan;
window.loadMasterKegiatan = loadMasterKegiatan;
window.loadKwitansiList = loadKwitansiList;
window.renderKwitansiList = renderKwitansiList;
window.generateRekapTransaksi = generateRekapTransaksi;
window.renderRekapTransaksi = renderRekapTransaksi;
window.renderBKUResult = renderBKUResult;
window.renderMasterKegiatan = renderMasterKegiatan;
window.loadDataBKU = loadDataBKU;
window.previewImage = previewImage;
window.updatePemdaPreview = updatePemdaPreview;
window.saveDataPemda = saveDataPemda;
window.openManualBKUForm = openManualBKUForm;
window.deleteMasterRekening = deleteMasterRekening;
window.loadDataPemda = loadDataPemda;
window.downloadKwitansi = downloadKwitansi;
window.downloadBAST = downloadBAST;
window.deleteMasterKegiatan = deleteMasterKegiatan;
window.deleteExistingFoto = deleteExistingFoto;
window.deleteTransaksi = deleteTransaksi;
window.updateBhpFileList = updateBhpFileList;
window.resetBhpSelection = resetBhpSelection;
window.extractBHP = extractBHP;
window.applyBhpToBKU = applyBhpToBKU;
window.resetBkuSelection = resetBkuSelection;
window.openManualBKUForm = openManualBKUForm;
window.addManualUraianRow = addManualUraianRow;
window.renderMasterRekeningBelanja = renderMasterRekeningBelanja;
window.saveManualBKU = saveManualBKU;
window.showToast = showToast;
window.initUpdateListeners = initUpdateListeners;
window.checkForUpdates = checkForUpdates;
window.restartAndInstall = restartAndInstall;
window.processTemplateExcel = processTemplateExcel;


// --- INITIALIZE APP ---
document.addEventListener("DOMContentLoaded", () => {
    initApp();
    loadPengaturan();
    loadMasterKegiatan();
    loadMasterRekeningBelanja();
    loadKwitansiList();
    loadDataBKU();
    loadDataPemda().then(() => updatePemdaPreview());
});
