import * as XLSX from "xlsx";
import UI from "./ui.js";
import { iconSvg } from "./icons.js";
import { buildSpjPdf, setBackendOriginGetter } from "./pdf/spjPdf.js";
import {
  getFotoJenisLabel,
  JENIS_BELANJA_SPJ,
} from "./spjConfig.js";

// ===================== BACKEND BASE URL (child_process) =====================
// Backend TIDAK lagi dilayani oleh "servis localhost" statis (port 8000).
// FastAPI HANYA berjalan sebagai child_process yang di-spawn Electron pada
// port dinamis; base URL dikirim ke renderer lewat IPC
// (window.electronAPI.getBackendUrl()). Tidak ada fallback hardcode — kalau
// origin belum tersedia, request ditolak dengan error yang jelas (dan dicatat
// ke app.log), bukan menembak port mati.
let _backendOrigin = ""; // contoh: "http://127.0.0.1:54321" (port dinamis child_process)
setBackendOriginGetter(() => _backendOrigin);
const API_BASE = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === "toString" || prop === Symbol.toPrimitive) {
        return () => `${_backendOrigin}/api`;
      }
      return `${_backendOrigin}/api`;
    },
  },
);

// Janji (promise) global agar semua pemanggil cukup melakukan
// `await ensureBackendReady()` dan selalu mendapat origin yang benar
// (tidak ada race condition dengan DOMContentLoaded). Retry sampai
// child_process melapor siap via IPC.
let _backendInitPromise = null;

// Verifikasi akhir: origin dari IPC saja TIDAK cukup. Electron menunggu
// /health sebelum membuka jendela, tetapi pada beberapa kondisi (mis. DB lama
// yang skemanya sedang diselaraskan ulang) backend bisa menolak request API
// pertama dengan HTTP 500. Karena itu renderer WAJIB memeriksa sendiri
// GET /health dan baru menganggap backend siap setelah menjawab 200 —
// mencegah permintaan (fetch) dikirim "terlalu cepat" saat backend belum siap.
async function waitForBackendHealth(origin, maxTries = 60) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(`${origin}/health`, { cache: "no-store" });
      if (res.ok) {
        appLog("info", `Backend /health siap (percobaan ${i + 1}).`);
        return true;
      }
      // 503 = backend hidup tetapi masih menyiapkan skema DB — terus menunggu.
      appLog(
        "warn",
        `Backend /health belum siap (HTTP ${res.status}) — menunggu...`,
      );
    } catch (e) {
      appLog("warn", `Backend /health belum dapat dijangkau: ${e.message || e}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  appLog(
    "error",
    "Backend /health tidak kunjung siap setelah ~30 detik — permintaan API mungkin gagal.",
  );
  return false;
}

async function deleteMasterKegiatanArkas(id) {
  if (
    !(await UI.confirm("Hapus referensi kegiatan pada tahun dan sumber dana ini?", {
      title: "Hapus Referensi ARKAS",
      okText: "Hapus",
      danger: true,
    }))
  ) return;
  try {
    const response = await apiFetch(
      `${API_BASE}/master-kegiatan/arkas/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || "Gagal menghapus referensi ARKAS.");
    await loadMasterKegiatan();
    await loadFiscalContexts();
    showToast("Berhasil!", result.message || "Referensi ARKAS dihapus.");
  } catch (error) {
    showToast("Gagal!", error.message || "Gagal menghapus referensi ARKAS.");
  }
}

function ensureBackendReady() {
  if (_backendOrigin) return Promise.resolve(_backendOrigin);
  if (!_backendInitPromise) {
    _backendInitPromise = (async () => {
      const maxTries = 60; // ~30 detik (retry tiap 500 ms)
      for (let i = 0; i < maxTries; i++) {
        try {
          if (
            window.electronAPI &&
            typeof window.electronAPI.getBackendUrl === "function"
          ) {
            const url = await window.electronAPI.getBackendUrl();
            if (url) {
              // Jangan langsung mengembalikan origin — tunggu /health menjawab
              // 200 lebih dulu agar tidak ada fetch yang mendahului kesiapan
              // backend (penyebab "FETCH <- 500 GET /api/identitas-periode").
              const ready = await waitForBackendHealth(url, 40); // ~20 detik
              _backendOrigin = url;
              appLog(
                "info",
                `Backend child_process aktif di ${_backendOrigin}` +
                (ready ? "" : " (health check belum lolos — akan dicoba ulang)"),
              );
              if (!ready) {
                // Izinkan percobaan health ulang di kemudian hari.
                _backendReadyChecked = false;
              } else {
                _backendReadyChecked = true;
              }
              return _backendOrigin;
            }
          } else {
            appLog(
              "error",
              "electronAPI.getBackendUrl tidak tersedia — preload gagal dimuat?",
            );
            break;
          }
        } catch (e) {
          appLog(
            "error",
            `Gagal mengambil URL backend dari main process: ${e.message || e}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      _backendInitPromise = null; // izinkan percobaan ulang di kemudian hari
      appLog(
        "error",
        "Base URL backend kosong — child_process belum siap. Servis localhost statis sudah dinonaktifkan, tidak ada fallback.",
      );
      return "";
    })();
  }
  return _backendInitPromise;
}

// Penanda apakah health check terakhir lolos; dipakai apiFetch untuk mencoba
// ulang secara ringan bila backend sempat dilaporkan belum siap.
let _backendReadyChecked = false;

// Nama lama tetap dipertahankan (alias) demi kompatibilitas.
async function initBackendBaseUrl() {
  return ensureBackendReady();
}

function getServerRoot() {
  return _backendOrigin;
}

// ===================== LOG KEJADIAN FRONTEND -> app.log (WAJIB) =====================
// Semua kejadian frontend dicatat ke app.log yang sama dengan log backend
// (ditulis oleh main process Electron via IPC "renderer-log").
function appLog(level, message) {
  const msg = String(message ?? "");
  try {
    if (window.electronAPI && typeof window.electronAPI.logApp === "function") {
      window.electronAPI.logApp(level, msg);
    }
  } catch (e) {
    /* logging tidak boleh memecah aplikasi */
  }
  // Pantulan ke konsol dev untuk kemudahan debugging
  try {
    if (level === "error") console.error(msg);
    else if (level === "warn") console.warn(msg);
    else console.log(msg);
  } catch (e) { }
}

// Hook pembungkus fetch: catat SETIAP request API (mulai, status, error) ke app.log.
async function apiFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // BUG v1.2.4 (akar masalah "FETCH <- 500 GET /api/identitas-periode"):
  // tunggu origin child_process SIAP lebih dulu, BARU URL dibentuk.
  // Selama ini beberapa pemanggil (mis. loadIdentitasPeriode) menyusun URL
  // dari Proxy API_BASE SEBELUM _backendOrigin terisi. Saat origin masih
  // kosong, `${API_BASE}/...` menghasilkan string RELATIF "/api/..." yang
  // meski kemudian dijahit ke origin oleh blok di bawah, pada build lama
  // sempat tertangkap proxy Vite (port 5173 -> port statis 8000 yang sudah
  // dimatikan) dan menjawab 500 sebelum retry sempat menolong.
  await ensureBackendReady();
  if (!_backendOrigin) {
    appLog(
      "error",
      `FETCH DITOLAK (backend child_process belum siap): ${method} ${url}`,
    );
    throw new Error(
      "Backend child_process belum siap. Tidak ada servis localhost statis sebagai fallback.",
    );
  }
  // BUG v1.2.4 (lanjutan): sebagian pemanggil masih menulis url relatif seperti
  // "/api/identitas-periode". Di mode dev, fetch relatif mengenai origin Vite
  // (http://localhost:5173) — BUKAN backend child_process di port dinamis —
  // sehingga muncul "FETCH <- 500 GET /api/identitas-periode" dari log renderer.
  // Karena itu setiap URL yang belum absolut selalu digabung dulu ke origin
  // backend yang sebenarnya. Penjahitan ini kini berjalan SETELAH
  // ensureBackendReady() di atas, sehingga _backendOrigin dijamin terisi dan
  // URL relatif hasil pembentukan dini tetap diarahkan ke child_process,
  // bukan ke proxy Vite.
  let finalUrl = url;
  try {
    if (typeof url === "string" && !/^https?:\/\//i.test(url)) {
      const pathPart = url.startsWith("/") ? url : `/${url}`;
      finalUrl = `${_backendOrigin}${pathPart}`;
    }
  } catch (_) {
    finalUrl = url;
  }
  appLog("info", `FETCH -> ${method} ${finalUrl}`);
  try {
    const res = await fetch(finalUrl, options);
    appLog(
      res.status >= 400 ? "error" : "info",
      `FETCH <- ${res.status} ${method} ${finalUrl}`,
    );
    return res;
  } catch (e) {
    appLog("error", `FETCH GAGAL ${method} ${finalUrl}: ${e.message || e}`);
    throw e;
  }
}

// Tangkap semua error runtime & unhandled rejection di renderer agar masuk app.log
window.addEventListener("error", (e) => {
  appLog(
    "error",
    `Renderer error: ${e.message} @ ${e.filename || "?"}:${e.lineno || 0}`,
  );
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  appLog(
    "error",
    `Unhandled rejection: ${(r && r.stack) || (r && r.message) || r}`,
  );
});
// ============================================================================

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
  alamat_sekolah: "",
};
let masterKegiatan = [];
let masterRekeningBelanja = [];
let activeTab = "identitas";
let fiscalContexts = [];

function scopeFilterValue(context) {
  return encodeURIComponent(
    JSON.stringify({
      fiscal_year: context.fiscal_year,
      source_fund_id: context.source_fund_id || "",
      budget_id: context.budget_id || "",
    }),
  );
}

function scopeFilterParams(value) {
  if (!value || value === "all") return {};
  if (value === "unspecified") {
    return {
      fiscal_year: "unspecified",
      source_fund_id: "unspecified",
      budget_id: "unspecified",
    };
  }
  const context = JSON.parse(decodeURIComponent(value));
  return {
    fiscal_year: String(context.fiscal_year),
    source_fund_id: context.source_fund_id,
    budget_id: context.budget_id,
  };
}

function scopeQueryString(value) {
  return new URLSearchParams(scopeFilterParams(value)).toString();
}

function scopeLabel(context) {
  return `${context.fiscal_year} • ${context.source_fund_name || "Nama sumber dana tidak tersedia"}`;
}

function populateFiscalScopeFilters() {
  const transactionContexts = fiscalContexts.filter((item) => item.budget_id);
  const options = [
    { value: "all", label: "Semua tahun / sumber dana / anggaran" },
    ...transactionContexts.map((context) => ({
      value: scopeFilterValue(context),
      label: scopeLabel(context),
    })),
  ];
  for (const id of ["bku-scope-filter", "spj-scope-filter"]) {
    const select = document.getElementById(id);
    if (!select) continue;
    const previous = select.value || "all";
    select.replaceChildren(
      ...options.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    select.value = options.some((item) => item.value === previous)
      ? previous
      : "all";
  }

  const masterSelect = document.getElementById("master-scope-filter");
  if (masterSelect) {
    const masterScopes = [
      ...new Map(
        fiscalContexts.map((item) => [
          `${item.fiscal_year}:${item.source_fund_id}`,
          item,
        ]),
      ).values(),
    ];
    const masterOptions = [
      { value: "all", label: "Semua tahun / sumber dana" },
      ...masterScopes.map((context) => ({
        value: scopeFilterValue(context),
        label: `${context.fiscal_year} • ${context.source_fund_name || "Nama sumber dana tidak tersedia"}`,
      })),
    ];
    const previous = masterSelect.value || "all";
    masterSelect.replaceChildren(
      ...masterOptions.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    masterSelect.value = masterOptions.some((item) => item.value === previous)
      ? previous
      : "all";
  }

  const rekapSelect = document.getElementById("rekap-scope-filter");
  if (rekapSelect) {
    const rekapScopes = [
      ...new Map(
        fiscalContexts.map((item) => [
          `${item.fiscal_year}:${item.source_fund_id || ""}`,
          item,
        ]),
      ).values(),
    ];
    const rekapOptions = [
      { value: "all", label: "Semua tahun / sumber dana" },
      ...rekapScopes.map((context) => ({
        value: scopeFilterValue({ ...context, budget_id: "" }),
        label: scopeLabel(context),
      })),
    ];
    const previous = rekapSelect.value || "all";
    rekapSelect.replaceChildren(
      ...rekapOptions.map(({ value, label }) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    rekapSelect.value = rekapOptions.some((item) => item.value === previous)
      ? previous
      : "all";
  }
}

async function loadFiscalContexts() {
  const response = await apiFetch(`${API_BASE}/fiscal-contexts`);
  const result = await response.json();
  if (!response.ok || result.status !== "success") {
    throw new Error(result.detail || "Gagal memuat konteks tahun anggaran.");
  }
  fiscalContexts = result.data || [];
  populateFiscalScopeFilters();
}

// ---- Identitas Satuan Pendidikan per periode (menu terpadu: kop + surat + pejabat) ----
let identitasPeriodeList = []; // daftar entri dari GET /identitas-periode
let identitasAktifId = null;   // entri yang tercetak untuk tanggal uji saat ini
let identitasFormMode = "new"; // "new" | "edit"
let identitasEditingId = null; // id entri yang sedang diedit

// Helper
function formatRupiah(num) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(num);
}

// ===================== NOTIFIKASI / PERINGATAN / KONFIRMASI KUSTOM ==========
// Semua UI bersifat non-blocking, bertema native, dan TIDAK lagi memakai
// alert/confirm/prompt bawaan browser (diblokir total di ui.js).
// showMessage & showToast dipertahankan sebagai API lama namun didelegasikan
// ke implementasi kustom yang anti-bug (lihat src/ui.js).
function showMessage(type, text) {
  const map = {
    success: "success",
    error: "error",
    danger: "error",
    warning: "warning",
    info: "info",
  };
  UI.notify({
    type: map[type] || "info",
    title: "Pemberitahuan",
    message: String(text ?? ""),
    duration: 4000,
  });
}

function showToast(title, message, actionText = null, actionCallback = null) {
  // Deteksi tipe dari judul agar pemanggil lama otomatis mendapat warna tepat.
  const t = String(title || "").toLowerCase();
  let type = "info";
  if (t.includes("berhasil") || t.includes("sukses") || t.includes("success"))
    type = "success";
  else if (t.includes("gagal") || t.includes("error")) type = "error";
  else if (
    t.includes("peringatan") ||
    t.includes("warn") ||
    t.includes("hatau")
  )
    type = "warning";
  return UI.notify({
    type,
    title: String(title || "Notifikasi"),
    message: message instanceof Error ? message.message : String(message ?? ""),
    actionText,
    onAction: actionCallback,
  });
}
// ============================================================================

// Load settings
async function loadPengaturan() {
  try {
    const res = await apiFetch(`${API_BASE}/pengaturan`);
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
    nama_sekolah: pengaturan.nama_sekolah,
    nama_kepala: pengaturan.nama_kepala_sekolah,
    nip_kepala: pengaturan.nip_kepala_sekolah,
    nama_bendahara: pengaturan.nama_bendahara,
    nip_bendahara: pengaturan.nip_bendahara,
    nama_pengurus_barang: pengaturan.nama_pengurus_barang,
    nip_pengurus_barang: pengaturan.nip_pengurus_barang,
    alamat_sekolah: pengaturan.alamat_sekolah,
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
    const filterValue = document.getElementById("master-scope-filter")?.value;
    const filter = scopeFilterParams(filterValue);
    const params = new URLSearchParams();
    if (filter.fiscal_year && filter.fiscal_year !== "unspecified") {
      params.set("fiscal_year", filter.fiscal_year);
    }
    if (filter.source_fund_id && filter.source_fund_id !== "unspecified") {
      params.set("source_fund_id", filter.source_fund_id);
    }
    const query = params.toString();
    const res = await apiFetch(
      `${API_BASE}/master-kegiatan${query ? `?${query}` : ""}`,
    );
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
    pengaturan.nama_kepala_sekolah =
      document.getElementById("nama_kepala").value;
    pengaturan.nip_kepala_sekolah = document.getElementById("nip_kepala").value;
    pengaturan.nama_bendahara = document.getElementById("nama_bendahara").value;
    pengaturan.nip_bendahara = document.getElementById("nip_bendahara").value;
    pengaturan.nama_pengurus_barang = document.getElementById(
      "nama_pengurus_barang",
    ).value;
    pengaturan.nip_pengurus_barang = document.getElementById(
      "nip_pengurus_barang",
    ).value;
    pengaturan.alamat_sekolah = document.getElementById("alamat_sekolah").value;

    const res = await apiFetch(`${API_BASE}/pengaturan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pengaturan),
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
window.updateFileList = function () {
  const input = document.getElementById("bkuFile");
  const display = document.getElementById("selected-files");
  if (!input || !display) return;

  // Bersihkan daftar sebelumnya
  display.innerHTML = "";

  if (input.files.length > 0) {
    // Validasi Maksimal 12
    if (input.files.length > 12) {
      showToast("Error!", "Maksimal 12 file!");
      try {
        input.value = "";
      } catch (e) { }
      return;
    }

    // Judul List (selaras dengan gaya BHP uploader)
    const title = document.createElement("div");
    title.style.cssText =
      "margin: 8px 0 6px 0; font-weight: bold; font-size: 13px; color: #333;";
    title.innerHTML = `${iconSvg("fileText", 14)} File Terpilih (${input.files.length}/12):`;
    display.appendChild(title);

    // Render Daftar File (gaya konsisten dengan BHP)
    Array.from(input.files).forEach((file, index) => {
      const item = document.createElement("div");
      item.style.cssText =
        "background: #f8f9fa; padding:8px 12px; margin-bottom:6px; border-radius:6px; display:flex; justify-content:space-between; align-items:center;";
      item.innerHTML = `<div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:85%">${index + 1}. ${file.name}</div><div style="color:#666; font-size:12px">${(file.size / 1024).toFixed(0)} KB</div>`;
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
    const res = await apiFetch(`${API_BASE}/extract-bku`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      const result = await res.json();

      // Pastikan bkuData didefinisikan secara global jika ingin diakses fungsi lain
      bkuData = result.data;

      showToast(
        "Berhasil!",
        `Berhasil extract ${bkuData.transaksi.length} data BKU dari ${files.length} file.`,
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

function chooseArkasSyncMode(context, transactionCount, sourceName) {
  return new Promise((resolve) => {
    document
      .querySelectorAll(".ui-dialog-overlay")
      .forEach((overlay) => overlay.remove());

    const overlay = document.createElement("div");
    overlay.className = "ui-dialog-overlay ui-dialog-kind-confirm";
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const header = document.createElement("div");
    header.className = "ui-dialog-head";
    const title = document.createElement("h3");
    title.className = "ui-dialog-title";
    title.textContent = "Pilih cara sinkron ARKAS";
    header.appendChild(title);
    const body = document.createElement("div");
    body.className = "ui-dialog-body";
    const message = document.createElement("p");
    message.className = "ui-dialog-message";
    message.textContent =
      `Sumber: ${sourceName}. Ditemukan ${transactionCount} baris BPU ` +
      `untuk ${scopeLabel(context)}. Sinkron hanya memengaruhi tahun, ` +
      "sumber dana, dan anggaran yang dipilih; data di luar lingkup tetap aman. " +
      "Pilih bagaimana menangani nomor bukti yang sudah ada.";
    body.appendChild(message);
    const footer = document.createElement("div");
    footer.className = "ui-dialog-foot";
    footer.style.flexWrap = "wrap";

    const finish = (mode) => {
      document.removeEventListener("keydown", handleKeydown, true);
      overlay.remove();
      resolve(mode);
    };
    const choices = [
      {
        mode: "replace_all",
        label: "Ganti data pada konteks ini",
        className: "btn btn-danger",
      },
      {
        mode: "keep",
        label: "Pertahankan data lama",
        className: "btn btn-outline-primary",
      },
      {
        mode: "update",
        label: "Perbarui nomor bukti yang sama",
        className: "btn btn-success",
      },
    ];
    choices.forEach(({ mode, label, className }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.addEventListener("click", () => finish(mode));
      footer.appendChild(button);
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = "Batal";
    cancel.addEventListener("click", () => finish(null));
    footer.appendChild(cancel);

    function handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    }

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    document.addEventListener("keydown", handleKeydown, true);
    document.body.appendChild(overlay);
    footer.querySelector("button")?.focus();
  });
}

async function changeArkasDatabase() {
  if (typeof window.electronAPI?.selectArkasDatabase !== "function") {
    showToast("Error!", "Pengaturan database ARKAS hanya tersedia di aplikasi desktop.");
    return;
  }
  try {
    const selected = await window.electronAPI.selectArkasDatabase();
    if (selected.canceled) return;
    showToast("Berhasil!", `Lokasi database ARKAS disimpan: ${selected.sourceName}.`);
  } catch (error) {
    showToast("Error!", error.message || "Gagal menyimpan database ARKAS.");
  }
}

function chooseArkasContext(contexts, title = "Pilih konteks anggaran") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "ui-dialog-overlay ui-dialog-kind-confirm";
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const header = document.createElement("div");
    header.className = "ui-dialog-head";
    const heading = document.createElement("h3");
    heading.className = "ui-dialog-title";
    heading.textContent = title;
    header.appendChild(heading);
    const body = document.createElement("div");
    body.className = "ui-dialog-body";
    const select = document.createElement("select");
    select.className = "form-control";
    select.style.width = "100%";
    contexts.forEach((context, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = scopeLabel(context);
      select.appendChild(option);
    });
    const currentYearIndex = contexts.findIndex(
      (item) => item.fiscal_year === new Date().getFullYear(),
    );
    if (currentYearIndex >= 0) select.value = String(currentYearIndex);
    body.appendChild(select);
    const footer = document.createElement("div");
    footer.className = "ui-dialog-foot";
    const finish = (selected) => {
      overlay.remove();
      resolve(selected);
    };
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "btn btn-primary";
    confirm.textContent = "Pilih";
    confirm.addEventListener("click", () =>
      finish(contexts[Number(select.value)] || null),
    );
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = "Batal";
    cancel.addEventListener("click", () => finish(null));
    footer.append(confirm, cancel);
    dialog.append(header, body, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

function selectedArkasContext(filterId, contexts, requireBudget = true) {
  const value = document.getElementById(filterId)?.value || "all";
  if (value === "all" || value === "unspecified") return null;
  const filter = JSON.parse(decodeURIComponent(value));
  return contexts.find(
    (context) =>
      String(context.fiscal_year) === String(filter.fiscal_year) &&
      String(context.source_fund_id || "") ===
        String(filter.source_fund_id || "") &&
      (!requireBudget ||
        String(context.budget_id || "") === String(filter.budget_id || "")),
  ) || null;
}

async function syncArkas() {
  if (
    !window.electronAPI ||
    typeof window.electronAPI.readArkasTransactions !== "function"
  ) {
    showToast("Error!", "Fitur Sinkron ARKAS hanya tersedia di aplikasi desktop.");
    return;
  }

  showToast("Info!", "Membaca database ARKAS...");
  try {
    const catalog = await window.electronAPI.readArkasContexts();
    if (catalog.canceled) return;
    const contexts = catalog.contexts || [];
    if (!contexts.length) {
      showToast("Warning!", "Tidak ditemukan tahun, sumber dana, atau anggaran ARKAS aktif.");
      return;
    }
    const contextIndex = new Map(
      [...fiscalContexts, ...contexts].map((item) => [
        `${item.fiscal_year}:${item.source_fund_id}:${item.budget_id}`,
        item,
      ]),
    );
    fiscalContexts = [...contextIndex.values()];
    populateFiscalScopeFilters();
    let context = selectedArkasContext("bku-scope-filter", contexts);
    if (!context) context = await chooseArkasContext(contexts);
    if (!context) return;
    const imported = await window.electronAPI.readArkasTransactions({
      fiscalYear: context.fiscal_year,
      sourceFundId: context.source_fund_id,
      budgetId: context.budget_id,
    });
    if (imported.canceled) return;
    if (!imported.transactions?.length) {
      showToast(
        "Warning!",
        `Tidak ditemukan transaksi BPU untuk ${scopeLabel(context)}.`,
      );
      return;
    }

    const mode = await chooseArkasSyncMode(
      context,
      imported.returned,
      imported.sourceName,
    );
    if (!mode) return;

    if (
      mode === "replace_all" &&
      !(await UI.confirm(
        `Data BKU dan SPJ pada konteks ${scopeLabel(context)} akan diganti ` +
          "dengan data ARKAS. Data tahun, sumber dana, atau anggaran lain tetap dipertahankan. Lanjutkan?",
        {
          title: "Konfirmasi Hapus Semua Data BKU",
          okText: "Hapus dan Impor",
          danger: true,
        },
      ))
    ) {
      return;
    }

    const response = await apiFetch(`${API_BASE}/transaksi/import-arkas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, transaksi: imported.transactions }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "Gagal mengimpor data ARKAS.");
    }

    await loadFiscalContexts();
    const selectedScopeValue = scopeFilterValue(context);
    const bkuFilter = document.getElementById("bku-scope-filter");
    const spjFilter = document.getElementById("spj-scope-filter");
    if (bkuFilter) bkuFilter.value = selectedScopeValue;
    if (spjFilter) spjFilter.value = selectedScopeValue;
    await loadDataBKU();
    await loadKwitansiList();
    const modeDescription = {
      replace_all: "Data pada konteks terpilih diganti",
      keep: "Data dengan nomor bukti yang sudah ada dipertahankan",
      update: "Data dengan nomor bukti yang sama diperbarui",
    }[mode];
    showToast(
      "Berhasil!",
      `${modeDescription}. ${result.saved_count} baris diimpor, ` +
        `${result.deleted_count} baris diganti/dihapus, ` +
        `${result.skipped_count} baris dilewati. ` +
        `${result.synced_kwitansi_count} SPJ diperbarui dan ` +
        `${result.created_kwitansi_count} SPJ dibuat.`,
    );
  } catch (error) {
    showToast("Error!", error.message || "Gagal membaca database ARKAS.");
  }
}

function renderBkuShopIdentity(item) {
  const name = String(item.nama_toko || "").trim();
  const details = [
    item.alamat_toko,
    item.no_telp_toko,
    item.npwp_toko ? `NPWP: ${item.npwp_toko}` : "",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" | ");
  return `<td title="${escapeSpjFormValue(details)}">${escapeSpjFormValue(name || "-")}${
    details
      ? `<small style="display:block;color:#64748b;font-size:11px;">${escapeSpjFormValue(details)}</small>`
      : ""
  }</td>`;
}

function renderFiscalContext(item) {
  if (item.fiscal_year == null) {
    return '<small style="display:block;color:#64748b;font-size:11px;">Belum ditentukan</small>';
  }
  const context = [
    item.fiscal_year,
    item.source_fund_name || "Nama sumber dana tidak tersedia",
  ]
    .filter(Boolean)
    .map(escapeSpjFormValue)
    .join(" • ");
  return `<small style="display:block;color:#64748b;font-size:11px;">${context}</small>`;
}

function displayKwitansiNumber(item) {
  let number = String(item.nomor_kwitansi || "");
  if (item.source_fund_id || item.budget_id) {
    const internalScopeSuffix =
      `/${item.source_fund_id || "-"}-${item.budget_id || "-"}`;
    if (number.endsWith(internalScopeSuffix)) {
      number = number.slice(0, -internalScopeSuffix.length);
    }
  }
  return escapeSpjFormValue(number);
}

// Save data BKU
async function saveTransaksi() {
  if (!bkuData || !bkuData.transaksi || bkuData.transaksi.length === 0) {
    showToast("Warning!", "Tidak ada data BKU untuk disimpan");
    return;
  }

  // Step 1: request preview (no DB writes)
  showToast("info!", "Meminta preview sebelum menyimpan...");
  try {
    const previewRes = await apiFetch(
      `${API_BASE}/save-transaksi?force=false`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bkuData),
      },
    );

    if (!previewRes.ok) {
      const e = await previewRes.json();
      showToast("Error!", e.detail || "Gagal mendapatkan preview penyimpanan");
      return;
    }

    const preview = await previewRes.json();

    // If server returned a preview, ask for confirmation (especially if BPU rows would be removed)
    if (preview && preview.status === "preview") {
      const wouldDelete = preview.would_delete_rows || 0;
      const wouldDeleteBpu = preview.would_delete_bpu_rows || 0;
      const wouldInsert = preview.would_insert || 0;

      let msg = `Aksi ini akan menghapus ${wouldDelete} baris data Buku Kas Umum dan memasukkan ${wouldInsert} baris data Buku Kas Umum yang baru.`;
      if (wouldDeleteBpu > 0)
        msg += `\nIni juga akan menghapus data Buku Kas Umum yang mungkin sudah diperbaiki!`;
      msg += "\nApakah Anda yakin ingin melanjutkan?";

      if (
        !(await UI.confirm(msg, {
          title: "Konfirmasi Penyimpanan BKU",
          okText: "Ya, Simpan",
        }))
      ) {
        showToast("info!", "Simpan dibatalkan oleh pengguna.");
        return;
      }

      // User confirmed — perform actual save with force=true
      const finalRes = await apiFetch(`${API_BASE}/save-transaksi?force=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bkuData),
      });

      if (!finalRes.ok) {
        const err = await finalRes.json();
        showToast("Error!", err.detail || "Error menyimpan transaksi");
        return;
      }

      const result = await finalRes.json();
      showToast(
        "Berhasil!",
        `Berhasil menyimpan ${result.saved_count || 0} data BKU`,
      );

      // Refresh transaksi dari server
      try {
        const trxRes = await apiFetch(`${API_BASE}/transaksi`);
        if (!trxRes.ok) throw new Error("Gagal fetch transaksi");

        const trxJson = await trxRes.json();
        const transactions = trxJson.data || [];

        // Pertahankan kwitansi_list jika ada
        bkuData = {
          transaksi: transactions,
          kwitansi_list: bkuData?.kwitansi_list || [],
        };

        // Render ulang tabel
        renderBKUResult();
      } catch (refreshErr) {
        showToast(
          "Warning!",
          "Data disimpan tapi gagal refresh: " + refreshErr.message,
        );
        // Coba render ulang dengan data yang ada
        renderBKUResult();
      }
    } else if (preview && preview.status === "success") {
      // If server already applied (unlikely) show success
      showToast(
        "Berhasil!",
        `Berhasil menyimpan ${preview.saved_count || 0} data BKU`,
      );
    } else {
      showToast("Error!", preview?.detail || "Respon preview tidak dikenal");
    }
  } catch (err) {
    console.error("saveTransaksi error:", err);
    showToast("Error!", "Error: " + (err.message || err));
  }
}

// --------------------------
// BHP/BHM Upload & Mapping
// --------------------------
function updateBhpFileList() {
  const input = document.getElementById("bhpFile");
  const display = document.getElementById("selected-bhp-files");
  display.innerHTML = "";
  if (!input || !display) return;
  if (input.files.length > 24) {
    showToast("Error!", "Maksimal 24 file untuk BHP/BHM!");
    input.value = "";
    return;
  }
  if (input.files.length === 0) return;
  const title = document.createElement("div");
  title.style.cssText =
    "margin: 8px 0 6px 0; font-weight: bold; font-size: 13px; color: #333;";
  title.innerHTML = `${iconSvg("fileText", 14)} File BHP/BHM Terpilih (${input.files.length}/24):`;
  display.appendChild(title);
  Array.from(input.files).forEach((file, idx) => {
    const item = document.createElement("div");
    item.style.cssText = `background: #f8f9fa; padding:8px 12px; margin-bottom:6px; border-radius:6px; display:flex; justify-content:space-between; align-items:center;`;
    item.innerHTML = `<div style="overflow:hidden; white-space:nowrap; text-overflow:ellipsis; max-width:85%">${idx + 1}. ${file.name}</div><div style="color:#666; font-size:12px">${(file.size / 1024).toFixed(0)} KB</div>`;
    display.appendChild(item);
  });
}

function resetBhpSelection() {
  const input = document.getElementById("bhpFile");
  const display = document.getElementById("selected-bhp-files");
  if (input)
    try {
      input.value = "";
    } catch (e) { }
  if (display) display.innerHTML = "";
  const res = document.getElementById("bhp-result");
  if (res) res.innerHTML = "";
}

function resetBkuSelection() {
  const input = document.getElementById("bkuFile");
  const display = document.getElementById("selected-files");
  if (input)
    try {
      input.value = "";
    } catch (e) { }
  if (display) display.innerHTML = "";
  const res = document.getElementById("bku-result");
  if (res) res.innerHTML = "";
  // Clear any previously extracted data
  bkuData = null;
}

async function extractBHP() {
  const input = document.getElementById("bhpFile");
  if (!input || !input.files.length) {
    showToast("Error!", "Pilih file BHP/BHM terlebih dahulu!");
    return;
  }
  // BHP/BHM can be applied independently from BKU extraction — it directly updates transaksi table
  if (input.files.length > 24) {
    showToast("Error!", "Maksimal 24 file!");
    return;
  }

  const formData = new FormData();
  Array.from(input.files).forEach((f) => formData.append("files", f));
  const jenis = document.getElementById("bhp-type")
    ? document.getElementById("bhp-type").value
    : "BHP";
  formData.append("jenis", jenis);

  showToast(
    "Info!",
    `Sedang mengekstrak ${input.files.length} file ${jenis}...`,
  );

  try {
    const res = await apiFetch(`${API_BASE}/extract-bhp`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json();
      showToast("Error!", err.detail || "Gagal ekstrak BHP/BHM");
      return;
    }
    const json = await res.json();
    const bhpData = json.data || [];
    // Send extracted BHP data to backend to apply changes server-side
    try {
      const applyRes = await apiFetch(`${API_BASE}/apply-bhp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bhpData),
      });

      if (!applyRes.ok) {
        const err2 = await applyRes.json();
        showToast(
          "Error!",
          err2.detail || "Gagal menerapkan perbaikan BHP/BHM",
        );
        return;
      }

      const applyJson = await applyRes.json();
      const deleted = applyJson.deleted || 0;
      const inserted = applyJson.inserted || 0;
      window.lastBhpAppliedCount = inserted;

      // Refresh BKU data from server so frontend mirrors DB
      try {
        const trxRes = await apiFetch(`${API_BASE}/transaksi`);
        const trxJson = await trxRes.json();
        bkuData = { transaksi: trxJson.data || [] };
      } catch (err3) {
        showToast("Error!", "Gagal refresh transaksi: " + err3);
      }

      showToast(
        "Berhasil!",
        `Ekstrak selesai: ${deleted} baris diganti, ${inserted} baris dimasukkan`,
      );
      const resDiv = document.getElementById("bhp-result");
      if (resDiv)
        resDiv.innerHTML = `<div class="alert alert-info">Ekstrak selesai — <strong>${deleted}</strong> baris diganti, <strong>${inserted}</strong> baris dimasukkan.</div>`;
      renderBKUResult();
    } catch (err2) {
      showToast("Error!", "Error applying BHP/BHM: " + (err2.message || err2));
    }
  } catch (err) {
    showToast("Error!", "Error: " + (err.message || err));
  }
}

function normalizeNoBukti(v) {
  if (!v) return "";
  return v.toString().replace(/\s|\W/g, "").toLowerCase();
}

function normalizeDateToDDMMYYYY(input) {
  if (!input) return "";
  // Try parsing common formats
  let d = null;
  // If already dd-mm-yyyy or dd/mm/yyyy
  if (/^\d{2}[\-\/]\d{2}[\-\/]\d{4}$/.test(input)) {
    return input.replace(/\//g, "-");
  }
  // If yyyy-mm-dd
  if (/^\d{4}\-\d{2}\-\d{2}$/.test(input)) {
    const parts = input.split("-");
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  // Fallback: try Date parsing
  const tmp = new Date(input);
  if (!isNaN(tmp.getTime())) {
    const dd = String(tmp.getDate()).padStart(2, "0");
    const mm = String(tmp.getMonth() + 1).padStart(2, "0");
    const yyyy = tmp.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }
  return "";
}

function applyBhpToBKU(bhpItems) {
  if (!bkuData || !Array.isArray(bhpItems) || bhpItems.length === 0) return 0;
  let modified = 0;
  bhpItems.forEach((b) => {
    const nbRaw = (b.no_bukti || b["No Bukti"] || b["no_bukti"] || "")
      .toString()
      .trim();
    if (!nbRaw) return;
    const nb = normalizeNoBukti(nbRaw);
    // try exact matches first
    const matches = bkuData.transaksi.filter(
      (t) => normalizeNoBukti(t.no_bukti) === nb,
    );
    const candidates = matches.length
      ? matches
      : bkuData.transaksi.filter(
        (t) =>
          normalizeNoBukti(t.no_bukti || "").includes(nb) ||
          nb.includes(normalizeNoBukti(t.no_bukti || "")),
      );

    candidates.forEach((t) => {
      // Update tanggal (if present)
      const newTanggal = normalizeDateToDDMMYYYY(
        b.tanggal || b.Tanggal || b.tanggal_bhp || b.tgl || "",
      );
      if (newTanggal) t.tanggal = newTanggal;

      // Update harga_satuan (if present and numeric)
      const rawHarga =
        b.harga_satuan ||
        b["Harga Satuan"] ||
        b.harga ||
        b.harga_satuan_bhp ||
        "";
      const h = parseFloat(
        String(rawHarga)
          .toString()
          .replace(/[^0-9\-\.]/g, ""),
      );
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
    const params = new URLSearchParams(
      scopeFilterParams(document.getElementById("spj-scope-filter")?.value),
    );
    const thp = document.getElementById("spj-thp-filter")?.value || "all";
    const month = document.getElementById("spj-month-filter")?.value || "all";
    if (thp !== "all") params.set("thp", thp);
    if (month !== "all") params.set("month", month);
    const query = params.toString();
    const res = await apiFetch(
      `${API_BASE}/kwitansi${query ? `?${query}` : ""}`,
    );
    const json = await res.json();

    if (json.status === "success") {
      // SIMPAN KE VARIABEL GLOBAL bkuData UNTUK PENCARIAN
      bkuData = {
        transaksi: bkuData?.transaksi || [],
        kwitansi_list: json.data,
      };
      renderKwitansiList(json.data);
    }
  } catch (err) {
    showToast("Error!", "Gagal memuat data SPJ: " + err.message);
  }
}

// Generate Kwitansi
async function generateKwitansi() {
  const filterValue =
    document.getElementById("spj-scope-filter")?.value || "all";
  const scopeLabelText =
    document.getElementById("spj-scope-filter")?.selectedOptions?.[0]?.textContent ||
    "semua konteks";
  if (
    !(await UI.confirm(
      filterValue === "all"
        ? "Generate ulang semua Data SPJ? Data SPJ lama pada semua konteks akan diganti."
        : `Generate ulang Data SPJ untuk ${scopeLabelText}? Konteks lain tidak akan diubah.`,
      { title: "Generate Ulang SPJ", okText: "Ya, Generate" },
    ))
  ) {
    return;
  }

  try {
    const query = scopeQueryString(filterValue);
    const res = await apiFetch(
      `${API_BASE}/kwitansi/generate${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "Gagal membuat SPJ.");
    showToast("Berhasil!", `Berhasil generate ${json.generated} SPJ`);
    await loadKwitansiList();
  } catch (error) {
    showToast("Gagal!", error.message || "Gagal membuat SPJ.");
  }
}

// Download Kwitansi (SPJ) — RENDER PDF SEPENUHNYA DI FRONTEND
// Alur: GET /kwitansi/{id}/spj-data (JSON saja; tidak ada permintaan/ respons
// application/pdf dari backend) -> validasi payload -> buildSpjPdf() (pdfmake,
// font Arial via IPC Electron) -> unduh Blob dengan nama file aman.
async function downloadKwitansi(id, noBukti = "") {
  showToast("Info", "Mengunduh SPJ...");
  appLog("info", `downloadKwitansi: mulai render SPJ frontend id=${id}`);

  try {
    const response = await apiFetch(`${API_BASE}/kwitansi/${id}/spj-data`);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        err.detail || `Gagal memuat data SPJ (HTTP ${response.status})`,
      );
    }

    // Validasi tipe konten: endpoint ini WAJIB JSON. Kalau backend (atau
    // proxy) mengirim application/pdf, hentikan di sini — alur baru tidak
    // boleh menerima PDF dari backend.
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      throw new Error(
        `Respons backend bukan JSON (Content-Type: ${contentType || "kosong"}); ` +
        "alur unduh SPJ hanya menerima data JSON untuk dirender di frontend",
      );
    }

    const payload = await response.json();
    if (payload.status !== "success" || !payload.data) {
      throw new Error(payload.detail || "Backend tidak mengirim payload SPJ yang valid");
    }

    setBackendOriginGetter(() => _backendOrigin);
    const blob = await buildSpjPdf(payload.data);
    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new Error("Renderer frontend menghasilkan PDF kosong");
    }
    const objectUrl = window.URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    const requestedFileName =
      noBukti || payload.data.document?.filename || String(id);
    const safeFileName = String(requestedFileName)
      .replace(/\.pdf$/i, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/^[. ]+/, "")
      .slice(0, 120) || `kwitansi-${id}`;
    downloadLink.download = `SPJ-${safeFileName}.pdf`;

    document.body.appendChild(downloadLink);
    downloadLink.click();

    document.body.removeChild(downloadLink);
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
    appLog(
      "info",
      `downloadKwitansi: OK id=${id} file=${downloadLink.download} ukuran=${blob.size} byte (render frontend)`,
    );
    showToast("Berhasil!", "SPJ berhasil diunduh");
  } catch (err) {
    // Error JANGAN disembunyikan: tampilkan dan catat ke app.log.
    const msg = err?.message || String(err);
    appLog("error", `downloadKwitansi: GAGAL id=${id}: ${msg}`);
    console.error("downloadKwitansi gagal:", err);
    showToast("Error!", "Gagal membuat PDF SPJ: " + msg);
  }
}

let _spjPreviewState = null;
let _spjPreviewGeneration = 0;
let _pdfJsPromise = null;

function loadPdfJs() {
  if (!_pdfJsPromise) {
    _pdfJsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ])
      .then(([pdfjsLib, worker]) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
        return pdfjsLib;
      })
      .catch((err) => {
        _pdfJsPromise = null;
        throw err;
      });
  }
  return _pdfJsPromise;
}

function disposeSpjPreview() {
  _spjPreviewGeneration += 1;
  if (!_spjPreviewState) return;
  _spjPreviewState.renderTask?.cancel();
  const task = _spjPreviewState.loadingTask;
  _spjPreviewState = null;
  if (task) {
    task.destroy().catch((err) => {
      appLog("warn", `previewKwitansi: gagal menutup dokumen PDF: ${err.message || err}`);
    });
  }
}

async function renderSpjPreviewPages() {
  const state = _spjPreviewState;
  const container = document.getElementById("spj-preview-pages");
  if (!state || !container) return;

  state.renderGeneration = (state.renderGeneration || 0) + 1;
  const renderGeneration = state.renderGeneration;
  state.renderTask?.cancel();
  container.replaceChildren();

  for (let pageNumber = 1; pageNumber <= state.document.numPages; pageNumber += 1) {
    if (state !== _spjPreviewState || renderGeneration !== state.renderGeneration) return;
    const page = await state.document.getPage(pageNumber);
    if (state !== _spjPreviewState || renderGeneration !== state.renderGeneration) return;

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = state.zoom || 1;
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 1.5);
    const pageContainer = document.createElement("div");
    pageContainer.className = "spj-preview-page";
    const canvas = document.createElement("canvas");
    canvas.className = "spj-preview-canvas";
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    pageContainer.appendChild(canvas);
    container.appendChild(pageContainer);

    const renderTask = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    });
    state.renderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (error) {
      if (error?.name === "RenderingCancelledException") return;
      throw error;
    } finally {
      if (state.renderTask === renderTask) state.renderTask = null;
    }
  }
}

async function setSpjPreviewZoom(zoom) {
  const state = _spjPreviewState;
  if (!state) return;
  state.zoom = Math.min(3, Math.max(0.25, Number(zoom) || 1));
  const zoomLabel = document.getElementById("spj-preview-zoom");
  if (zoomLabel) zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  try {
    await renderSpjPreviewPages();
  } catch (error) {
    if (error?.name === "RenderingCancelledException") return;
    const message = error?.message || String(error);
    appLog("error", `previewKwitansi: gagal merender ulang pada zoom ${state.zoom}: ${message}`);
    showToast("Error!", `Gagal mengubah zoom preview SPJ: ${message}`);
  }
}

async function fitSpjPreviewWidth() {
  const state = _spjPreviewState;
  const container = document.getElementById("spj-preview-pages");
  if (!state || !container) return;
  try {
    const firstPage = await state.document.getPage(1);
    if (state !== _spjPreviewState) return;
    const pageWidth = firstPage.getViewport({ scale: 1 }).width;
    const fitScale = Math.min(1.5, Math.max(0.25, (container.clientWidth - 48) / pageWidth));
    await setSpjPreviewZoom(fitScale);
  } catch (error) {
    if (state !== _spjPreviewState || error?.name === "RenderingCancelledException") return;
    const message = error?.message || String(error);
    appLog("error", `previewKwitansi: gagal menyesuaikan lebar halaman: ${message}`);
    showToast("Error!", `Gagal menyesuaikan lebar preview SPJ: ${message}`);
  }
}

function adjustSpjPreviewZoom(delta) {
  if (_spjPreviewState) {
    void setSpjPreviewZoom(_spjPreviewState.zoom + delta);
  }
}

async function previewKwitansi(id) {
  showPopup(`
    <div class="popup-content spj-preview-popup" style="width:min(1200px,96vw); max-width:96vw;">
      <div class="popup-header">
        <div>
          <h3 style="margin:0;">Preview SPJ</h3>
          <small style="color:#666;">Memuat data terbaru...</small>
        </div>
        <button class="btn btn-secondary" onclick="closePopup()">Tutup</button>
      </div>
      <div class="popup-body spj-preview-popup-body">
        <div id="spj-preview-frame" class="spj-preview-frame">
          Menyiapkan preview SPJ...
        </div>
      </div>
    </div>
  `);
  // Abaikan hasil lambat bila popup ditutup atau pengguna membuka preview lain.
  const requestId = ++_spjPreviewGeneration;

  try {
    const response = await apiFetch(`${API_BASE}/kwitansi/${id}/spj-data`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        error.detail || `Gagal memuat data SPJ (HTTP ${response.status})`,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      throw new Error(`Respons backend bukan JSON (${contentType || "kosong"})`);
    }
    const payload = await response.json();
    if (payload.status !== "success" || !payload.data) {
      throw new Error(payload.detail || "Backend tidak mengirim payload SPJ yang valid");
    }

    setBackendOriginGetter(() => _backendOrigin);
    const blob = await buildSpjPdf(payload.data);
    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new Error("Renderer frontend menghasilkan PDF kosong");
    }
    const previewContainer = document.getElementById("spj-preview-frame");
    if (!previewContainer || requestId !== _spjPreviewGeneration) return;

    const pdfjsLib = await loadPdfJs();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
    });
    const pdfDocument = await loadingTask.promise;
    if (requestId !== _spjPreviewGeneration) {
      await loadingTask.destroy();
      return;
    }
    _spjPreviewState = {
      loadingTask,
      document: pdfDocument,
      renderTask: null,
      zoom: 1,
    };
    previewContainer.innerHTML = `
      <div class="spj-preview-toolbar" role="toolbar" aria-label="Kontrol preview SPJ">
        <span class="spj-preview-page-count">${pdfDocument.numPages} halaman</span>
        <div class="spj-preview-zoom-controls">
          <button type="button" class="btn btn-secondary btn-sm" aria-label="Perkecil preview" title="Perkecil" onclick="adjustSpjPreviewZoom(-0.1)">−</button>
          <button type="button" id="spj-preview-zoom" class="btn btn-secondary btn-sm spj-preview-zoom-value" aria-label="Kembalikan zoom ke 100%" title="Kembalikan ke 100%" onclick="setSpjPreviewZoom(1)">100%</button>
          <button type="button" class="btn btn-secondary btn-sm" aria-label="Perbesar preview" title="Perbesar" onclick="adjustSpjPreviewZoom(0.1)">+</button>
          <button type="button" class="btn btn-outline-primary btn-sm" onclick="fitSpjPreviewWidth()">Lebar halaman</button>
        </div>
      </div>
      <div id="spj-preview-pages" class="spj-preview-pages">
      </div>
    `;
    await fitSpjPreviewWidth();
    const subtitle = document.querySelector("#popup-overlay .popup-header small");
    if (subtitle) subtitle.textContent = "Preview menggunakan data tersimpan terbaru.";
    appLog(
      "info",
      `previewKwitansi: OK id=${id}, jenis=${payload.data.jenis_belanja || "umum"}, halaman=${pdfDocument.numPages}, ukuran=${blob.size} byte`,
    );
  } catch (err) {
    if (err?.name === "RenderingCancelledException") return;
    if (requestId !== _spjPreviewGeneration) return;
    const message = err?.message || String(err);
    const previewContainer = document.getElementById("spj-preview-frame");
    if (previewContainer) {
      previewContainer.innerHTML = `<div class="alert alert-danger" role="alert">${escapeSpjFormValue(message)}</div>`;
    }
    appLog("error", `previewKwitansi: GAGAL id=${id}: ${message}`);
    showToast("Error!", `Gagal menampilkan preview SPJ: ${message}`);
  }
}

async function syncMasterKegiatanArkas() {
  if (typeof window.electronAPI?.readArkasActivities !== "function") {
    showToast("Error!", "Sinkron referensi ARKAS hanya tersedia di aplikasi desktop.");
    return;
  }
  showToast("Info!", "Membaca referensi kegiatan dari ARKAS...");
  try {
    const catalog = await window.electronAPI.readArkasContexts();
    if (catalog.canceled) return;
    fiscalContexts = [
      ...new Map(
        [...fiscalContexts, ...(catalog.contexts || [])].map((item) => [
          `${item.fiscal_year}:${item.source_fund_id}:${item.budget_id}`,
          item,
        ]),
      ).values(),
    ];
    populateFiscalScopeFilters();
    const scopeOptions = [
      ...new Map(
        (catalog.contexts || []).map((item) => [
          `${item.fiscal_year}:${item.source_fund_id}`,
          item,
        ]),
      ).values(),
    ];
    if (!scopeOptions.length) {
      showToast("Warning!", "Tidak ditemukan tahun dan sumber dana ARKAS aktif.");
      return;
    }
    let context = selectedArkasContext(
      "master-scope-filter",
      scopeOptions,
      false,
    );
    if (!context) {
      context = await chooseArkasContext(
        scopeOptions,
        "Pilih tahun dan sumber dana",
      );
    }
    if (!context) return;
    const imported = await window.electronAPI.readArkasActivities({
      fiscalYear: context.fiscal_year,
      sourceFundId: context.source_fund_id,
    });
    if (imported.canceled) return;
    if (!imported.activities?.length) {
      showToast(
        "Warning!",
        `Tidak ditemukan referensi kegiatan untuk tahun anggaran ${imported.fiscalYear}.`,
      );
      return;
    }

    const response = await apiFetch(`${API_BASE}/master-kegiatan/sync-arkas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: imported.activities }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "Gagal menyinkronkan referensi kegiatan.");
    }
    await loadFiscalContexts();
    const scopeSelect = document.getElementById("master-scope-filter");
    if (scopeSelect) {
      const selected = fiscalContexts.find(
        (item) =>
          Number(item.fiscal_year) === Number(context.fiscal_year) &&
          String(item.source_fund_id) === String(context.source_fund_id),
      );
      if (selected) scopeSelect.value = scopeFilterValue(selected);
    }
    await loadMasterKegiatan();
    showToast(
      "Berhasil!",
      `${result.created_count} kegiatan ditambahkan, ` +
        `${result.updated_count} diperbarui, ${result.unchanged_count} tetap. ` +
        `Referensi lokal yang tidak ada di ARKAS tidak dihapus.`,
    );
  } catch (error) {
    showToast("Error!", error.message || "Gagal membaca referensi kegiatan ARKAS.");
  }
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
      .map((row) => ({
        kode_rekening_belanja: String(
          row.kode_rekening_belanja ||
          row["kode_rekening_belanja"] ||
          row["kode"] ||
          "",
        ).trim(),
        nama_rekening_belanja: String(
          row.nama_rekening_belanja ||
          row["nama_rekening_belanja"] ||
          row["nama"] ||
          "",
        ).trim(),
        rekap_rekening_belanja: String(
          row.rekap_rekening_belanja || row["rekap_rekening_belanja"] || "",
        ).trim(),
        nilai_kapitalisasi_belanja:
          parseFloat(
            row.nilai_kapitalisasi_belanja ||
            row["nilai_kapitalisasi_belanja"] ||
            0,
          ) || 0,
      }))
      .filter(
        (item) => item.kode_rekening_belanja && item.nama_rekening_belanja,
      );

    const res = await apiFetch(`${API_BASE}/master-rekening-belanja/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: masterData }),
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
    const res = await apiFetch(`${API_BASE}/master-rekening-belanja`);
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
    container.innerHTML =
      "<p style='text-align:center; padding:20px;'>Belum ada data referensi rekening belanja.</p>";
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

  list.forEach((item) => {
    html += `
            <tr>
                <td><strong>${item.kode_rekening_belanja}</strong></td>
                <td>${item.nama_rekening_belanja}</td>
                <td>${item.rekap_rekening_belanja || "-"}</td>
                <td style="text-align:right">${item.nilai_kapitalisasi_belanja ? Number(item.nilai_kapitalisasi_belanja).toLocaleString("id-ID") : "-"}</td>
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
  if (
    !(await UI.confirm("Hapus rekening belanja ini?", {
      title: "Hapus Rekening Belanja",
      okText: "Hapus",
      danger: true,
    }))
  )
    return;

  try {
    const response = await apiFetch(
      `${API_BASE}/master-rekening-belanja/${id}`,
      {
        method: "DELETE",
      },
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.detail || "Gagal menghapus rekening.");
    }

    // Hapus dari array lokal masterRekeningBelanja
    masterRekeningBelanja = masterRekeningBelanja.filter(
      (item) => item.id !== id,
    );

    // Render ulang tabel Master Rekening
    renderMasterRekeningBelanja();

    showToast("Berhasil!", "Data Referensi Rekening Belanja berhasil dihapus.");
  } catch (error) {
    showToast("Gagal!", `Gagal menghapus: ${error.message}`);
  }
}

// Generate / Render Rekap Transaksi
async function generateRekapTransaksi(forceDetails = false) {
  showToast("info!", "Memproses rekap...");
  try {
    const include =
      forceDetails || document.getElementById("rekap-include-details")?.checked;
    const thp = document.getElementById("rekap-thp-select")
      ? document.getElementById("rekap-thp-select").value
      : "all";
    const scope = scopeFilterParams(
      document.getElementById("rekap-scope-filter")?.value,
    );
    const scopeLabelText =
      document.getElementById("rekap-scope-filter")?.selectedOptions?.[0]
        ?.textContent || "Semua tahun / sumber dana";
    const params = new URLSearchParams({
      details: include ? "1" : "0",
      thp,
    });
    if (scope.fiscal_year) params.set("fiscal_year", scope.fiscal_year);
    if (scope.source_fund_id) {
      params.set("source_fund_id", scope.source_fund_id);
    }
    const res = await apiFetch(
      `${API_BASE}/rekap-transaksi?${params}`,
    );
    const json = await res.json();
    if (json.status !== "success")
      throw new Error(json.detail || "Gagal memproses rekap");
    renderRekapTransaksi(json.data, include, scopeLabelText);
    showToast("Berhasil!", "Rekap selesai");
  } catch (err) {
    showToast("Error!", err.message || err);
  }
}

// 1. FUNGSI HELPER (Untuk membuat kode placeholder: "Belanja ATK" -> "BELANJA_ATK")
function getPlaceholderCode(text) {
  if (!text) return "";
  return text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
}

// 2. EDIT FUNGSI RENDER (Menambahkan Kolom Kode Template)
function renderRekapTransaksi(
  data,
  withDetails = false,
  scopeLabelText = "Semua tahun / sumber dana",
) {
  const container = document.getElementById("rekap-result");
  if (!container) return;

  if (!Array.isArray(data) || data.length === 0) {
    container.innerHTML =
      `<p style='text-align:center; padding:20px;'>Tidak ada data rekap untuk ${escapeSpjFormValue(scopeLabelText)}.</p>`;
    return;
  }

  // Tambahkan header kolom 'Kode Template'
  let html = `
        <h4 class="rekap-scope-caption">Tahun / sumber dana: ${escapeSpjFormValue(scopeLabelText)}</h4>
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

  data.forEach((group) => {
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

                <td style="text-align:right">Rp ${Number(group.total_pengeluaran || 0).toLocaleString("id-ID")}</td>
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
      group.items.forEach((it) => {
        html += `
                    <tr>
                        <td>${it.no_bukti}</td>
                        <td>${it.kode_rekening}</td>
                        <td>Rp ${Number(it.harga_satuan || 0).toLocaleString("id-ID")}</td>
                        <td style="text-align:right">Rp ${Number(it.pengeluaran || 0).toLocaleString("id-ID")}</td>
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
  const fileInput = document.getElementById("template-file");
  const thpSelect = document.getElementById("rekap-thp-select");
  const scope = scopeFilterParams(
    document.getElementById("rekap-scope-filter")?.value,
  );

  if (!fileInput.files || fileInput.files.length === 0) {
    showToast("Warning", "Silakan pilih file template Excel (.xlsx) dulu.");
    return;
  }

  const formData = new FormData();
  const originalFile = fileInput.files[0]; // Simpan referensi file asli
  formData.append("file", originalFile);
  formData.append("thp", thpSelect.value);
  if (scope.fiscal_year) formData.append("fiscal_year", scope.fiscal_year);
  if (scope.source_fund_id) {
    formData.append("source_fund_id", scope.source_fund_id);
  }

  showToast("Info", "Sedang memproses Excel...");

  try {
    const res = await apiFetch(`${API_BASE}/generate-rekap-excel`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const errJson = await res.json();
      throw new Error(errJson.detail || "Gagal memproses file");
    }

    const blob = await res.blob();

    // --- LOGIC RENAME DI SINI (FRONTEND) ---
    // 1. Ambil nama asli dari input file
    const originalName = originalFile.name;

    // 2. Regex: Hapus kata template (case insensitive) dan separatornya
    // /.../gi -> g = global, i = insensitive (huruf besar/kecil dianggap sama)
    let cleanName = originalName.replace(/[_-\s]*template[_-\s]*/gi, "");

    // 3. Validasi: Jika hasil rename jadi aneh (misal cuma ".xlsx"), pakai nama default
    if (cleanName.length < 5) {
      // ".xlsx" itu 5 karakter
      cleanName = `Rekap_Hasil_${thpSelect.value}.xlsx`;
    }
    // ---------------------------------------

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Gunakan nama hasil olahan JS di sini
    a.download = cleanName;

    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    showToast("Success", `File berhasil diunduh: ${cleanName}`);
  } catch (err) {
    console.error(err);
    showToast("Error", err.message);
  }
}

// Delete referensi kegiatan
async function deleteMasterKegiatan(kode) {
  if (
    !(await UI.confirm(`Hapus master kegiatan ${kode}?`, {
      title: "Hapus Referensi Kegiatan",
      okText: "Hapus",
      danger: true,
    }))
  )
    return;

  try {
    const res = await apiFetch(
      `${API_BASE}/master-kegiatan/${encodeURIComponent(kode)}`,
      {
        method: "DELETE",
      },
    );
    if (res.ok) {
      showToast("Berhasil!", "Data Referensi Kegiatan berhasil dihapus.");
      loadMasterKegiatan();
    }
  } catch (err) {
    showToast("Gagal!", "Error: " + err);
  }
}

// Tab switching
const TAB_TITLES = {
  identitas: "Identitas Satuan Pendidikan",
  master: "Referensi Kegiatan",
  rekening: "Rekening Belanja",
  bku: "Upload BKU",
  "data-bku": "Data BKU",
  kwitansi: "Daftar SPJ",
  rekap: "Rekap Belanja",
  update: "Pembaruan Aplikasi",
  dukung: "Dukung Kami",
};

window.switchTab = function (tab) {
  // 1. Update State Active Tab
  activeTab = tab;
  const pt = document.getElementById("pageTitle");
  if (pt) pt.textContent = TAB_TITLES[tab] || "Aplikasi SPJ BOSP";

  // 2. UI Toggle (Button & Content)
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  document.querySelectorAll(".tab-content").forEach((content) => {
    // Cek ID: sesuaikan dengan HTML Anda (apakah 'tab-master' atau hanya 'master')
    // Kode asli Anda menggunakan prefix 'tab-', jadi saya pertahankan:
    content.classList.toggle("active", content.id === `tab-${tab}`);
  });

  // 2b. Sinkronkan state sidebar & judul, lalu reset pencarian utk tab non-tabel
  const searchInputPre = document.getElementById("globalSearchInput");
  if (
    searchInputPre &&
    ["identitas", "rekap", "bku", "update", "dukung"].includes(tab)
  ) {
    searchInputPre.value = "";
  }

  // 3. LOGIC PENCARIAN GLOBAL (BARU)
  const searchInput = document.getElementById("globalSearchInput");

  if (searchInput) {
    // A. Reset isi kotak pencarian setiap pindah tab
    searchInput.value = "";

    // B. Ambil container search untuk hide/show (opsional)
    const searchContainer = searchInput.closest(".search-container");

    // C. Atur Placeholder & Render Ulang Data Asli (Reset Filter)
    switch (tab) {
      case "master":
        searchInput.placeholder = "Cari data...";
        if (searchContainer) searchContainer.classList.remove("hidden"); // Tampilkan search
        // Reset tabel ke data penuh (unfiltered)
        if (typeof renderMasterKegiatan === "function")
          renderMasterKegiatan(masterKegiatan);
        break;

      case "rekening":
        searchInput.placeholder = "Cari data...";
        if (searchContainer) searchContainer.classList.remove("hidden");
        if (typeof renderMasterRekeningBelanja === "function")
          renderMasterRekeningBelanja(masterRekeningBelanja);
        break;

      case "data-bku":
        searchInput.placeholder = "Cari data...";
        if (searchContainer) searchContainer.classList.remove("hidden");
        // Pastikan bkuData ada sebelum akses transaksi
        if (typeof renderBKUResult === "function") {
          renderBKUResult(bkuData ? bkuData.transaksi : []);
        }
        break;

      case "kwitansi":
        searchInput.placeholder = "Cari data...";
        if (searchContainer) searchContainer.classList.remove("hidden");
        // Pastikan fungsi renderKwitansiList ada
        if (typeof renderKwitansiList === "function" && bkuData) {
          renderKwitansiList(bkuData.kwitansi_list);
        }
        break;

      case "identitas":
        // Sembunyikan search bar di menu identitas karena tidak relevan
        if (searchContainer) searchContainer.classList.add("hidden");
        // Segarkan daftar periode identitas setiap kali menu dibuka
        if (typeof loadIdentitasPeriode === "function") loadIdentitasPeriode();
        break;

      case "rekap":
        // Sembunyikan search bar di menu pengaturan karena tidak relevan
        if (searchContainer) searchContainer.classList.add("hidden");
        break;

      case "bku":
        // Sembunyikan search bar di menu pengaturan karena tidak relevan
        if (searchContainer) searchContainer.classList.add("hidden");
        break;

      case "update":
        // Sembunyikan search bar di menu pengaturan karena tidak relevan
        if (searchContainer) searchContainer.classList.add("hidden");
        break;

      case "dukung":
        if (searchContainer) searchContainer.classList.add("hidden");
        break;

      default:
        // Default behavior untuk tab lain (misal Rekap)
        searchInput.placeholder = "Cari data...";
        if (searchContainer) searchContainer.classList.remove("hidden");
        break;
    }
  }

  // 4. Auto-load Rekap (Logic Lama Anda)
  if (tab === "rekap") {
    const includeDetails =
      document.getElementById("rekap-include-details")?.checked || false;
    if (typeof generateRekapTransaksi === "function") {
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
    container.innerHTML =
      "<p style='text-align:center; padding:20px;'>Belum ada data referensi kegiatan.</p>";
    return;
  }

  let html = `
        <div class="table-scroll">
            <table>
                <thead>
                    <tr>
                        <th style="width:150px">Kode Kegiatan</th>
                        <th>Nama Kegiatan</th>
                        <th>Tahun / Sumber Dana</th>
                        <th style="width:100px; text-align:center">Aksi</th>
                    </tr>
                </thead>
                <tbody>
    `;

  list.forEach((item) => {
    const scoped = item.fiscal_year != null;
    html += `
            <tr>
                <td><strong>${escapeSpjFormValue(item.kode_kegiatan)}</strong></td>
                <td>${escapeSpjFormValue(item.nama_kegiatan)}</td>
                <td>${scoped
                  ? `${escapeSpjFormValue(item.fiscal_year)} • ${escapeSpjFormValue(item.source_fund_name || "Nama sumber dana tidak tersedia")}`
                  : "Referensi lokal"}</td>
                <td style="text-align:center">
                    <button class="btn btn-sm btn-danger" onclick="${scoped
                      ? `deleteMasterKegiatanArkas(${Number(item.id)})`
                      : `deleteMasterKegiatan(${JSON.stringify(String(item.kode_kegiatan))})`}">
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
    tbody.innerHTML =
      '<tr><td colspan="12" style="text-align:center; padding:20px;">Tidak ada data ditemukan.</td></tr>';
    if (btnArea) btnArea.style.display = "none";
    return;
  }

  // LOGIKA BARU: Tombol hanya muncul JIKA ada data DAN isExtractMode bernilai true
  if (isExtractMode && dataToRender.length > 0) {
    if (btnArea) btnArea.style.display = "block";
  } else {
    if (btnArea) btnArea.style.display = "none";
  }

  tbody.innerHTML = "";
  dataToRender.forEach((item) => {
    const row = `
            <tr>
                <td>${escapeSpjFormValue(item.no_bukti || "-")}</td>
                <td>${escapeSpjFormValue(item.tanggal || "-")}</td>
                <td>${escapeSpjFormValue(item.kode_kegiatan || "-")}</td>
                <td>${escapeSpjFormValue(item.kode_rekening || "-")}</td>
                <td>${escapeSpjFormValue(item.uraian || "-")}</td>
                ${renderBkuShopIdentity(item)}
                <td>${escapeSpjFormValue(item.volume || 0)}</td>
                <td>${escapeSpjFormValue(item.satuan || "")}</td>
                <td>${formatCurrencyLabel(item.harga_satuan || 0)}</td>
                <td>${formatCurrencyLabel(item.pengeluaran || 0)}</td>
                <td style="text-align:center">
                    <button class="btn btn-danger btn-sm" onclick="${escapeSpjFormValue(`deleteTransaksi(${JSON.stringify(String(item.no_bukti || ""))}, ${JSON.stringify({
                      fiscal_year: item.fiscal_year ?? "unspecified",
                      source_fund_id: item.source_fund_id || "unspecified",
                      budget_id: item.budget_id || "unspecified",
                    })})`)}">Hapus</button>
                </td>
                <td>${renderFiscalContext(item)}</td>
            </tr>
        `;
    tbody.insertAdjacentHTML("beforeend", row);
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

async function downloadBAST(noBukti) {
  if (!noBukti) {
    UI.warning("No bukti belum tersedia.");
    return;
  }

  const url = `${API_BASE}/kwitansi/bast/${encodeURIComponent(noBukti)}`;

  // Membuat elemen jangkar (anchor) sementara
  const link = document.createElement("a");
  link.href = url;

  // Menentukan bahwa link ini harus mendownload (bukan navigasi)
  // Nama file di sini akan dioverride oleh header dari backend
  link.setAttribute("download", `BAST-${noBukti}.pdf`);

  // Sembunyikan elemen dari dokumen
  link.style.display = "none";
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
    container.innerHTML =
      "<div class='alert alert-danger'>Data kwitansi tidak valid</div>";
    return;
  }

  list.sort((a, b) => {
    const dA = parseTanggalToDate(a.tanggal);
    const dB = parseTanggalToDate(b.tanggal);
    if (dA && dB && dA.getTime() !== dB.getTime()) return dA - dB;
    return (a.nomor_kwitansi || "").localeCompare(
      b.nomor_kwitansi || "",
      undefined,
      { numeric: true },
    );
  });

  let html = `
        <style>
            .table-responsive { width: 100%; overflow-x: auto; margin-top: 10px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
            .main-table { width: 100%; border-collapse: collapse; min-width: 1050px; background: white; }
            .main-table th { background: #f8f9fa; padding: 15px 10px; border-bottom: 2px solid #dee2e6; text-align: left; color: #495057; }
            .main-table td { padding: 12px 10px; border-bottom: 1px solid #eee; vertical-align: middle; }
            .btn-sm { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 12px; font-size: 12px; font-weight: 500; cursor: pointer; border-radius: 4px; border: 1px solid transparent; transition: 0.2s; vertical-align: middle; white-space: nowrap; line-height: 1.4; box-sizing: border-box; }
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
                ${iconSvg("zap", 16)} Generate SPJ
            </button>
        </div>

        <div class="table-scroll">
            <table class="main-table">
                <thead>
                    <tr>
                        <th style="width:120px">Tanggal</th>
                        <th style="width:180px">No Kwitansi</th>
                        <th>Kegiatan</th>
                        <th style="width:200px">Toko/Penerima</th>
                        <th style="width:140px">Jumlah</th>
                        <th style="width:110px; text-align:center">Status</th>
                        <th style="width:160px; text-align:center">Aksi</th>
                        <th>Keterangan</th>
                    </tr>
                </thead>
                <tbody>
    `;

  if (list.length === 0) {
    html += `<tr><td colspan="8" style="text-align:center; padding: 40px; color: #999;">Belum ada data SPJ</td></tr>`;
  } else {
    list.forEach((k) => {
      const isBlank = (val) => !val || val.toString().trim() === "";

      const needsUpdate =
        isBlank(k.tanggal_nota) &&
        isBlank(k.nama_toko) &&
        isBlank(k.alamat_toko) &&
        isBlank(k.npwp_toko) &&
        (!Array.isArray(k.uraian) || k.uraian.length === 0) ||
        !isSpjDetailComplete(k);

      html += `
        <tr>
            <td>${formatTanggalID(k.tanggal)}</td>
            <td>${k.nomor_kwitansi ? displayKwitansiNumber(k) : "<span style='color:orange'>DRAFT</span>"}</td>
            <td>${escapeSpjFormValue(k.nama_kegiatan)}</td>
            <td>
                <strong>${escapeSpjFormValue(k.nama_toko)}</strong>
                <small style="display:block;color:#666;">${escapeSpjFormValue(k.no_telp_toko || k.npwp_toko)}</small>
            </td>
            <td>Rp ${Number(k.jumlah).toLocaleString("id-ID")}</td>
            <td style="text-align:center; vertical-align:middle; white-space:nowrap;">
                <button class="btn-sm ${needsUpdate ? "btn-danger" : "btn-success"}" 
                    onclick="openUpdateDetailPopup(${k.id})">
                    ${needsUpdate ? iconSvg("pencil", 13) + " Lengkapi" : iconSvg("check", 13) + " Edit"}
                </button>
            </td>
<td style="text-align:center; vertical-align:middle; white-space:nowrap;">
    <button class="btn-sm btn-outline-primary" onclick="previewKwitansi(${k.id})">
        ${iconSvg("eye", 13)} Preview
    </button>
    ${k.nomor_kwitansi
          ? `
            <button class="btn-sm btn-outline-primary" onclick="downloadKwitansi(${k.id}, '${k.no_bukti}')">
                  ${iconSvg("package", 13)} Unduh
            </button>
          `
          : `<span style="color:#aaa; font-size:11px; font-style: italic;">Draft</span>`
        }
</td>
            <td>${renderFiscalContext(k)}</td>
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
window.updateValidasiPengeluaran = function (el) {
  const row = el.closest("tr");
  if (!row) return;

  const volInput = row.querySelector(".edit-uraian-vol");
  const hargaInput = row.querySelector(".edit-uraian-harga");
  const pengeluaranInput = row.querySelector(".edit-uraian-pengeluaran");

  // 1. Ambil Volume (Handle string kosong jadi 0)
  const volume = parseFloat(volInput.value) || 0;

  // 2. Ambil Harga (Bersihkan format Rp: 10.000 -> 10000)
  // Pastikan replace hanya jalan jika value ada
  const hargaRaw = hargaInput.value
    ? hargaInput.value.replace(/\./g, "").replace(/,/g, ".")
    : "0";
  const harga = parseFloat(hargaRaw) || 0;

  // 3. Ambil nilai asli database yang sudah kita inject di Langkah 1
  const pengeluaranDb =
    parseFloat(pengeluaranInput.getAttribute("data-db-value")) || 0;

  // 4. Hitung
  const hasilHitungUser = volume * harga;

  // 5. Logika Validasi
  // Kita cek apakah hasil input user menyimpang dari data DB?
  const selisih = Math.abs(hasilHitungUser - pengeluaranDb);

  // Toleransi 1 rupiah untuk pembulatan desimal
  if (selisih > 1) {
    // JIKA BEDA: Merah
    pengeluaranInput.style.backgroundColor = "#fff5f5";
    pengeluaranInput.style.borderColor = "#fc8181";
    pengeluaranInput.style.color = "#c53030";
    pengeluaranInput.style.fontWeight = "bold";

    // Opsional: Tampilkan tooltip hasil hitungan user agar user sadar
    pengeluaranInput.title = `Hitungan saat ini: ${hasilHitungUser.toLocaleString("id-ID")}`;
  } else {
    // JIKA SAMA/VALID: Normal (atau hijau tipis)
    pengeluaranInput.style.backgroundColor = "#f8f9fa";
    pengeluaranInput.style.borderColor = "#e2e8f0"; // Warna border default modern
    pengeluaranInput.style.color = "#333";
    pengeluaranInput.style.fontWeight = "normal";
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

  const validFiles = files.filter((f) => f.type.startsWith("image/"));
  if (validFiles.length !== files.length) {
    showToast("Error!", "Hanya file gambar yang diperbolehkan.");
    input.value = "";
    return;
  }

  const jenisFoto = document.getElementById("jenis-foto")?.value || "barang";
  const previewItems = [];
  // ===============================
  // PREVIEW SAJA (TANPA SELECT PER FOTO)
  // ===============================
  validFiles.forEach((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const div = document.createElement("div");
      div.className = "foto-item";
      div.innerHTML = `
                <img src="${e.target.result}"
                     style="width:100%; height:80px; object-fit:cover;">
                <span style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,.65); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; text-transform:uppercase;">
                    ${escapeSpjFormValue(jenisFoto)}
                </span>
            `;
      previewItems.push(div);
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

    validFiles.forEach((file) => {
      formData.append("files", file);
    });

    // ⬅⬅⬅ NAMA FIELD HARUS SAMA DENGAN BACKEND
    formData.append("jenis_foto", jenisFoto);

    try {
      const res = await apiFetch(
        `${API_BASE}/kwitansi/${kwitansiId}/upload-foto`,
        {
          method: "POST",
          body: formData,
        },
      );

      const result = await res.json();
      if (result.status !== "success") {
        throw new Error(result.detail || "Upload gagal");
      }

      showToast("Berhasil!", "Foto berhasil diupload");
      input.value = "";
    } catch (err) {
      previewItems.forEach((item) => item.remove());
      showToast("Error!", err.message || "Gagal upload foto");
      input.value = "";
    }
  }, 300);
}

window.generateGambarAIItem = async function (kwitansiId, rowIndex) {
  const row = document.querySelector(
    `.uraian-item-row[data-index="${rowIndex}"]`,
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

  let settings;
  try {
    if (!window.electronAPI?.getAiImageSettings) {
      throw new Error("Fitur penyimpanan AI aman memerlukan aplikasi desktop.");
    }
    settings = await window.electronAPI.getAiImageSettings();
    if (!settings) {
      settings = await configureAIImageProvider();
      if (!settings) return;
    }
  } catch (err) {
    showToast("Error!", err.message || "Gagal memuat pengaturan provider AI");
    return;
  }

  // Feedback visual: tombol berputar & info bahwa generate butuh waktu
  const btn = row.querySelector(".btn-generate-ai");
  const btnHtmlBackup = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML =
      `<span style="display:inline-block;font-size:14px;">&#8635;</span> Generating...`;
  }
  showToast("Info", "Generate gambar AI sedang diproses, bisa memakan waktu hingga 1 menit...");

  try {
    const response = await window.electronAPI.generateAiImage(kwitansiId, {
      prompt_items: promptText,
      jenis_foto: "barang",
      orientation: "landscape",
    });

    if (response.status < 200 || response.status >= 300 ||
        response.body?.status !== "success") {
      throw new Error(
        response.body?.detail || `Gagal generate AI (HTTP ${response.status})`,
      );
    }

    showToast("Sukses!", "Gambar AI berhasil dibuat & dikompres.");
    openUpdateDetailPopup(kwitansiId);
  } catch (err) {
    showToast("Error!", err.message || "Gagal generate AI");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = btnHtmlBackup;
    }
  }
};

const AI_IMAGE_PROVIDER_DEFAULTS = {
  pollinations: {
    model: "flux",
    description:
      "Pollinations memerlukan secret API key berawalan sk_ untuk generate gambar. App Key pk_ tidak dapat digunakan langsung. Pemakaian mengikuti izin model dan budget key.",
  },
  huggingface: {
    model: "black-forest-labs/FLUX.1-schnell",
    description:
      "Menggunakan Hugging Face Inference Providers/Nscale. Perlu token dengan izin Inference Providers dan dapat memerlukan kredit/billing.",
  },
  gemini: {
    model: "gemini-nano-banana-2.1",
    description:
      "Google Gemini Nano Banana 2.1. Perlu API key Google AI Studio; kuota gratis, ketersediaan model, dan biaya mengikuti akun Google Anda.",
  },
  openai: {
    model: "gpt-image-2.5-flare",
    description:
      "OpenAI Images API untuk model GPT Image. Perlu API key dan billing API tersendiri; langganan ChatGPT tidak termasuk saldo API.",
  },
  custom: {
    model: "black-forest-labs/FLUX.1-schnell",
    description:
      "Untuk endpoint HTTPS yang kompatibel dengan OpenAI Images API (request prompt/model/size dan respons data[0].b64_json). Biaya dan akses mengikuti provider Anda.",
  },
};

function createAISettingsField(labelText, control, helpText = "") {
  const field = document.createElement("div");
  field.className = "ui-dialog-input ai-provider-field";
  const label = document.createElement("label");
  label.className = "ai-provider-label";
  label.textContent = labelText;
  field.append(label, control);
  if (helpText) {
    const help = document.createElement("small");
    help.className = "ai-provider-help";
    help.textContent = helpText;
    field.appendChild(help);
  }
  return field;
}

function configureAIImageProvider() {
  return new Promise((resolve) => {
    const openDialog = (savedSettings) => {
      const overlay = document.createElement("div");
      overlay.className = "ui-dialog-overlay ui-dialog-kind-prompt";

      const dialog = document.createElement("section");
      dialog.className = "ui-dialog ai-provider-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");

      const heading = document.createElement("div");
      heading.className = "ui-dialog-head";
      const title = document.createElement("h2");
      title.className = "ui-dialog-title";
      title.textContent = "Pengaturan AI Gambar";
      heading.appendChild(title);

      const body = document.createElement("div");
      body.className = "ui-dialog-body";
      const intro = document.createElement("p");
      intro.className = "ui-dialog-message";
      intro.textContent =
        "Pilih provider untuk membuat gambar. API key disimpan terenkripsi oleh sistem operasi dan tidak dikirim kembali ke tampilan aplikasi.";
      body.appendChild(intro);

      const provider = document.createElement("select");
      provider.className = "ai-provider-control";
      [
        ["pollinations", "Pollinations — secret key sk_ diperlukan"],
        ["huggingface", "Hugging Face / Nscale — perlu token"],
        ["gemini", "Google Gemini — API key"],
        ["openai", "ChatGPT / OpenAI Images — API berbayar"],
        ["custom", "Endpoint OpenAI-compatible — kustom"],
      ].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        provider.appendChild(option);
      });
      provider.value = savedSettings?.provider || "pollinations";

      const model = document.createElement("input");
      model.className = "ai-provider-control";
      model.type = "text";
      model.maxLength = 160;
      model.value = savedSettings?.model ||
        AI_IMAGE_PROVIDER_DEFAULTS[provider.value].model;
      model.placeholder = "Nama model";

      const apiKey = document.createElement("input");
      apiKey.className = "ai-provider-control";
      apiKey.type = "password";
      apiKey.autocomplete = "new-password";
      apiKey.placeholder = savedSettings?.has_api_key
        ? "API key tersimpan — kosongkan untuk tetap memakai"
        : "Secret API key";

      const endpoint = document.createElement("input");
      endpoint.className = "ai-provider-control";
      endpoint.type = "url";
      endpoint.maxLength = 1000;
      endpoint.placeholder = "https://provider.example/v1/images/generations";
      endpoint.value = savedSettings?.api_endpoint || "";

      const note = document.createElement("p");
      note.className = "ai-provider-note";
      const providerField = createAISettingsField("Provider", provider);
      const modelField = createAISettingsField("Model", model);
      const keyField = createAISettingsField("API key", apiKey);
      const endpointField = createAISettingsField(
        "URL endpoint gambar",
        endpoint,
        "Hanya HTTPS yang diizinkan, kecuali endpoint localhost.",
      );
      body.append(providerField, modelField, keyField, endpointField, note);

      const footer = document.createElement("div");
      footer.className = "ui-dialog-foot ai-provider-footer";
      const cancel = document.createElement("button");
      cancel.className = "btn btn-secondary";
      cancel.type = "button";
      cancel.textContent = "Batal";
      const save = document.createElement("button");
      save.className = "btn btn-primary";
      save.type = "button";
      save.textContent = "Simpan";
      footer.append(cancel);

      if (savedSettings) {
        const remove = document.createElement("button");
        remove.className = "btn btn-danger";
        remove.type = "button";
        remove.textContent = "Hapus";
        remove.addEventListener("click", async () => {
          if (!(await UI.confirm("Hapus provider dan API key AI tersimpan?", {
            title: "Hapus pengaturan AI",
            okText: "Hapus",
            danger: true,
          }))) {
            return;
          }
          try {
            await window.electronAPI.clearAiImageSettings();
            finish(null);
            showToast("Berhasil!", "Pengaturan dan API key AI telah dihapus.");
          } catch (err) {
            showToast("Error!", err.message || "Gagal menghapus API key");
          }
        });
        footer.appendChild(remove);
      }
      footer.appendChild(save);

      let completed = false;
      const finish = (value) => {
        if (completed) return;
        completed = true;
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(value);
      };

      const updateProviderFields = (previousProvider) => {
        const currentProvider = provider.value;
        endpointField.hidden = currentProvider !== "custom";
        note.textContent = AI_IMAGE_PROVIDER_DEFAULTS[currentProvider].description;
        keyField.querySelector(".ai-provider-label").textContent =
          currentProvider === "pollinations" ? "Secret API key (wajib)" : "API key";
        apiKey.placeholder =
          currentProvider === savedSettings?.provider && savedSettings?.has_api_key
            ? "API key tersimpan — kosongkan untuk tetap memakai"
            : currentProvider === "pollinations"
              ? "Secret key Pollinations berawalan sk_"
              : "Masukkan token/API key";
        if (
          previousProvider &&
          model.value === AI_IMAGE_PROVIDER_DEFAULTS[previousProvider]?.model
        ) {
          model.value = AI_IMAGE_PROVIDER_DEFAULTS[currentProvider].model;
        }
      };

      provider.addEventListener("change", (event) => {
        const previousProvider = event.target.dataset.previous || "";
        updateProviderFields(previousProvider);
        event.target.dataset.previous = event.target.value;
      });
      provider.dataset.previous = provider.value;
      updateProviderFields("");

      save.addEventListener("click", async () => {
        const settings = {
          provider: provider.value,
          model: model.value.trim(),
          api_key: apiKey.value.trim(),
          api_endpoint: provider.value === "custom" ? endpoint.value.trim() : "",
        };
        if (settings.provider === "custom" && !settings.api_endpoint) {
          showToast("Error!", "URL endpoint provider kustom wajib diisi.");
          endpoint.focus();
          return;
        }
        if (!settings.api_key &&
            !(settings.provider === savedSettings?.provider && savedSettings?.has_api_key)) {
          showToast("Error!", "API key wajib diisi untuk provider ini.");
          apiKey.focus();
          return;
        }
        if (
          settings.provider === "pollinations" &&
          settings.api_key &&
          !settings.api_key.startsWith("sk_")
        ) {
          showToast("Error!", "Pollinations memerlukan secret key berawalan sk_, bukan App Key pk_.");
          apiKey.focus();
          return;
        }
        save.disabled = true;
        try {
          const stored = await window.electronAPI.saveAiImageSettings(settings);
          finish(stored);
        } catch (err) {
          showToast("Error!", err.message || "Gagal menyimpan pengaturan AI");
        } finally {
          save.disabled = false;
        }
      });

      cancel.addEventListener("click", () => finish(null));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) finish(null);
      });
      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }
      document.addEventListener("keydown", onKey, true);
      overlay.appendChild(dialog);
      dialog.append(heading, body, footer);
      document.body.appendChild(overlay);
      provider.focus();
    };

    if (!window.electronAPI?.getAiImageSettings ||
        !window.electronAPI?.saveAiImageSettings) {
      showToast("Error!", "Pengaturan provider AI memerlukan aplikasi desktop.");
      resolve(null);
      return;
    }
    window.electronAPI.getAiImageSettings()
      .then(openDialog)
      .catch((err) => {
        showToast("Error!", err.message || "Gagal membaca pengaturan AI");
        resolve(null);
      });
  });
}

window.configureAIImageProvider = async function () {
  await configureAIImageProvider();
};

function escapeSpjFormValue(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function dateInputValue(value) {
  const text = String(value ?? "").trim();
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return text;
  const localDate = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  return localDate
    ? `${localDate[3]}-${localDate[2]}-${localDate[1]}`
    : "";
}

function renderTandaTerimaRecipientRows(data = {}, jenisBelanja) {
  const isSewa = jenisBelanja === "sewa";
  const taxField = isSewa ? "pph23" : "pph21";
  const taxLabel = isSewa ? "PPh 23" : "PPh 21";
  const savedRecipients = Array.isArray(data.penerima_list) && data.penerima_list.length
    ? data.penerima_list
    : [{
        nama: data.penerima_nama || "",
        jabatan: data.penerima_jabatan || "",
        nuptk: "",
        npwp: "",
        honor: "",
        pph21: "0",
      }];
  const rows = savedRecipients.map((recipient) => ({
    ...recipient,
    [taxField]: recipient[taxField] ?? recipient[isSewa ? "pph21" : "pph23"] ?? "0",
  }));
  const columns = [
    ["nama", "Nama", "text"],
    ["jabatan", "Jabatan", "text"],
    ["nuptk", "NUPTK", "text"],
    ["npwp", "NPWP", "text"],
    ["honor", "Honor", "number"],
    [taxField, taxLabel, "number"],
  ];
  return `
    <div style="overflow-x:auto;">
      <table class="modern-table" style="min-width:920px;">
        <thead><tr>${columns.map(([, label]) => `<th>${label}</th>`).join("")}<th>Aksi</th></tr></thead>
        <tbody id="lampiran-penerima-list">
          ${rows.map((row) => `
            <tr class="tt-penerima-row">
              ${columns.map(([key, label, type]) => `
                <td><input class="form-control tt-penerima-${key}" type="${type}" ${type === "number" ? 'min="0" step="1"' : ""}
                  aria-label="${label}" placeholder="${label}" value="${escapeSpjFormValue(row[key])}"
                  ${key === "nama" || key === "honor" ? "required" : ""}></td>
              `).join("")}
              <td><button type="button" class="btn btn-secondary" onclick="removeTandaTerimaRecipientRow(this)">Hapus</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <button type="button" class="btn btn-secondary" style="margin-top:8px;" onclick="addTandaTerimaRecipientRow()">+ Tambah Penerima</button>
    <small style="display:block;color:#666;margin-top:6px;">Penerimaan dihitung otomatis saat PDF dibuat: Honor dikurangi ${taxLabel}.</small>
  `;
}

function collectDataLampiranForm() {
  const result = { ...(window._spjLampiranDraft || {}) };
  document.querySelectorAll("input[id^='lampiran-'], textarea[id^='lampiran-']").forEach((input) => {
    result[input.id.slice("lampiran-".length)] = input.value;
  });
  const recipientRows = Array.from(document.querySelectorAll(".tt-penerima-row"));
  if (recipientRows.length) {
    result.penerima_list = recipientRows.map((row) => {
      const taxInput = row.querySelector(
        ".tt-penerima-pph21, .tt-penerima-pph23",
      );
      return {
        nama: row.querySelector(".tt-penerima-nama").value.trim(),
        jabatan: row.querySelector(".tt-penerima-jabatan").value.trim(),
        nuptk: row.querySelector(".tt-penerima-nuptk").value.trim(),
        npwp: row.querySelector(".tt-penerima-npwp").value.trim(),
        honor: row.querySelector(".tt-penerima-honor").value,
        [taxInput.classList.contains("tt-penerima-pph23") ? "pph23" : "pph21"]:
          taxInput.value || "0",
      };
    });
  }
  return result;
}

function addTandaTerimaRecipientRow() {
  const body = document.getElementById("lampiran-penerima-list");
  if (!body) return;
  const template = body.querySelector(".tt-penerima-row");
  if (template) {
    const row = template.cloneNode(true);
    row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    row.querySelector(".tt-penerima-pph21, .tt-penerima-pph23").value = "0";
    body.appendChild(row);
  }
}

function removeTandaTerimaRecipientRow(button) {
  const row = button.closest(".tt-penerima-row");
  const body = document.getElementById("lampiran-penerima-list");
  if (body?.querySelectorAll(".tt-penerima-row").length === 1) {
    row.querySelectorAll("input").forEach((input) => { input.value = ""; });
    row.querySelector(".tt-penerima-pph21, .tt-penerima-pph23").value = "0";
  } else {
    row?.remove();
  }
}

function renderDataLampiranForm(jenis, data = {}) {
  // Tampilkan hanya isian lampiran yang ditentukan konfigurasi jenis belanja.
  const config = JENIS_BELANJA_SPJ[jenis] || JENIS_BELANJA_SPJ.umum;
  return config.dokumen.map((dokumen) => `
    <div class="form-section">
      <span class="form-section-title">${dokumen.label}${dokumen.optional ? " — Opsional" : ""}</span>
      ${dokumen.recipientTable ? renderTandaTerimaRecipientRows(data, jenis) : `
      <div class="modern-grid">
        ${dokumen.fields.map(([key, label, type, optional]) => {
          const value = escapeSpjFormValue(data[key]);
          const control = type === "textarea"
            ? `<textarea id="lampiran-${key}" class="form-control" rows="3" ${dokumen.optional || optional ? "" : "required"}>${value}</textarea>`
            : `<input id="lampiran-${key}" class="form-control" type="${type || "text"}" value="${value}" ${dokumen.optional || optional ? "" : "required"}>`;
          return `<div class="form-group"><label for="lampiran-${key}">${label}${dokumen.optional || optional ? "" : " *"}</label>${control}</div>`;
        }).join("")}
      </div>`}
    </div>
  `).join("");
}

function changeJenisBelanjaSpj() {
  // Simpan isian sementara, lalu sesuaikan form dan kategori foto dengan pilihan baru.
  const jenis = document.getElementById("edit-jenis-belanja")?.value || "umum";
  const data = collectDataLampiranForm();
  window._spjLampiranDraft = data;
  const forms = document.getElementById("edit-data-lampiran");
  if (forms) forms.innerHTML = renderDataLampiranForm(jenis, data);
  const photoTypes = JENIS_BELANJA_SPJ[jenis]?.foto || [];
  const photoSelect = document.getElementById("jenis-foto");
  if (photoSelect) {
    photoSelect.innerHTML = photoTypes.length
      ? photoTypes.map((type) =>
        `<option value="${type}">${getFotoJenisLabel(type)}</option>`).join("")
      : '<option value="">Tidak diperlukan</option>';
    photoSelect.disabled = photoTypes.length === 0;
    const fileInput = document.getElementById("upload-foto-kwitansi");
    if (fileInput) fileInput.disabled = photoTypes.length === 0;
  }
}

function isSpjDetailComplete(item) {
  // Periksa kolom wajib, dokumen wajib, BAST bila diperlukan, dan semua foto kategori.
  const config = JENIS_BELANJA_SPJ[item.jenis_belanja] || JENIS_BELANJA_SPJ.umum;
  const formData = item.data_lampiran || {};
  const taxField = item.jenis_belanja === "sewa" ? "pph23" : "pph21";
  const fieldsComplete = config.dokumen
    .filter((dokumen) => !dokumen.optional)
    .every((dokumen) =>
      dokumen.recipientTable
        ? Array.isArray(formData.penerima_list) &&
          formData.penerima_list.length > 0 &&
          formData.penerima_list.every((row) =>
            String(row.nama || "").trim() &&
            String(row.honor ?? "").trim() &&
            Number.isFinite(Number(row.honor)) &&
            Number(row.honor) >= 0 &&
            Number.isFinite(Number(row[taxField] ?? row.pph21 ?? 0)) &&
            Number(row[taxField] ?? row.pph21 ?? 0) >= 0 &&
            Number(row[taxField] ?? row.pph21 ?? 0) <= Number(row.honor),
          )
        : dokumen.fields.every(([key, , , optional]) =>
          optional || String(formData[key] || "").trim(),
        ),
    );
  const bastComplete = !config.bast || Boolean(String(item.no_bast || "").trim());
  const availablePhotos = new Set(item.jenis_foto_tersedia || []);
  const photosComplete = config.foto.every((jenis) => availablePhotos.has(jenis));
  return fieldsComplete && bastComplete && photosComplete;
}

function openUpdateDetailPopup(kwitansiId) {
  apiFetch(`${API_BASE}/kwitansi/${kwitansiId}`)
    .then((res) => res.json())
    .then((k) => {
      if (k.status !== "success") throw new Error("Gagal memuat detail");

      const kw = k.data;
      const uraian = kw.uraian || [];
      const fotoBukti = kw.foto_bukti || [];
      const jenisBelanja = JENIS_BELANJA_SPJ[kw.jenis_belanja]
        ? kw.jenis_belanja
        : "umum";
      const dataLampiran = kw.data_lampiran && typeof kw.data_lampiran === "object"
        ? kw.data_lampiran
        : {};
      window._spjLampiranDraft = { ...dataLampiran };

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
                        color: #fff; cursor: pointer;
                        padding: 0; display: flex; align-items: center; justify-content: center;
                    }
                    .foto-delete-btn:hover { background: rgba(200, 35, 51, 1); }
                    @keyframes spin { to { transform: rotate(360deg); } }
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
        const isValid = pengeluaran === volume * harga;
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
                        <td><div style="display:flex; gap:6px; align-items:center;">
                            <input type="text"
                                   class="edit-uraian-pengeluaran text-right"
                                   value="${pengeluaran.toLocaleString("id-ID")}"
                                   data-db-value="${pengeluaran}"
                                   style="${validationStyle}"
                                   readonly>
                            <button type="button" class="btn btn-secondary btn-generate-ai" style="padding:4px 6px; font-size:11px;"
                                    title="Generate Foto AI untuk barang ini"
                                    onclick="generateGambarAIItem(${kwitansiId}, ${index})">
                                ${iconSvg("bot", 15)}
                            </button>
                            <button type="button" class="btn btn-secondary btn-ai-settings" style="padding:4px 6px; font-size:11px;"
                                    title="Pilih provider AI dan atur API key"
                                    aria-label="Pengaturan provider AI"
                                    onclick="configureAIImageProvider()">
                                ${iconSvg("settings", 15)}
                            </button></div></td>
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
                            <span class="form-section-title">Jenis Belanja</span>
                            <div class="form-group">
                                <label for="edit-jenis-belanja">Pilih jenis belanja</label>
                                <select id="edit-jenis-belanja" class="form-control" onchange="changeJenisBelanjaSpj()">
                                    ${Object.entries(JENIS_BELANJA_SPJ).map(([key, config]) =>
                                      `<option value="${key}" ${key === jenisBelanja ? "selected" : ""}>${config.label}</option>`).join("")}
                                </select>
                            </div>
                        </div>

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
                                    <input type="date" id="edit-tanggal-nota" class="form-control" value="${dateInputValue(kw.tanggal_nota)}">
                                </div>
                            </div>
                        </div>

                        <div id="edit-data-lampiran">
                            ${renderDataLampiranForm(jenisBelanja, dataLampiran)}
                        </div>

                        <div class="form-section">
                            <span class="form-section-title">Data Toko / Penerima</span>
                            <div class="form-group">
                                <label>Nama Toko / Penerima</label>
                                <input id="edit-nama-toko" class="form-control" value="${escapeSpjFormValue(kw.nama_toko)}">
                            </div>

                            <div class="modern-grid">
                                <div class="form-group">
                                    <label>NPWP / NIK</label>
                                    <input id="edit-npwp-toko" class="form-control" value="${escapeSpjFormValue(kw.npwp_toko)}">
                                </div>
                                <div class="form-group">
                                    <label>Alamat Toko</label>
                                    <input id="edit-alamat-toko" class="form-control" value="${escapeSpjFormValue(kw.alamat_toko)}">
                                </div>
                                <div class="form-group">
                                    <label>No. Telepon</label>
                                    <input id="edit-no-telp-toko" class="form-control" value="${escapeSpjFormValue(kw.no_telp_toko)}">
                                </div>
                                <div class="form-group">
                                    <label>No. Nota</label>
                                    <input id="edit-no-nota" class="form-control" value="${escapeSpjFormValue(kw.no_nota)}">
                                </div>
                            </div>
                        </div>

                        <div style="margin-top:20px; margin-bottom: 25px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                <label style="font-weight:700; font-size:1rem;">${iconSvg("package", 17)} Rincian Barang/Jasa</label>
                            </div>
                            ${uraianHtml}
                        </div>

                        <div class="upload-area" id="drop-area-foto">
                            <label style="font-weight:600; display:block; margin-bottom:8px;">
                                ${iconSvg("camera", 15)} Foto Bukti / Dokumentasi
                            </label>
                            <small style="color:#666; display:block; margin-bottom:10px;">
                                Upload manual, <b>Paste (Ctrl+V)</b>, atau generate dari AI. (Max 15)
                            </small>

                            <select id="jenis-foto" class="form-control"
                                    style="max-width:220px; margin:10px auto;">
                                ${(JENIS_BELANJA_SPJ[jenisBelanja].foto.length
                                  ? JENIS_BELANJA_SPJ[jenisBelanja].foto
                                  : ["kegiatan"]).map((type) =>
                                    `<option value="${type}">${getFotoJenisLabel(type)}</option>`).join("")}
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
                                ${iconSvg("save", 15)} Simpan Perubahan
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
        changeJenisBelanjaSpj();
        const uploadInput = document.getElementById("upload-foto-kwitansi");
        const uploadArea = document.getElementById("drop-area-foto");

        if (uploadInput && uploadArea) {
          // Handler agar user bisa klik area box untuk upload
          uploadArea.addEventListener("click", (e) => {
            // Cegah loop jika user klik langsung di input file atau select
            if (e.target !== uploadInput && e.target.id !== "jenis-foto") {
              uploadInput.click();
            }
          });

          // Handler Global Paste untuk jendela ini
          // Menggunakan event handler yang otomatis terhapus saat popup tertutup (secara UI)
          // karena elemen-nya hilang.
          const pasteHandler = function (event) {
            // Cek apakah input masih ada di dokumen (popup masih buka)
            if (!document.body.contains(uploadInput) || uploadInput.disabled) return;

            const items = (
              event.clipboardData || event.originalEvent.clipboardData
            ).items;
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
              setTimeout(
                () => uploadArea.classList.remove("highlight-paste"),
                500,
              );

              // Buat container file baru
              const dataTransfer = new DataTransfer();

              // Beri nama file unik
              const ext = blob.type.split("/")[1];
              const file = new File(
                [blob],
                `pasted_image_${Date.now()}.${ext}`,
                { type: blob.type },
              );

              dataTransfer.items.add(file);
              uploadInput.files = dataTransfer.files;

              // Trigger fungsi preview bawaan
              // Memanggil onchange secara manual
              if (uploadInput.onchange) {
                uploadInput.dispatchEvent(new Event("change"));
              }

              if (typeof showToast === "function") {
                showToast("Sukses", "Foto dari clipboard berhasil ditempel!");
              }
            }
          };

          // Pasang listener pada window agar user tidak perlu fokus ke input
          window.addEventListener("paste", pasteHandler, { once: false });
        }
      }, 500); // Delay sedikit memastikan elemen render

      // -------------------------------
      // RENDER FOTO DARI DATABASE
      // -------------------------------
      const preview = document.getElementById("preview-foto-kwitansi");
      if (preview) preview.innerHTML = "";

      let daftarFoto = [];

      // ===============================
      // NORMALISASI FOTO BUKTI
      // ===============================
      if (fotoBukti) {
        // ... (Logic normalisasi sama seperti kode asli Anda) ...
        if (typeof fotoBukti === "object" && !Array.isArray(fotoBukti)) {
          Object.keys(fotoBukti).forEach((jenis) => {
            if (Array.isArray(fotoBukti[jenis])) {
              fotoBukti[jenis].forEach((f) => {
                if (typeof f === "string") {
                  daftarFoto.push({ path: f, jenis });
                } else {
                  daftarFoto.push({ path: f.path, jenis: f.jenis || jenis });
                }
              });
            }
          });
        } else if (Array.isArray(fotoBukti)) {
          fotoBukti.forEach((f) => {
            if (typeof f === "string") {
              daftarFoto.push({ path: f, jenis: "barang" });
            } else {
              daftarFoto.push({ path: f.path, jenis: f.jenis || "barang" });
            }
          });
        } else if (typeof fotoBukti === "string") {
          try {
            const parsed = JSON.parse(fotoBukti);
            parsed.forEach((f) => {
              if (typeof f === "string") {
                daftarFoto.push({ path: f, jenis: "barang" });
              } else {
                daftarFoto.push({ path: f.path, jenis: f.jenis || "barang" });
              }
            });
          } catch {
            fotoBukti.split(",").forEach((f) => {
              daftarFoto.push({
                path: f.replace(/[\[\]"]/g, ""),
                jenis: "barang",
              });
            });
          }
        }
      }

      // ===============================
      // RENDER FOTO
      // ===============================
      const serverRoot = getServerRoot(); // origin child_process dinamis (bukan port statis)

      if (daftarFoto.length > 0) {
        daftarFoto.forEach((foto, index) => {
          if (!foto.path) return;
          const fullUrl = `${serverRoot}/${foto.path}`;
          const div = document.createElement("div");
          div.className = "foto-item";
          div.innerHTML = `
                        <button class="foto-delete-btn" title="Hapus foto"
                            onclick="event.stopPropagation(); deleteExistingFoto(${kwitansiId}, ${index})">
                            ${iconSvg("x", 12)}
                        </button>
                        <span style="position:absolute; bottom:4px; left:4px; background:rgba(0,0,0,.65); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; text-transform:uppercase;">
                            ${escapeSpjFormValue(getFotoJenisLabel(foto.jenis))}
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
    .catch((err) => showToast("Error!", err.message));
}

// --- Manual BKU Form ---
async function openManualBKUForm() {
  // Alur: muat referensi master, tampilkan formulir dengan pola popup SPJ, lalu siapkan baris dan foto.
  if (!Array.isArray(masterKegiatan) || masterKegiatan.length === 0)
    await loadMasterKegiatan();
  if (
    !Array.isArray(masterRekeningBelanja) ||
    masterRekeningBelanja.length === 0
  )
    await loadMasterRekeningBelanja();

  const kegiatanOptionsDatalist = (masterKegiatan || [])
    .map(
      (k) =>
        `<option value="${escapeSpjFormValue(k.kode_kegiatan)} - ${escapeSpjFormValue(k.nama_kegiatan)}"></option>`,
    )
    .join("");
  const rekeningOptionsDatalist = (masterRekeningBelanja || [])
    .map(
      (r) =>
        `<option value="${escapeSpjFormValue(r.kode_rekening_belanja)} - ${escapeSpjFormValue(r.nama_rekening_belanja)}"></option>`,
    )
    .join("");

  // expose arrays for parsing / resolving user input
  window._manualMasterKegiatan = masterKegiatan || [];
  window._manualMasterRekening = masterRekeningBelanja || [];

  const customStyle = `
        <style>
            .manual-popup { width: min(1200px, 96vw); max-width: 96vw; }
            .manual-popup.popup-modern { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; }
            .manual-popup .popup-header-modern { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding: 16px 0; margin: 0 22px 4px; }
            .manual-popup .popup-header-modern h3 { margin: 0; font-size: 1.25rem; color: #2c3e50; }
            .manual-popup .popup-body { padding: 18px 22px; }
            .manual-popup .form-section { margin-bottom: 15px; }
            .manual-popup .form-section-title { font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 10px; font-weight: 700; display: block; }
            .manual-popup .form-group { margin-bottom: 12px; }
            .manual-popup .form-group label { display: block; margin-bottom: 5px; font-weight: 500; font-size: 0.9rem; }
            .manual-popup .form-control { padding: 8px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
            .manual-popup .upload-area { border: 2px dashed #cbd5e0; border-radius: 8px; padding: 20px; text-align: center; background: #fff; transition: 0.2s; position: relative; }
            .manual-popup .upload-area:hover { border-color: #4a69bd; background: #f8fbff; }
            .manual-popup .upload-area.highlight-paste { border-color: #2ecc71; background: #e8f8f5; }
            .manual-popup .foto-delete-btn { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 50%; border: none; background: rgba(220, 53, 69, 0.9); color: #fff; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
            @media (max-width: 700px) {
                .manual-popup .modern-grid { grid-template-columns: 1fr; }
                .manual-popup .popup-body { padding: 14px; }
                .manual-popup .popup-header-modern { margin: 0 14px 4px; }
            }
        </style>
    `;

  const formHtml = `
        ${customStyle}
        <div class="popup-content popup-modern manual-popup">
            <div class="popup-header-modern">
                <div>
                    <h3>Tambah Data BKU Manual</h3>
                    <small style="color:#888;">Lengkapi informasi transaksi dan rincian belanja.</small>
                </div>
                <span class="badge-ref">BKU Manual</span>
            </div>

            <div class="popup-body">
                <div class="form-section">
                    <span class="form-section-title">Informasi Transaksi</span>
                    <div class="modern-grid">
                    <div class="form-group">
                        <label>No Bukti <span style="color:#dc3545">*</span></label>
                        <input id="manual-no-bukti" class="form-control" required>
                    </div>
                    <div class="form-group">
                        <label>Tanggal Kwitansi</label>
                        <input id="manual-tanggal" type="date" class="form-control">
                    </div>
                    <div class="form-group">
                        <label>Tanggal Nota</label>
                        <input id="manual-tanggal-nota" type="date" class="form-control">
                    </div>
                    <div class="form-group">
                        <label>No BAST</label>
                        <input id="manual-no-bast" class="form-control">
                    </div>
                    <div class="form-group">
                        <label>Nama Kegiatan</label>
                        <input id="manual-kode-kegiatan" class="form-control" placeholder="Ketik kode atau nama..." list="manual-kegiatan-list" autocomplete="off">
                        <datalist id="manual-kegiatan-list">
                            <option value="">-- Pilih Kegiatan --</option>
                            ${kegiatanOptionsDatalist}
                        </datalist>
                    </div>
                    </div>
                </div>

                <div class="form-section">
                    <span class="form-section-title">Data Penyedia / Toko</span>
                    <div class="modern-grid">
                        <div class="form-group">
                            <label>Nama Toko</label>
                            <input id="manual-nama-toko" class="form-control">
                        </div>
                        <div class="form-group">
                            <label>NPWP</label>
                            <input id="manual-npwp" class="form-control">
                        </div>
                        <div class="form-group" style="grid-column:1 / -1;">
                            <label>Alamat</label>
                            <input id="manual-alamat" class="form-control">
                        </div>
                    </div>
                </div>

                <div class="form-section">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px;">
                        <span class="form-section-title" style="margin:0;">Rincian Belanja</span>
                        <button type="button" class="btn btn-secondary" onclick="addManualUraianRow()" style="padding:6px 12px;">
                            ＋ Tambah Baris
                        </button>
                    </div>
                    <small style="display:block; color:#667085; margin-bottom:10px;">Kode rekening dapat ditentukan secara terpisah untuk setiap baris belanja.</small>
                    <datalist id="manual-rekening-list">
                        <option value="">-- Pilih Rekening --</option>
                        ${rekeningOptionsDatalist}
                    </datalist>
                    <div class="table-wrapper" style="max-height:420px; overflow:auto;">
                    <table id="manual-uraian-table" class="modern-table">
                        <thead style="position:sticky; top:0; z-index:1;">
                            <tr>
                                <th style="min-width:220px;">Nama Barang</th>
                                <th style="min-width:160px;">Kode Rekening Belanja</th>
                                <th style="min-width:80px; text-align:center;">Volume</th>
                                <th style="min-width:80px; text-align:center;">Satuan</th>
                                <th style="min-width:120px; text-align:right;">Harga</th>
                                <th style="min-width:140px; text-align:right;">Total</th>
                                <th style="min-width:50px; text-align:center;">#</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                    </div>

                <div style="display:flex; justify-content:flex-end; margin-top:8px; margin-bottom:6px;">
                    <div style="font-weight:700; font-size:1rem;">
                        Sub Total: <span id="manual-uraian-subtotal">Rp 0</span>
                    </div>
                </div>
                </div>

                <div class="form-section">
                    <span class="form-section-title">Dokumentasi &amp; Bukti</span>
                    <div class="upload-area" id="manual-drop-area">
                    <label style="font-weight:600; display:block; margin-bottom:5px;">
                        ${iconSvg("camera", 15)} Foto Bukti / Dokumentasi
                    </label>
                    <small style="color:#666; display:block; margin-bottom:12px;">
                        Klik untuk upload, atau <b>Paste (Ctrl+V)</b> gambar di sini. (Max 15)
                    </small>

                    <div style="display:flex; justify-content:center; gap:10px; margin-bottom:10px;">
                        <div style="width: 200px;">
                            <select id="manual-jenis-foto" class="form-control" style="text-align:center;">
                                <option value="barang">Barang</option>
                                <option value="kegiatan">Kegiatan</option>
                                <option value="sebelum">Sebelum</option>
                                <option value="proses">Proses</option>
                                <option value="sesudah">Sesudah</option>
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
                </div>
            </div>

            <div class="popup-footer">
                <button class="btn btn-secondary" onclick="closePopup()">Batal</button>
                <button class="btn btn-success" onclick="saveManualBKU()">
                    ${iconSvg("save", 15)} Simpan Data
                </button>
            </div>
        </div>
    `;

  showPopup(formHtml);

  // Reset draft foto dan buat satu baris rincian awal.
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
        if (
          e.target !== uploadInput &&
          e.target.id !== "manual-jenis-foto" &&
          !e.target.classList.contains("foto-delete-btn")
        ) {
          uploadInput.click();
        }
      });

      // Handler Global Paste untuk jendela ini
      const pasteHandler = function (event) {
        // Cek apakah input masih ada di dokumen (popup masih buka)
        if (!document.body.contains(uploadInput)) return;

        const items = (event.clipboardData || event.originalEvent.clipboardData)
          .items;
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
          const file = new File([blob], `pasted_manual_${Date.now()}.${ext}`, {
            type: blob.type,
          });

          dataTransfer.items.add(file);
          uploadInput.files = dataTransfer.files;

          // Trigger fungsi preview bawaan (handleManualBKUPhotos)
          if (uploadInput.onchange) {
            uploadInput.dispatchEvent(new Event("change"));
          }

          if (typeof showToast === "function") {
            showToast("Sukses", "Foto dari clipboard berhasil ditempel!");
          }
        }
      };

      // Pasang listener pada window
      window.addEventListener("paste", pasteHandler, { once: false });
    }

    // Normalisasi kode kegiatan dan kode rekening pada tiap baris setelah input selesai.
    try {
      const kegInput = document.getElementById("manual-kode-kegiatan");
      if (kegInput) {
        kegInput.addEventListener(
          "blur",
          () =>
            window.resolveManualKegiatanInput &&
            window.resolveManualKegiatanInput(),
        );
        kegInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter")
            window.resolveManualKegiatanInput &&
              window.resolveManualKegiatanInput();
        });
      }
    } catch (e) {
      showToast("Error!", `Gagal menyiapkan validasi kode: ${e.message}`);
    }
  }, 100);

  // add initial row
  addManualUraianRow();
}

function addManualUraianRow() {
  // Alur: buat input rincian, pasang datalist rekening, lalu hitung total awal baris.
  const tbody = document.querySelector("#manual-uraian-table tbody");
  if (!tbody) return;

  const row = document.createElement("tr");
  row.className = "manual-uraian-row";

  // Style standar untuk input dalam tabel agar rapi
  const inputStyle =
    "width:100%; box-sizing:border-box; padding:6px 8px; font-size:13px; border:1px solid #ddd; border-radius:4px;";

  // Style khusus Readonly (Total)
  const readonlyStyle =
    inputStyle +
    " background-color:#f9f9f9; border-color:#eee; font-weight:600; color:#333;";

  row.innerHTML = `
        <td style="padding: 8px 5px;">
            <input class="form-control manual-uraian-nama" 
                   placeholder="Nama barang / uraian" 
                   style="${inputStyle}">
        </td>
        <td style="padding: 8px 5px;">
            <input class="form-control manual-uraian-kode-rekening"
                   placeholder="Ketik kode atau nama..."
                   list="manual-rekening-list"
                   autocomplete="off"
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
                ${iconSvg("x", 14)}
            </button>
        </td>
    `;

  tbody.appendChild(row);
  const accountCodeInput = row.querySelector(".manual-uraian-kode-rekening");
  accountCodeInput.addEventListener("blur", () =>
    resolveManualRekeningRowInput(accountCodeInput),
  );
  accountCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      resolveManualRekeningRowInput(accountCodeInput);
    }
  });

  // Inisialisasi hitungan (agar 0 atau 1 langsung terformat)
  try {
    updateManualUraianTotal(row.querySelector(".manual-uraian-volume"));
    updateManualUraianSubtotal();
  } catch (e) {
    /* ignore */
  }
}

// Compute and set pengeluaran = volume * harga (formatted).
window.updateManualUraianTotal = function (el) {
  const row = el ? el.closest("tr") : null;
  if (!row) return;

  const volInput = row.querySelector(".manual-uraian-volume");
  const hargaInput = row.querySelector(".manual-uraian-harga");
  const pengeluaranInput = row.querySelector(".manual-uraian-pengeluaran");

  const volume = parseFloat(volInput.value) || 0;
  // Hapus titik ribuan sebelum kalkulasi
  const hargaRaw = hargaInput.value
    ? hargaInput.value.toString().replace(/\./g, "").replace(/,/g, ".")
    : "0";
  const harga = parseFloat(hargaRaw) || 0;
  const total = volume * harga;

  // Format hasil ke Rupiah (1.000.000)
  pengeluaranInput.value = Number(total).toLocaleString("id-ID");
  pengeluaranInput.setAttribute("data-db-value", total);

  // Update subtotal whenever a row changes
  if (window.updateManualUraianSubtotal) window.updateManualUraianSubtotal();
};

// Calculate subtotal for all uraian rows and show formatted value
window.updateManualUraianSubtotal = function () {
  const rows = document.querySelectorAll(".manual-uraian-row");
  let sum = 0;
  rows.forEach((r) => {
    const input = r.querySelector(".manual-uraian-pengeluaran");
    if (!input) return;
    const dbVal = parseFloat(input.getAttribute("data-db-value"));
    if (!isNaN(dbVal)) {
      sum += dbVal;
    } else {
      const raw = (input.value || "0")
        .toString()
        .replace(/\./g, "")
        .replace(/,/g, ".");
      sum += parseFloat(raw) || 0;
    }
  });
  const el = document.getElementById("manual-uraian-subtotal");
  if (el && window.formatCurrencyLabel)
    el.textContent = window.formatCurrencyLabel(sum);
};

window.deleteManualUraianRow = function (btn) {
  const tr = btn.closest("tr");
  if (tr) tr.remove();
  if (window.updateManualUraianSubtotal) window.updateManualUraianSubtotal();
};

// Helper: parse input value into kode (supports "CODE - Name", code, name, partial matches)
function parseManualKode(inputId, listArray) {
  try {
    if (!inputId || !listArray || !Array.isArray(listArray)) return "";
    const el = document.getElementById(inputId);
    if (!el) return "";
    return parseManualKodeValue(el.value, listArray);
  } catch (e) {
    return "";
  }
}

function parseManualKodeValue(value, listArray) {
  // Alur: tentukan kolom master, lalu cocokkan kode/nama persis atau parsial.
  if (!Array.isArray(listArray)) return "";
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) return "";
  const kodeKey =
    listArray[0] && listArray[0].kode_kegiatan
      ? "kode_kegiatan"
      : "kode_rekening_belanja";
  const nameKey =
    listArray[0] && listArray[0].nama_kegiatan
      ? "nama_kegiatan"
      : "nama_rekening_belanja";
  const lowerValue = normalizedValue.toLowerCase();
  if (normalizedValue.includes(" - ")) {
    const enteredCode = normalizedValue.split(" - ")[0].trim();
    const exactCode = listArray.find(
      (item) => String(item[kodeKey] || "").toLowerCase() === enteredCode.toLowerCase(),
    );
    return exactCode ? exactCode[kodeKey] : "";
  }
  const exactCode = listArray.find(
    (item) => String(item[kodeKey] || "").toLowerCase() === lowerValue,
  );
  if (exactCode) return exactCode[kodeKey];
  const exactName = listArray.find(
    (item) => String(item[nameKey] || "").toLowerCase() === lowerValue,
  );
  if (exactName) return exactName[kodeKey];
  const partialMatch = listArray.find(
    (item) =>
      String(item[kodeKey] || "").toLowerCase().includes(lowerValue) ||
      String(item[nameKey] || "").toLowerCase().includes(lowerValue),
  );
  return partialMatch ? partialMatch[kodeKey] : "";
}

// Auto-resolve and normalize input to "CODE - Name" when possible
window.resolveManualKegiatanInput = function () {
  // Alur: cocokkan input kegiatan ke master, lalu tampilkan kembali kode beserta nama resminya.
  const el = document.getElementById("manual-kode-kegiatan");
  if (!el) return;
  const kode = parseManualKode(
    "manual-kode-kegiatan",
    window._manualMasterKegiatan,
  );
  if (!kode) return;
  const found = (window._manualMasterKegiatan || []).find(
    (k) => k.kode_kegiatan === kode,
  );
  if (found) el.value = `${found.kode_kegiatan} - ${found.nama_kegiatan}`;
};

function resolveManualRekeningRowInput(accountCodeInput) {
  // Alur: cocokkan kode/nama dengan master, lalu simpan label standar agar mudah diverifikasi.
  if (!accountCodeInput) return;
  const accountCode = parseManualKodeValue(
    accountCodeInput.value,
    window._manualMasterRekening,
  );
  const matchingAccount = (window._manualMasterRekening || []).find(
    (rekening) => rekening.kode_rekening_belanja === accountCode,
  );
  if (matchingAccount) {
    accountCodeInput.value = `${matchingAccount.kode_rekening_belanja} - ${matchingAccount.nama_rekening_belanja}`;
  }
}

async function saveManualBKU() {
  // Alur: validasi header dan setiap kode rekening, susun payload rincian, kirim multipart, lalu refresh tampilan.
  try {
    const receiptNumber = document.getElementById("manual-no-bukti").value.trim();
    if (!receiptNumber) {
      showToast("Error!", "No Bukti wajib diisi");
      return;
    }

    const kode_kegiatan = parseManualKode(
      "manual-kode-kegiatan",
      window._manualMasterKegiatan,
    );
    const tanggal = document.getElementById("manual-tanggal").value || "";
    const tanggal_nota =
      document.getElementById("manual-tanggal-nota").value || "";
    const no_bast = document.getElementById("manual-no-bast").value || "";
    const nama_toko = document.getElementById("manual-nama-toko").value || "";
    const npwp = document.getElementById("manual-npwp").value || "";
    const alamat = document.getElementById("manual-alamat").value || "";
    const jenis_foto =
      document.getElementById("manual-jenis-foto").value || "barang";

    const detailRows = Array.from(document.querySelectorAll(".manual-uraian-row"));
    const parsedDetails = detailRows
      .map((r) => {
        const nama = r.querySelector(".manual-uraian-nama").value || "";
        const accountCodeInput = r.querySelector(".manual-uraian-kode-rekening");
        const accountCodeText = accountCodeInput.value.trim();
        const accountCode = parseManualKodeValue(
          accountCodeText,
          window._manualMasterRekening,
        );
        const vol =
          parseFloat(r.querySelector(".manual-uraian-volume").value) || 0;
        const satuan = r.querySelector(".manual-uraian-satuan").value || "";
        const hargaRaw = r.querySelector(".manual-uraian-harga").value || "0";
        const harga =
          parseFloat(
            hargaRaw.toString().replace(/\./g, "").replace(/,/g, "."),
          ) || 0;
        const pengeluaran =
          parseFloat(
            (r.querySelector(".manual-uraian-pengeluaran").value || "0")
              .toString()
              .replace(/\./g, "")
              .replace(/,/g, "."),
          ) || 0;
        return {
          detail: {
            nama_barang: nama,
            kode_rekening: accountCode,
            volume: vol,
            satuan: satuan,
            harga_satuan: harga,
            pengeluaran: pengeluaran,
          },
          isAccountCodeInvalid: Boolean(accountCodeText && !accountCode),
        };
      })
      .filter(
        ({ detail }) => detail.nama_barang || detail.pengeluaran > 0,
      );

    const rowWithInvalidAccountCode = parsedDetails.find(
      (item) => item.isAccountCodeInvalid,
    );
    if (rowWithInvalidAccountCode) {
      showToast(
        "Error!",
        "Kode rekening pada rincian belanja tidak ditemukan di master. Pilih kode atau nama rekening dari daftar.",
      );
      return;
    }

    const uraian = parsedDetails.map(({ detail }) => detail);
    if (uraian.length === 0) {
      showToast("Error!", "Tambahkan minimal satu uraian belanja");
      return;
    }

    const formData = new FormData();
    formData.append("no_bukti", receiptNumber);
    formData.append("kode_kegiatan", kode_kegiatan);
    formData.append("tanggal", tanggal);
    formData.append("tanggal_nota", tanggal_nota);
    formData.append("no_bast", no_bast);
    formData.append("nama_toko", nama_toko);
    formData.append("npwp_toko", npwp);
    formData.append("alamat_toko", alamat);
    formData.append("uraian_json", JSON.stringify(uraian));
    formData.append("jenis_foto", jenis_foto);

    // Attach photos: prefer in-memory buffer (user can remove previews) else fallback to file input
    if (window.manualBKUFiles && window.manualBKUFiles.length > 0) {
      window.manualBKUFiles.forEach((f) => formData.append("files", f));
    } else {
      const fotoInput = document.getElementById("manual-bku-foto");
      if (fotoInput && fotoInput.files && fotoInput.files.length > 0) {
        Array.from(fotoInput.files).forEach((f) => formData.append("files", f));
      }
    }

    showToast("info!", "Menyimpan data...");
    const res = await apiFetch(`${API_BASE}/kwitansi/manual`, {
      method: "POST",
      body: formData,
    });
    const json = await res.json();
    if (json.status !== "success") {
      showToast("Error!", json.detail || "Gagal menyimpan");
      return;
    }

    showToast("Berhasil!", json.message || "Data berhasil disimpan");
    closePopup();
    loadKwitansiList();
    loadDataBKU();
  } catch (err) {
    showToast("Error!", err.message || "Terjadi kesalahan");
  }
}

// ==========================================
// 1. HANDLE PHOTO INPUT (FIXED)
// ==========================================
window.handleManualBKUPhotos = function (input) {
  // Pastikan array global ada
  if (!window.manualBKUFiles) window.manualBKUFiles = [];

  // Ambil elemen select untuk jenis foto (PENTING: Ambil value saat upload)
  const jenisSelect = document.getElementById("manual-jenis-foto");
  const currentJenis = jenisSelect ? jenisSelect.value : "barang";

  const files = Array.from(input.files || []);

  for (const f of files) {
    // 1. Validasi Tipe File
    if (!f.type.startsWith("image/")) {
      if (typeof showToast === "function")
        showToast("Error!", "Hanya file gambar yang diperbolehkan");
      continue;
    }

    // 2. Validasi Jumlah Maksimal
    if (window.manualBKUFiles.length >= 15) {
      if (typeof showToast === "function")
        showToast("Error!", "Maksimal 15 foto");
      break;
    }

    // 3. PUSH OBJECT LENGKAP (BUKAN HANYA FILE)
    // Kita simpan url blob di sini agar konsisten
    window.manualBKUFiles.push({
      file: f, // File asli untuk diupload nanti
      jenis: currentJenis, // Jenis foto (barang/kegiatan/dll)
      previewUrl: URL.createObjectURL(f), // URL untuk preview di <img>
    });
  }

  // Reset input agar user bisa memilih file yang sama jika perlu
  try {
    input.value = "";
  } catch (e) {
    /* ignore */
  }

  // Render tampilan
  if (window.renderManualBKUPreview) window.renderManualBKUPreview();
};

// ==========================================
// 2. RENDER PREVIEW (MATCHING DATA STRUCTURE)
// ==========================================
window.renderManualBKUPreview = function () {
  const container = document.getElementById("manual-bku-preview");
  const counter = document.getElementById("manual-bku-counter");

  if (!container) return;
  container.innerHTML = "";

  const listFoto = window.manualBKUFiles || [];

  listFoto.forEach((item, idx) => {
    // item sekarang adalah object {file, jenis, previewUrl}
    const url = item.previewUrl;
    const jenisLabel = item.jenis || "barang";

    const div = document.createElement("div");
    div.className = "foto-item";

    // Inject HTML
    div.innerHTML = `
            <button class="foto-delete-btn" 
                type="button"
                onclick="event.stopPropagation(); deleteManualBKUPhoto(${idx})"
                title="Hapus Foto">
                ${iconSvg("x", 12)}
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
    counter.style.display = "block";
    counter.innerHTML =
      listFoto.length > 0
        ? `${listFoto.length} / 15 foto terpilih`
        : `Maksimal 15 foto.`;

    counter.style.color = listFoto.length >= 15 ? "red" : "#888";
  }
};

// ==========================================
// 3. DELETE PHOTO (CLEANUP MEMORY)
// ==========================================
window.deleteManualBKUPhoto = function (index) {
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
};

async function deleteExistingFoto(kwitansiId, index) {
  try {
    const response = await apiFetch(
      `${API_BASE}/kwitansi/${kwitansiId}/foto/${index}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`, // jika pakai auth
        },
      },
    );

    const result = await response.json();

    if (result.status === "success") {
      UI.success("Foto berhasil dihapus");
      // Refresh data popup atau hapus elemen dari DOM
      // Cara termudah: panggil ulang fungsi detail untuk refresh tampilan
      openUpdateDetailPopup(kwitansiId);
    } else {
      showToast("Gagal", "Gagal menghapus foto: " + result.message);
    }
  } catch (error) {
    showToast(
      "Gagal!",
      "Terjadi kesalahan sistem saat menghapus foto. " + error,
    );
  }
}

// --- Fungsi Save Update Detail (dengan upload foto bukti) ---
async function saveUpdateDetail(kwitansiId) {
  // Validasi detail dan lampiran, simpan formulir, lalu unggah foto yang dipilih.
  try {
    // ===============================
    // 1. Ambil data uraian
    // ===============================
    const uraianRows = document.querySelectorAll(".uraian-item-row");
    const uraianData = Array.from(uraianRows).map((row) => {
      const hargaRaw = row.querySelector(".edit-uraian-harga").value || "0";
      const hargaClean = hargaRaw.replace(/\./g, "");
      const volRaw = row.querySelector(".edit-uraian-vol").value || "0";

      return {
        nama_barang: row.querySelector(".edit-uraian-nama").value,
        volume: Math.round(parseFloat(volRaw) || 0),
        satuan: row.querySelector(".edit-uraian-satuan").value,
        harga_satuan: parseInt(hargaClean) || 0,
      };
    });

    // ===============================
    // 2. Payload utama (JSON)
    // ===============================
    const dataLampiran = collectDataLampiranForm();
    const jenisBelanja = document.getElementById("edit-jenis-belanja").value;
    const taxField = jenisBelanja === "sewa" ? "pph23" : "pph21";
    if (JENIS_BELANJA_SPJ[jenisBelanja]?.dokumen.some((dokumen) => dokumen.recipientTable)) {
      const recipients = dataLampiran.penerima_list || [];
      if (!recipients.length || recipients.some((recipient) =>
        !recipient.nama ||
        recipient.honor === "" ||
        !Number.isFinite(Number(recipient.honor)) ||
        Number(recipient.honor) < 0 ||
        !Number.isFinite(Number(recipient[taxField] ?? recipient.pph21 ?? 0)) ||
        Number(recipient[taxField] ?? recipient.pph21 ?? 0) < 0 ||
        Number(recipient[taxField] ?? recipient.pph21 ?? 0) > Number(recipient.honor)
      )) {
        const taxLabel = jenisBelanja === "sewa" ? "PPh 23" : "PPh 21";
        throw new Error(`Isi nama dan honor setiap penerima. ${taxLabel} tidak boleh melebihi honor.`);
      }
    }
    if (jenisBelanja === "jasa_tukang") {
      const start = new Date(`${dataLampiran.hadir_tanggal_awal}T00:00:00Z`);
      const end = new Date(`${dataLampiran.hadir_tanggal_akhir}T00:00:00Z`);
      const totalDays = Math.floor((end - start) / 86400000) + 1;
      if (
        !dataLampiran.hadir_tanggal_awal ||
        !dataLampiran.hadir_tanggal_akhir ||
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) ||
        start > end ||
        totalDays > 366
      ) {
        throw new Error("Tanggal awal dan akhir kegiatan harus valid, berurutan, dan maksimal 366 hari.");
      }
    }

    const payload = {
      nama_kegiatan: document.getElementById("edit-nama-kegiatan").value,
      no_bast: document.getElementById("edit-no-bast").value,
      tanggal_nota: document.getElementById("edit-tanggal-nota").value,
      nama_toko: document.getElementById("edit-nama-toko").value,
      npwp_toko: document.getElementById("edit-npwp-toko").value,
      alamat_toko: document.getElementById("edit-alamat-toko").value,
      no_telp_toko: document.getElementById("edit-no-telp-toko").value,
      no_nota: document.getElementById("edit-no-nota").value,
      uraian: uraianData,
      jenis_belanja: jenisBelanja,
      data_lampiran: dataLampiran,
    };

    // ===============================
    // 3. Simpan detail kwitansi
    // ===============================
    const res = await apiFetch(
      `${API_BASE}/kwitansi/${kwitansiId}/update-detail`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    const result = await res.json();
    if (!res.ok || result.status !== "success") {
      const message =
        result.detail || `Gagal update detail (HTTP ${res.status})`;
      appLog(
        "error",
        `saveUpdateDetail: gagal kwitansi=${kwitansiId}, HTTP ${res.status}: ${message}`,
      );
      throw new Error(message);
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
      Array.from(fotoInput.files).forEach((file) => {
        formData.append("files", file);
      });

      const uploadRes = await apiFetch(
        `${API_BASE}/kwitansi/${kwitansiId}/upload-foto`,
        {
          method: "POST",
          body: formData,
        },
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
  disposeSpjPreview();
  let overlay = document.getElementById("popup-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "popup-overlay";
    overlay.style =
      "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; z-index:9999; backdrop-filter: blur(4px);";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = html;
  overlay.style.display = "flex";
}

function closePopup() {
  disposeSpjPreview();
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
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  }).format(amount);
}

// UNTUK INPUT SAAT DIKETIK (Real-time)
function formatCurrencyInput(input) {
  let value = input.value.replace(/\D/g, "");
  if (value === "") {
    input.value = "";
    return;
  }
  input.value = Number(value).toLocaleString("id-ID");
}

window.formatCurrencyLabel = formatCurrencyLabel;
window.formatCurrencyInput = formatCurrencyInput;

async function loadDataBKU() {
  const tbody = document.getElementById("bku-body");
  if (!tbody) return;

  tbody.innerHTML =
    '<tr><td colspan="12" style="text-align:center;">Memuat data...</td></tr>';

  try {
    const query = scopeQueryString(
      document.getElementById("bku-scope-filter")?.value,
    );
    const response = await apiFetch(
      `${API_BASE}/transaksi${query ? `?${query}` : ""}`,
    );
    const result = await response.json();

    // KARENA BACKEND MENGIRIM {"status": "success", "data": [...] }
    // MAKA KITA AMBIL result.data
    const transactions = result.data || [];

    // SIMPAN KE VARIABEL GLOBAL bkuData UNTUK PENCARIAN
    bkuData = {
      transaksi: transactions,
      kwitansi_list: bkuData?.kwitansi_list || [],
    };

    if (transactions.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="12" style="text-align:center;">Tidak ada data BKU ditemukan.</td></tr>';
      return;
    }

    tbody.innerHTML = ""; // Bersihkan loading state

    transactions.forEach((item) => {
      const row = `
        <tr>
            <td>${escapeSpjFormValue(item.no_bukti || "-")}</td>
            <td>${escapeSpjFormValue(item.tanggal || "-")}</td>
            <td>${escapeSpjFormValue(item.kode_kegiatan || "-")}</td>
            <td>${escapeSpjFormValue(item.kode_rekening || "-")}</td>
            <td>${escapeSpjFormValue(item.uraian || "-")}</td>
            ${renderBkuShopIdentity(item)}
            <td>${escapeSpjFormValue(item.volume || 0)}</td>
            <td>${escapeSpjFormValue(item.satuan || "")}</td>
            <td>${formatCurrencyLabel(item.harga_satuan || 0)}</td>
            <td>${formatCurrencyLabel(item.pengeluaran || 0)}</td>
            <td style="text-align:center">
                <button class="btn btn-danger btn-sm" onclick="${escapeSpjFormValue(`deleteTransaksi(${JSON.stringify(String(item.no_bukti || ""))}, ${JSON.stringify({
                  fiscal_year: item.fiscal_year ?? "unspecified",
                  source_fund_id: item.source_fund_id || "unspecified",
                  budget_id: item.budget_id || "unspecified",
                })})`)}">Hapus</button>
            </td>
            <td>${renderFiscalContext(item)}</td>
        </tr>
    `;
      tbody.insertAdjacentHTML("beforeend", row);
    });
  } catch (error) {
    showToast("Gagal!", error);
    tbody.innerHTML =
      '<tr><td colspan="12" style="text-align:center; color:red;">Gagal terhubung ke database.</td></tr>';
  }
}

async function deleteTransaksi(no_bukti, scope = {}) {
  if (
    !(await UI.confirm(
      `Apakah Anda yakin ingin menghapus transaksi dengan No Bukti: ${no_bukti}? Data yang dihapus tidak dapat dikembalikan.`,
      { title: "Hapus Transaksi", okText: "Hapus", danger: true },
    ))
  ) {
    return;
  }

  try {
    // Panggil endpoint DELETE ke backend
    const params = new URLSearchParams({
      fiscal_year: String(scope.fiscal_year ?? "unspecified"),
      source_fund_id: String(scope.source_fund_id || "unspecified"),
      budget_id: String(scope.budget_id || "unspecified"),
    });
    const response = await apiFetch(
      `${API_BASE}/transaksi/${encodeURIComponent(no_bukti)}?${params}`,
      {
        method: "DELETE",
      },
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.detail || "Gagal menghapus transaksi di server.");
    }
    // Jika bkuData null/kosong, blok ini dilewati tanpa error dan tanpa warning.
    if (typeof loadDataBKU() === "function") {
      loadDataBKU();
    }

    // 2. Update tabel Draft SPJ/Kwitansi (agar sinkron)
    if (typeof loadKwitansiList === "function") {
      loadKwitansiList();
    }

    // 3. Tampilkan Notifikasi Sukses Saja
    showToast("Berhasil!", "Data BKU dan Draft SPJ terkait berhasil dihapus.");
  } catch (error) {
    showToast("Gagal!", `Gagal menghapus: ${error.message}`);
  }
}

// Tampilkan/sembunyikan placeholder pada kotak preview logo
function syncLogoPlaceholder(img) {
  const box = img?.closest(".logo-preview-box");
  if (!box) return;
  const ph = box.querySelector(".logo-preview-placeholder");
  const hasSrc =
    img && img.src && img.src !== "#" && img.style.display !== "none";
  if (ph) ph.style.display = hasSrc ? "none" : "flex";
}

function previewImage(input, previewId) {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function (e) {
      preview.src = e.target.result;
      preview.style.display = "block";
      syncLogoPlaceholder(preview);
    };
    reader.readAsDataURL(input.files[0]);
  } else {
    preview.src = "#";
    preview.style.display = "none";
    syncLogoPlaceholder(preview);
  }
}

// Buka gambar logo penuh di jendela baru (untuk memeriksa detail resolusi tinggi)
function openLogoFull(previewId) {
  const img = document.getElementById(previewId);
  if (!img || !img.src || img.src === "#" || img.style.display === "none")
    return;
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(
      `<title>Pratinjau Logo</title><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f1f5f9;"><img src="${img.src}" style="max-width:92vw;max-height:92vh;object-fit:contain;"></body>`,
    );
  }
  const preview = document.getElementById(previewId);
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function (e) {
      preview.src = e.target.result;
      preview.style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  } else {
    preview.src = "#";
    preview.style.display = "none";
  }
}

// Fungsi Simpan Data (POST ke Backend)
// BUG v1.2.4 lanjutan: UI lama "Kop Surat / Pemda" (elemen kop-1, kop-2,
// kop-alamat, logo-pemda, logo-sekolah, tempat_surat) sudah DIHAPUS dan
// digabung ke form Identitas Periode (idn-*). Fungsi ini masih membaca
// elemen lama secara langsung — `document.getElementById("kop-1").value`
// melempar TypeError "Cannot set properties of null" begitu dipanggil, dan
// `logo-pemda`/`logo-sekolah` pun tidak ada lagi di DOM. Karena itu seluruh
// akses elemen kini diberi penjaga null; bila form lama memang tidak ada di
// halaman, penyimpanan ditolak dengan pesan jelas (bukan crash senyap), dan
// pemakai diarahkan memakai menu Identitas Periode.
async function saveDataPemda() {
  const elNamaPemda = document.getElementById("kop-1");
  const elNamaSekolah = document.getElementById("kop-2");
  const elAlamat = document.getElementById("kop-alamat");

  // Form lama tidak ada di UI saat ini → jangan lanjut (mencegah crash).
  if (!elNamaPemda || !elNamaSekolah || !elAlamat) {
    appLog(
      "error",
      "saveDataPemda: elemen form Kop/Pemda lama (kop-1/kop-2/kop-alamat) tidak ditemukan di DOM — gunakan form Identitas Periode (idn-*).",
    );
    showToast(
      "Perhatian!",
      "Form Kop/Pemda lama sudah digabung ke menu Identitas Periode. Simpan identitas lewat form tersebut.",
    );
    return;
  }

  const formData = new FormData();

  // Ambil nilai teks
  formData.append("nama_pemda", elNamaPemda.value);
  formData.append("nama_sekolah", elNamaSekolah.value);
  formData.append("alamat_sekolah", elAlamat.value);
  formData.append(
    "tempat_surat",
    document.getElementById("tempat_surat")?.value || "",
  );

  // Ambil file logo (input lama opsional — tidak ada di UI baru)
  const filePemda = document.getElementById("logo-pemda")?.files?.[0];
  const fileSekolah = document.getElementById("logo-sekolah")?.files?.[0];

  if (filePemda) formData.append("logo_pemda", filePemda);
  if (fileSekolah) formData.append("logo_sekolah", fileSekolah);

  try {
    const response = await apiFetch(`${API_BASE}/save-pemda`, {
      method: "POST",
      body: formData,
      // Jangan tambahkan Header Content-Type, browser akan mengaturnya otomatis sebagai multipart/form-data
    });

    const res = await response.json().catch(() => null);
    if (res && res.status === "success") {
      showToast("Berhasil!", res.message);
      loadDataPemda(); // Refresh data setelah simpan
    } else {
      const detail = res?.detail || res?.message || "Gagal menyimpan data";
      showToast("Gagal!", String(detail));
    }
  } catch (err) {
    appLog("error", "saveDataPemda gagal: " + ((err && err.stack) || err));
    showToast("Gagal!", "Terjadi kesalahan koneksi ke server: " + err.message);
  }
}

// Bangun URL absolut untuk aset backend (logo/upload) dari path relatif.
// Wajib memakai origin child_process dinamis — servis localhost statis (8000)
// sudah ditiadakan, dan pada build produksi halaman dimuat via file:// sehingga
// path relatif tidak akan pernah resolve tanpa origin eksplisit.
function assetUrl(path) {
  if (!path) return "";
  if (/^(https?:|data:|blob:|file:)/i.test(path)) return path;
  const root = getServerRoot();
  if (!root) {
    appLog(
      "error",
      `Aset tidak dapat dimuat — backend child_process belum siap: ${path}`,
    );
    return "";
  }
  return `${root}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Fungsi Load Data (Panggil saat aplikasi dibuka atau tab diklik)
// BUG v1.2.4 lanjutan (toast "Error loading data: TypeError: Cannot set
// properties of null (setting 'value')"): GET /api/get-pemda menjawab 200,
// tetapi baris berikutnya `document.getElementById("kop-1").value = ...`
// crash karena elemen UI lama Kop/Pemda (kop-1, kop-2, kop-alamat,
// preview-logo-pemda, preview-logo-sekolah) sudah dihapus dari DOM dan
// digabung ke form Identitas Periode (idn-*).
//
// Perbaikan sesuai analisa: BUKAN sekadar `if (element)` senyap — data
// legacy /get-pemda kini disimpan ke state `_dataPemdaLegacy` agar tetap
// berguna sebagai FALLBACK (mis. saat form idn baru kosong), sementara
// pengisian elemen dilakukan lewat helper null-safe sehingga tidak ada
// lagi TypeError apa pun. Error juga dicatat ke app.log (sebelumnya blok
// catch hanya menampilkan toast sehingga kegagalan pasca-HTTP-200 tidak
// pernah terlihat di console/log).
let _dataPemdaLegacy = null;

async function loadDataPemda() {
  // Helper null-safe: isi .value hanya bila elemennya benar-benar ada.
  const setValSafe = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ?? "";
    return !!el;
  };
  try {
    const response = await apiFetch(`${API_BASE}/get-pemda`);
    const res = await response.json();

    if (res.data) {
      // Simpan salinan legacy untuk fallback/preview fitur lain.
      _dataPemdaLegacy = res.data;

      // Elemen form lama (opsional — hilang di UI Identitas Periode baru).
      const adaFormLama =
        setValSafe("kop-1", res.data.nama_pemda || "") |
        setValSafe("kop-2", res.data.nama_sekolah || "") |
        setValSafe("kop-alamat", res.data.alamat_sekolah || "");

      if (res.data.logo_pemda) {
        const img = document.getElementById("preview-logo-pemda");
        if (img) {
          // Logo kini dikirim backend sebagai data URI base64 — pakai langsung,
          // tanpa assetUrl/cache-buster (data URI tidak perlu di-cache-bust).
          img.src = res.data.logo_pemda.startsWith("data:")
            ? res.data.logo_pemda
            : `${assetUrl(res.data.logo_pemda)}?t=${new Date().getTime()}`;
          img.style.display = "block";
          if (typeof syncLogoPlaceholder === "function") syncLogoPlaceholder(img);
        }
      }

      if (res.data.logo_sekolah) {
        const img = document.getElementById("preview-logo-sekolah");
        if (img) {
          img.src = res.data.logo_sekolah.startsWith("data:")
            ? res.data.logo_sekolah
            : `${assetUrl(res.data.logo_sekolah)}?t=${new Date().getTime()}`;
          img.style.display = "block";
          if (typeof syncLogoPlaceholder === "function") syncLogoPlaceholder(img);
        }
      }

      // tempat_surat
      if (typeof res.data.tempat_surat !== "undefined") {
        const el = document.getElementById("tempat_surat");
        if (el) el.value = res.data.tempat_surat || "";
        const preview = document.getElementById("preview-tempat-surat");
        if (preview) preview.innerText = res.data.tempat_surat || "";
      }

      if (!adaFormLama) {
        appLog(
          "info",
          "loadDataPemda: form Kop/Pemda lama tidak ada di DOM — data legacy disimpan di state (_dataPemdaLegacy) sebagai fallback; UI memakai form Identitas Periode.",
        );
      }
    }
  } catch (err) {
    // Catat ke app.log agar kegagalan pasca-HTTP-200 terlihat (bukan hanya toast).
    appLog("error", "loadDataPemda gagal: " + ((err && err.stack) || err));
    showToast("Gagal!", "Error loading data: " + err);
  }
}

// Live preview for Pemda tab (keberadaan: update preview nama & logo kecil)
function updatePemdaPreview() {
  const kop1 = document.getElementById("kop-1")?.value || "Nama Pemda";
  const kop2 =
    document.getElementById("kop-2")?.value || "Nama Satuan Pendidikan";
  const alamat =
    document.getElementById("kop-alamat")?.value ||
    "Alamat akan tampil di sini";

  const el1 = document.getElementById("preview-kop-1");
  if (el1) el1.innerText = kop1;
  const el2 = document.getElementById("preview-kop-2");
  if (el2) el2.innerText = kop2;
  const el3 = document.getElementById("preview-kop-alamat");
  if (el3) el3.innerText = alamat;

  const tempat = document.getElementById("tempat_surat")?.value || "";
  const el4 = document.getElementById("preview-tempat-surat");
  if (el4) el4.innerText = tempat;

  const large1 = document.getElementById("preview-logo-pemda");
  const small1 = document.getElementById("preview-logo-pemda-small");
  if (
    large1 &&
    small1 &&
    large1.src &&
    large1.src !== "#" &&
    large1.style.display !== "none"
  ) {
    small1.src = large1.src;
    small1.style.display = "block";
  } else if (small1) small1.style.display = "none";

  const large2 = document.getElementById("preview-logo-sekolah");
  const small2 = document.getElementById("preview-logo-sekolah-small");
  if (
    large2 &&
    small2 &&
    large2.src &&
    large2.src !== "#" &&
    large2.style.display !== "none"
  ) {
    small2.src = large2.src;
    small2.style.display = "block";
  } else if (small2) small2.style.display = "none";
}

// ==========================================================================
// IDENTITAS SATUAN PENDIDIKAN PER PERIODE (menu terpadu: kop + surat + pejabat)
// Backend: /identitas-periode (list, detail, simpan POST, hapus DELETE).
// Satu entri memuat kop/letterhead, logo, dan pejabat penanda tangan yang
// berlaku antara tanggal_awal..tanggal_akhir. Dokumen (Kwitansi/BAST/RAB)
// otomatis memakai entri yang periodanya mencakup tanggal dokumen.
// ==========================================================================

// Ambil nilai file <input type=file> sebagai data URI base64 (null bila kosong)
function readFileAsDataUri(input) {
  return new Promise((resolve, reject) => {
    const f = input && input.files && input.files[0];
    if (!f) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Gagal membaca file ${f.name}`));
    reader.readAsDataURL(f);
  });
}

// Tampilkan/sembunyikan <img> preview beserta placeholder kotaknya
function setIdnImgPreview(imgId, src) {
  const img = document.getElementById(imgId);
  if (!img) return;
  if (src) {
    img.src = src;
    img.style.display = "block";
  } else {
    img.src = "#";
    img.style.display = "none";
  }
  if (typeof syncLogoPlaceholder === "function") syncLogoPlaceholder(img);
}

// Muat daftar periode identitas + tandai entri aktif untuk tanggal uji.
// `maxRetry` menangani kasus backend menjawab 5xx sesaat setelah proses
// child_process melapor (mis. skema DB lama masih diselaraskan saat request
// pertama datang — bug "FETCH <- 500 GET /api/identitas-periode"). Backend
// sudah dipaksa menahan /health sampai skema siap, tetapi retry ringan ini
// tetap dipasang sebagai penjaga terakhir di sisi renderer.
//
// BUG v1.2.4 lanjutan: error 5xx harus di-retry TANPA terjebak di blok catch
// yang langsung berhenti. Dahulu `throw err` di dalam blok try tertangkap oleh
// `catch` fungsi itu sendiri sehingga percobaan ulang tidak pernah terjadi dan
// pengguna melihat "loadIdentitasPeriode gagal" sejak HTTP 500 pertama.
// Sekarang kegagalan 5xx dicatat lewat variabel `lastError` dan loop benar-
// benar mengulang; pesan error final baru ditampilkan setelah semua retry habis.
async function loadIdentitasPeriode(maxRetry = 3) {
  let attempt = 0;
  let lastError = null;
  for (; ;) {
    attempt++;
    lastError = null;
    try {
      // ROOT CAUSE "FETCH <- 500 GET /api/identitas-periode" (baris URL di
      // bawah membentuk string dari Proxy API_BASE): bila fungsi ini sempat
      // berjalan sebelum _backendOrigin terisi, `${API_BASE}/...` menjadi
      // path RELATIF "/api/identitas-periode" yang tertangkap origin Vite
      // (5173) dan menjawab 500. Karena itu tunggu backend siap SEBELUM URL
      // dibentuk — apiFetch kini juga menunggu, tetapi pembentukan URL di
      // sini harus memakai origin yang sudah pasti ada.
      await ensureBackendReady();
      const tglEl = document.getElementById("idn-tgl-uji");
      const tgl = tglEl ? tglEl.value || "" : "";
      // API_BASE selalu prefix http://127.0.0.1:<port-dinamis>/api — JANGAN
      // pakai path relatif "/api/..." karena akan mengenai origin dev server
      // Vite (http://localhost:5173) yang tidak memiliki endpoint tersebut
      // (proxy Vite menunjuk ke port statis 8000 yang sudah dimatikan),
      // sehingga respons 500 kosong memicu "Unexpected end of JSON input".
      const url = `${API_BASE}/identitas-periode${tgl ? `?tanggal=${encodeURIComponent(tgl)}` : ""}`;
      const response = await apiFetch(url);
      const text = await response.text();
      let res = null;
      try {
        res = text ? JSON.parse(text) : null;
      } catch (_) {
        res = null;
      }
      if (!response.ok || !res) {
        const detail = (res && (res.detail || res.message)) || `HTTP ${response.status}`;
        lastError = new Error(`Backend menolak permintaan daftar identitas (${detail})`);
        // 5xx dari backend yang sedang bersiap → tunggu sebentar lalu coba lagi.
        if (response.status >= 500 && attempt <= maxRetry) {
          const delay = 500 * attempt; // 500ms, 1s, 1.5s
          appLog(
            "warn",
            `loadIdentitasPeriode: HTTP ${response.status}, mencoba ulang (${attempt}/${maxRetry}) dalam ${delay} ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      } else {
        identitasPeriodeList = Array.isArray(res.data) ? res.data : [];
        identitasAktifId = res.aktif_id ?? null;
        renderIdentitasPeriodeList();
        updateIdentitasAktifInfo();
        return;
      }
    } catch (err) {
      // Kegagalan jaringan total (backend mati/di-blok) juga layak di-retry
      // beberapa kali selama masa startup, bukan langsung menyerah.
      lastError = err;
      if (attempt <= maxRetry) {
        const delay = 500 * attempt;
        appLog(
          "warn",
          `loadIdentitasPeriode: ${err && err.message ? err.message : err}, mencoba ulang (${attempt}/${maxRetry}) dalam ${delay} ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
    // Semua percobaan habis (atau respons non-5xx yang tetap ditolak) → lapor.
    const err = lastError || new Error("loadIdentitasPeriode: kegagalan tak terdefinisi");
    appLog("error", "loadIdentitasPeriode gagal: " + err);
    showToast("Gagal!", "Tidak dapat memuat daftar identitas: " + err.message);
    return;
  }
}

function idnEscapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function idnFormatTgl(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Render tabel daftar periode identitas
function renderIdentitasPeriodeList() {
  const wrap = document.getElementById("idn-list");
  const cnt = document.getElementById("idn-count");
  if (cnt) cnt.textContent = identitasPeriodeList.length;
  if (!wrap) return;

  if (!identitasPeriodeList.length) {
    wrap.innerHTML = `<p style="color:#64748b;font-size:13px;margin:8px 0;">Belum ada entri identitas. Klik <strong>Tambah Identitas</strong> untuk membuat identitas pertama (kop, logo, dan pejabat untuk satu periode).</p>`;
    return;
  }

  const rows = identitasPeriodeList
    .map((it) => {
      const isAktif = identitasAktifId != null && it.id === identitasAktifId;
      const badge = isAktif
        ? `<span class="badge-ref" style="background:#dcfce7;color:#166534;">Tercetak utk tanggal uji</span>`
        : "";
      const statusBadge = it.is_active
        ? `<span class="badge-ref" style="background:#e0f2fe;color:#075985;">Aktif</span>`
        : `<span class="badge-ref" style="background:#f1f5f9;color:#64748b;">Arsip</span>`;
      const periode = `${idnFormatTgl(it.tanggal_awal) || "-"} &ndash; ${it.tanggal_akhir ? idnFormatTgl(it.tanggal_akhir) : "sekarang"}`;
      return `
        <tr${isAktif ? ' style="background:#f0fdf4;"' : ""}>
          <td>
            <strong>${idnEscapeHtml(it.nama_sekolah) || "<em style='color:#94a3b8'>(nama kosong)</em>"}</strong><br>
            <small style="color:#64748b;">${idnEscapeHtml(it.label) || idnEscapeHtml(it.nama_pemda)}</small>
          </td>
          <td>${periode}</td>
          <td>${idnEscapeHtml(it.nama_kepala_sekolah) || "-"}<br><small style="color:#64748b;">NIP: ${idnEscapeHtml(it.nip_kepala_sekolah) || "-"}</small></td>
          <td style="text-align:center;">${it.logo_pemda ? iconSvg("check", 15) : '<span style="color:#cbd5e1;">&mdash;</span>'} / ${it.logo_sekolah ? iconSvg("check", 15) : '<span style="color:#cbd5e1;">&mdash;</span>'}</td>
          <td>${statusBadge} ${badge}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-secondary btn-sm" title="Edit entri ini" onclick="editIdentitasPeriode(${it.id})">${iconSvg("edit", 14)} Edit</button>
            <button class="btn btn-secondary btn-sm" title="Duplikat sebagai periode baru" onclick="duplicateIdentitasPeriode(${it.id})">${iconSvg("plus", 14)} Duplikat</button>
            <button class="btn btn-danger btn-sm" title="Hapus entri ini" onclick="deleteIdentitasPeriode(${it.id})">${iconSvg("trash", 14)} Hapus</button>
          </td>
        </tr>`;
    })
    .join("");

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Satuan Pendidikan / Label</th><th>Periode Berlaku</th><th>Kepala Satuan Pendidikan</th>
        <th style="text-align:center;">Logo Pemda / Sekolah</th><th>Status</th><th>Aksi</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Info singkat: entri mana yang akan tercetak untuk tanggal uji
function updateIdentitasAktifInfo() {
  const el = document.getElementById("idn-aktif-info");
  if (!el) return;
  const tglEl = document.getElementById("idn-tgl-uji");
  const tgl = tglEl ? tglEl.value : "";
  if (identitasAktifId != null) {
    const it = identitasPeriodeList.find((x) => x.id === identitasAktifId);
    el.innerHTML = `Dokumen bertanggal <strong>${idnFormatTgl(tgl)}</strong> akan memakai: <strong>${idnEscapeHtml(it?.nama_sekolah || "-")}</strong> (pejabat: ${idnEscapeHtml(it?.nama_kepala_sekolah || "-")})`;
  } else {
    el.innerHTML = `<span style="color:#b45309;">Tidak ada periode yang mencakup tanggal uji — sistem memakai fallback (entri aktif terbaru / pengaturan lama).</span>`;
  }
}

// Kosongkan form untuk membuat entri baru.
// FALLBACK DATA LAMA: saat menambah entri baru, field kop yang masih kosong
// diisi dari data legacy /get-pemda (_dataPemdaLegacy) — hasil pemetaan inilah
// yang dipakai backend bila belum ada satupun entri IdentitasPeriode, sehingga
// data warisan tidak hilang dan pengguna tinggal menyesuaikan periode barunya.
function resetIdentitasForm({ show = true } = {}) {
  identitasFormMode = "new";
  identitasEditingId = null;
  const formCard = document.getElementById("idn-form-card");
  if (formCard) formCard.hidden = !show;
  const form = document.getElementById("form-identitas");
  if (form) form.reset();
  ["idn-label", "idn-tanggal-awal", "idn-tanggal-akhir", "idn-pemda", "idn-sekolah", "idn-alamat", "idn-tempat", "idn-kepala", "idn-nip-kepala", "idn-bendahara", "idn-nip-bendahara", "idn-pengurus", "idn-nip-pengurus"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    },
  );
  const sel = document.getElementById("idn-active");
  if (sel) sel.value = "1";
  setIdnImgPreview("idn-preview-logo-pemda", "");
  setIdnImgPreview("idn-preview-logo-sekolah", "");

  // Isi awal dari data Pengaturan lama (fallback) bila sudah dimuat.
  const legacy = _dataPemdaLegacy || {};
  const prefill = (id, v) => {
    const el = document.getElementById(id);
    if (el && !el.value && v) el.value = v;
  };
  prefill("idn-pemda", legacy.nama_pemda);
  prefill("idn-sekolah", legacy.nama_sekolah);
  prefill("idn-alamat", legacy.alamat_sekolah);
  prefill("idn-tempat", legacy.tempat_surat);
  // Logo legacy datang sebagai data URI dari /get-pemda → tampilkan di preview.
  setIdnImgPreview("idn-preview-logo-pemda", legacy.logo_pemda || "");
  setIdnImgPreview("idn-preview-logo-sekolah", legacy.logo_sekolah || "");
  _idnLogoPemdaKeep = "";
  _idnLogoSekolahKeep = "";

  const title = document.getElementById("idn-form-title");
  if (title) title.innerHTML = `${iconSvg("edit", 17)} Periode Identitas`;
  updateIdentitasPreview();
}

// Isi form dari satu entri (dipakai Edit & Duplikat)
function isiFormDariIdentitas(d, { duplikat = false } = {}) {
  const formCard = document.getElementById("idn-form-card");
  if (formCard) formCard.hidden = false;
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = v ?? "";
  };
  setVal("idn-label", d.label);
  setVal("idn-tanggal-awal", d.tanggal_awal);
  setVal("idn-tanggal-akhir", d.tanggal_akhir);
  setVal("idn-pemda", d.nama_pemda);
  setVal("idn-sekolah", d.nama_sekolah);
  setVal("idn-alamat", d.alamat_sekolah);
  setVal("idn-tempat", d.tempat_surat);
  setVal("idn-kepala", d.nama_kepala_sekolah);
  setVal("idn-nip-kepala", d.nip_kepala_sekolah);
  setVal("idn-bendahara", d.nama_bendahara);
  setVal("idn-nip-bendahara", d.nip_bendahara);
  setVal("idn-pengurus", d.nama_pengurus_barang);
  setVal("idn-nip-pengurus", d.nip_pengurus_barang);
  const sel = document.getElementById("idn-active");
  if (sel) sel.value = d.is_active ? "1" : "0";

  // Logo: kirim apa adanya ke backend agar tetap dipertahankan saat update
  // (nilai non-empty yang bukan data URI dianggap "pertahankan").
  setIdnImgPreview("idn-preview-logo-pemda", d.logo_pemda || "");
  setIdnImgPreview("idn-preview-logo-sekolah", d.logo_sekolah || "");
  _idnLogoPemdaKeep = d.logo_pemda || "";
  _idnLogoSekolahKeep = d.logo_sekolah || "";

  if (duplikat) {
    identitasFormMode = "new";
    identitasEditingId = null;
    const title = document.getElementById("idn-form-title");
    if (title) title.innerHTML = `${iconSvg("plus", 17)} Tambah Identitas (hasil duplikat — sesuaikan tanggal & datanya)`;
  } else {
    identitasFormMode = "edit";
    identitasEditingId = d.id;
    const title = document.getElementById("idn-form-title");
    if (title) title.innerHTML = `${iconSvg("edit", 17)} Edit Identitas #${d.id} — ${d.nama_sekolah || "(tanpa nama)"}`;
  }
  updateIdentitasPreview();
}

// Penanda "logo lama dipertahankan" selama mode edit (diisi oleh isiFormDariIdentitas)
var _idnLogoPemdaKeep = "";
var _idnLogoSekolahKeep = "";

async function editIdentitasPeriode(id) {
  try {
    const response = await apiFetch(`${API_BASE}/identitas-periode/${id}`);
    const res = await response.json();
    if (!res || res.status !== "success" || !res.data) {
      showToast("Gagal!", res?.detail || "Entri tidak ditemukan");
      return;
    }
    isiFormDariIdentitas(res.data);
    document.getElementById("idn-form-card")?.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    showToast("Gagal!", "Error memuat detail: " + err.message);
  }
}

async function duplicateIdentitasPeriode(id) {
  try {
    const response = await apiFetch(`${API_BASE}/identitas-periode/${id}`);
    const res = await response.json();
    if (!res || res.status !== "success" || !res.data) {
      showToast("Gagal!", res?.detail || "Entri tidak ditemukan");
      return;
    }
    isiFormDariIdentitas(res.data, { duplikat: true });
    document.getElementById("idn-form-card")?.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    showToast("Gagal!", "Error menduplikat: " + err.message);
  }
}

async function deleteIdentitasPeriode(id) {
  const it = identitasPeriodeList.find((x) => x.id === id);
  const ok = await UI.confirm(
    `Hapus identitas "${it?.nama_sekolah || "#" + id}" (periode ${idnFormatTgl(it?.tanggal_awal) || "-"} s.d. ${it?.tanggal_akhir ? idnFormatTgl(it.tanggal_akhir) : "sekarang"})?\n\nDokumen pada rentang tanggal tersebut akan jatuh ke entri lain/fallback.`,
    { title: "Hapus Identitas Periode", okText: "Hapus", danger: true },
  );
  if (!ok) return;
  try {
    const response = await apiFetch(`${API_BASE}/identitas-periode/${id}`, {
      method: "DELETE",
    });
    const res = await response.json().catch(() => null);
    if (res && res.status === "success") {
      showToast("Berhasil!", res.message || "Entri identitas dihapus.");
      if (identitasEditingId === id) resetIdentitasForm({ show: false });
      loadIdentitasPeriode();
      loadDataPemda().then(() => {
        if (typeof updatePemdaPreview === "function") updatePemdaPreview();
      });
    } else {
      showToast("Gagal!", String(res?.detail || "Gagal menghapus entri"));
    }
  } catch (err) {
    showToast("Gagal!", "Error koneksi: " + err.message);
  }
}

// Simpan entri (POST JSON). File logo dibaca menjadi data URI base64.
async function saveIdentitasPeriode() {
  const val = (id) => document.getElementById(id)?.value?.trim() || "";
  const tanggalAwal = val("idn-tanggal-awal");
  if (!tanggalAwal) {
    showToast("Perhatian!", "Tanggal awal berlaku wajib diisi.");
    return;
  }
  const tanggalAkhir = val("idn-tanggal-akhir");
  if (tanggalAkhir && tanggalAkhir < tanggalAwal) {
    showToast("Perhatian!", "Tanggal akhir tidak boleh lebih kecil dari tanggal awal.");
    return;
  }

  let logoPemda, logoSekolah;
  try {
    logoPemda = await readFileAsDataUri(document.getElementById("idn-logo-pemda"));
    logoSekolah = await readFileAsDataUri(document.getElementById("idn-logo-sekolah"));
  } catch (err) {
    showToast("Gagal!", err.message);
    return;
  }
  // Tidak ada file baru → pertahankan logo lama (kirim penanda non-empty)
  if (!logoPemda) logoPemda = identitasFormMode === "edit" ? _idnLogoPemdaKeep || "" : "";
  if (!logoSekolah) logoSekolah = identitasFormMode === "edit" ? _idnLogoSekolahKeep || "" : "";

  const payload = {
    id: identitasFormMode === "edit" ? identitasEditingId : null,
    label: val("idn-label"),
    tanggal_awal: tanggalAwal,
    tanggal_akhir: tanggalAkhir,
    is_active: (document.getElementById("idn-active")?.value || "1") === "1",
    nama_pemda: val("idn-pemda"),
    nama_sekolah: val("idn-sekolah"),
    alamat_sekolah: val("idn-alamat"),
    tempat_surat: val("idn-tempat"),
    logo_pemda: logoPemda,
    logo_sekolah: logoSekolah,
    nama_kepala_sekolah: val("idn-kepala"),
    nip_kepala_sekolah: val("idn-nip-kepala"),
    nama_bendahara: val("idn-bendahara"),
    nip_bendahara: val("idn-nip-bendahara"),
    nama_pengurus_barang: val("idn-pengurus"),
    nip_pengurus_barang: val("idn-nip-pengurus"),
  };

  try {
    const response = await apiFetch(`${API_BASE}/identitas-periode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await response.json().catch(() => null);
    if (res && res.status === "success") {
      showToast("Berhasil!", res.message);
      resetIdentitasForm({ show: false });
      await loadIdentitasPeriode();
      // Sinkronkan pratinjau menu lama (kop/pemda legacy ikut terbarukan)
      loadDataPemda().then(() => {
        if (typeof updatePemdaPreview === "function") updatePemdaPreview();
      });
    } else {
      showToast("Gagal!", String(res?.detail || "Gagal menyimpan identitas"));
    }
  } catch (err) {
    showToast("Gagal!", "Terjadi kesalahan koneksi ke server: " + err.message);
  }
}

// Pratinjau kop surat langsung (live) dari isi form
function updateIdentitasPreview() {
  const val = (id) => document.getElementById(id)?.value?.trim() || "";
  const setText = (id, t, fb) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t || fb;
  };
  setText("idn-kop-1", val("idn-pemda"), "NAMA PEMERINTAH DAERAH");
  setText("idn-kop-2", val("idn-sekolah"), "NAMA SATUAN PENDIDIKAN");
  setText("idn-kop-alamat", val("idn-alamat"), "Alamat akan tampil di sini");
  setText("idn-kop-tempat", val("idn-tempat"), "-");
  setText("idn-kop-kepala", val("idn-kepala"), "-");

  const awl = val("idn-tanggal-awal");
  const akh = val("idn-tanggal-akhir");
  setText(
    "idn-kop-periode",
    awl ? `${idnFormatTgl(awl)} – ${akh ? idnFormatTgl(akh) : "sekarang"}` : "",
    "Periode: -",
  );

  // Logo: file baru > src preview; tanpa file > src preview saat ini (dari edit)
  const lp = document.getElementById("idn-preview-logo-pemda");
  const ls = document.getElementById("idn-preview-logo-sekolah");
  const validSrc = (img) =>
    img && img.src && img.src !== "#" && img.style.display !== "none" ? img.src : "";
  setIdnImgPreview("idn-kop-logo-pemda", validSrc(lp));
  setIdnImgPreview("idn-kop-logo-sekolah", validSrc(ls));
}

// --- LOGIKA NOTIFIKASI TOAST --

// --- LOGIKA UPDATE ---
function initUpdateListeners() {
  const statusContainer = document.getElementById("update-status-container");
  const msgElement = document.getElementById("update-message");
  const progressBar = document.getElementById("download-bar");
  const progressBox = document.getElementById("download-progress-box");
  const restartBtn = document.getElementById("btn-restart");
  const navUpdateBtn = document.getElementById("nav-update-btn");
  const changelogContainer = document.getElementById("changelog-container");

  if (!window.electronAPI) return;

  // --- Fungsi render changelog dinamis (DIPERBAIKI) ---
  function renderChangelog(notes) {
    // 1. Ambil elemen dengan aman
    const changelogContainer = document.getElementById("changelog-container");
    if (!changelogContainer) return;

    changelogContainer.innerHTML = ""; // Bersihkan isi lama

    // Jika notes kosong/null, pakai default
    const defaultNote =
      "Mohon dukungannya untuk pengembangan Aplikasi SPJ BOSP dengan berdonasi melalui Bank BRI Nomor Rekening 6237 0103 6885 534 atas nama MUH. ROFIQ. Terima kasih telah menggunakan Aplikasi SPJ BOSP.";
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
    if (typeof notes === "string") {
      // Jika dari GitHub (biasanya HTML string), masukkan sebagai innerHTML
      // Ganti newline (\n) jadi <br> jika itu plain text, tapi biasanya GitHub kirim HTML
      content.innerHTML = notes;
    } else if (Array.isArray(notes)) {
      // Jika format Array (manual)
      notes.forEach((note) => {
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
      navUpdateBtn.classList.add("has-update");
      const dotAv = navUpdateBtn.querySelector(".update-dot");
      if (dotAv) dotAv.hidden = false;
    }

    showToast(
      "Pembaruan Tersedia!",
      `Versi ${info.version} tersedia.`,
      "Lihat Progress",
      () => switchTab("update"),
    );

    statusContainer.style.display = "block";
    msgElement.innerText = `Pembaruan ditemukan. Sedang mengunduh versi ${info.version}...`;
    progressBox.style.display = "block";

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
    progressBar.style.width = percent + "%";
    progressBar.innerText = percent + "%";

    if (document.getElementById("tab-update").classList.contains("active")) {
      statusContainer.style.display = "block";
      progressBox.style.display = "block";
    }
  });

  // 3. UPDATE SELESAI DIDOWNLOAD
  window.electronAPI.onUpdateDownloaded(() => {
    navUpdateBtn.classList.remove("has-update");
    const dotDl = navUpdateBtn.querySelector(".update-dot");
    if (dotDl) dotDl.hidden = true;

    showToast(
      "Siap Instalasi",
      "Pembaruan selesai diunduh. Restart aplikasi?",
      "Restart Aplikasi Sekarang",
      () => restartAndInstall(),
    );

    msgElement.innerText =
      "Unduhan selesai! Restart aplikasi untuk menerapkan pembaruan.";
    progressBar.style.width = "100%";
    progressBar.innerText = "Selesai";
    progressBar.style.backgroundColor = "#28a745";
    restartBtn.style.display = "block";
  });

  // 4. ERROR
  window.electronAPI.onUpdateError((err) => {
    console.error(err);
    msgElement.innerText = "Terjadi kesalahan koneksi saat update.";
    msgElement.style.color = "red";
  });

  // 5. TIDAK ADA UPDATE
  window.electronAPI.onUpdateNotAvailable(() => {
    msgElement.innerText = "Aplikasi sudah versi terbaru";
    msgElement.style.color = "green";
    progressBox.style.display = "none";

    showToast("Tidak Ada Pembaruan", "Aplikasi Anda sudah versi terbaru.");

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
  return dataArray.filter((item) => {
    return keys.some((key) => {
      const val = item[key];
      return val && String(val).toLowerCase().includes(lowerKeyword);
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Bangun kerangka UI (sidebar + seluruh tab/form/table) LEBIH DULU agar
  // isi halaman langsung tampil, baru backend child_process disiapkan dan
  // data dimuat. (Sebelumnya `await ensureBackendReady()` mendahului
  // initApp(): saat backend lambat siap, halaman tampak kosong.)
  initApp();
  await ensureBackendReady();
  try {
    await loadFiscalContexts();
  } catch (error) {
    showToast("Error!", error.message || "Gagal memuat pilihan tahun anggaran.");
  }
  loadPengaturan();
  loadMasterKegiatan();
  loadMasterRekeningBelanja();
  loadKwitansiList();
  loadDataBKU();

  // Tab awal adalah "identitas": siapkan tanggal uji + muat daftar periode.
  const tglUji = document.getElementById("idn-tgl-uji");
  if (tglUji && !tglUji.value) {
    tglUji.value = new Date().toISOString().slice(0, 10);
  }
  // Uratan baru (bug toast "Error loading data: Cannot set properties of
  // null"): resetIdentitasForm() kini memakai _dataPemdaLegacy sebagai
  // isian awal fallback, sehingga data kop/lama dari /get-pemda HARUS
  // sudah selesai dimuat sebelum form di-reset — kalau tidak, prefill
  // selalu kosong saat aplikasi pertama dibuka.
  await loadDataPemda();
  updatePemdaPreview();
  resetIdentitasForm({ show: false });
  loadIdentitasPeriode();

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
    case "master": // Referensi Kegiatan
      const filteredKegiatan = filterData(masterKegiatan, keyword, [
        "kode_kegiatan",
        "nama_kegiatan",
      ]);
      renderMasterKegiatan(filteredKegiatan);
      break;

    case "rekening": // Rekening Belanja
      const filteredRekening = filterData(masterRekeningBelanja, keyword, [
        "kode_rekening_belanja",
        "nama_rekening_belanja",
        "rekap_rekening_belanja",
        "nilai_kapitalisasi_belanja",
      ]);
      renderMasterRekeningBelanja(filteredRekening);
      break;

    case "data-bku": // Data BKU
      if (bkuData && bkuData.transaksi) {
        const filteredBKU = filterData(bkuData.transaksi, keyword, [
          "tanggal",
          "kode_rekening",
          "nama_toko",
          "alamat_toko",
          "no_telp_toko",
          "npwp_toko",
          "no_nota",
          "satuan",
          "volume",
          "uraian",
          "no_bukti",
          "kode_kegiatan",
          "harga_satuan",
          "pengeluaran",
        ]);
        renderBKUResult(filteredBKU);
      }
      break;

    case "kwitansi": // Daftar SPJ
      if (bkuData && bkuData.kwitansi_list) {
        const filteredKwitansi = filterData(bkuData.kwitansi_list, keyword, [
          "no_bukti",
          "nomor_kwitansi",
          "nama_toko",
          "nama_kegiatan",
          "tanggal",
          "npwp_toko",
          "alamat_toko",
          "thp",
          "tahun",
          "tanggal_nota",
          "jumlah",
        ]);
        if (typeof renderKwitansiList === "function")
          renderKwitansiList(filteredKwitansi);
      }
      break;
  }
}

// Lipat/buka sidebar (dipanggil tombol di topbar); state diingat antar reload.
window.toggleSidebar = function () {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const collapsed = sb.classList.toggle("collapsed");
  try {
    localStorage.setItem("spj-sidebar-collapsed", collapsed ? "1" : "0");
  } catch (e) { }
};

function restoreSidebarState() {
  try {
    if (localStorage.getItem("spj-sidebar-collapsed") === "1") {
      const sb = document.getElementById("sidebar");
      if (sb) sb.classList.add("collapsed");
    }
  } catch (e) { }
}

// Initialize app
function initApp() {
  const root = document.getElementById("app");
  let appVersion = "-";
  window.electronAPI.getAppVersion().then((v) => {
    ["current-version", "update-version-box"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerText = v;
    });
  });
  const NAV = [
    { tab: "identitas", label: "Identitas Satuan Pendidikan", icon: "school" },
    { section: "Transaksi" },
    { tab: "master", label: "Referensi Kegiatan", icon: "book" },
    { tab: "rekening", label: "Rekening Belanja", icon: "briefcase" },
    { tab: "bku", label: "Upload BKU", icon: "fileText" },
    { tab: "data-bku", label: "Data BKU", icon: "barChart" },
    { tab: "kwitansi", label: "Daftar SPJ", icon: "receipt" },
    { tab: "rekap", label: "Rekap Belanja", icon: "trendingUp" },
    { section: "Sistem" },
    { tab: "dukung", label: "Dukung Kami", icon: "heart" },
    {
      tab: "update",
      label: "Pembaruan Aplikasi",
      icon: "refreshCw",
      id: "nav-update-btn",
    },
  ];
  const navHtml = NAV.map((n) =>
    n.section
      ? `<div class="sidebar-section">${n.section}</div>`
      : `<button class="tab-btn" data-tab="${n.tab}" aria-label="${n.label}" title="${n.label}"${n.id ? ` id="${n.id}"` : ""} onclick="switchTab('${n.tab}')"><span class="tab-icon">${iconSvg(n.icon, 17)}</span><span class="tab-label">${n.label}</span><span class="update-dot" hidden></span></button>`,
  ).join("");

  // #app adalah satu-satunya elemen di <body>; dialah yang menjadi baris
  // flex (sidebar + area utama). body TIDAK boleh display:flex, karena
  // saat innerHTML masih kosong body punya tinggi 0 sehingga seluruh isi
  // "tertindih"/tidak terlihat.
  root.classList.add("app-layout");
  // Bersihkan sisa markup lama sebelum membangun ulang (hindari dua sidebar)
  while (root.firstChild) root.removeChild(root.firstChild);
  root.innerHTML = `
        <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
        <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#4f8df9"/><stop offset="1" stop-color="#2563eb"/>
        </linearGradient></defs></svg>
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-brand">
                <span class="brand-badge">${iconSvg("clipboard", 20)}</span>
                <div class="brand-text">
                    <div class="brand-title">SPJ BOSP</div>
                    <div class="brand-sub">Aplikasi SPJ dari ARKAS</div>
                </div>
            </div>
            <nav class="sidebar-nav">${navHtml}</nav>
            <div class="sidebar-footer">
                <span class="version-pill">${iconSvg("package", 14)} v<span id="current-version">-</span></span>
            </div>
        </aside>
        <div class="main-area">
        <header class="topbar">
            <button class="btn btn-secondary btn-sm sidebar-toggle" onclick="toggleSidebar()" title="Sembunyikan/tampilkan menu">${iconSvg("panelLeft", 16)}</button>
            <h1 class="page-title" id="pageTitle">Identitas Satuan Pendidikan</h1>
            <div class="search-container">
                <span class="search-wrap"><span class="search-icon">${iconSvg("search", 15)}</span>
                <input type="text" id="globalSearchInput" class="form-control" placeholder="Cari data di menu ini..."></span>
            </div>
        </header>
        <div class="app-shell selectable">
        <div id="message"></div>
<div id="tab-update" class="tab-content">
            <div class="card" style="max-width: 600px; margin: 0 auto; text-align: center;">
                <h3>${iconSvg("refreshCw", 17)} Pembaruan Aplikasi</h3>
                <div style="margin-bottom: 20px;">
                    <p style="color: #64748b;">Versi Aplikasi Saat Ini:</p>
                    <h2 style="margin-top: -10px; color: var(--primary);" id="update-version-box">-</h2>
                </div>
                
                <div id="update-actions">
                    <button class="btn btn-primary" id="btn-check-update" onclick="checkForUpdates()">
                        ${iconSvg("search", 15)} Cek Pembaruan
                    </button>
                </div>

                <div id="update-status-container" style="margin-top: 25px; display:none;">
                    <p id="update-message" style="font-weight: 600; color: var(--text-dark);">Mencari pembaruan...</p>
                    
                    <div id="download-progress-box" class="progress-container">
                        <div id="download-bar" class="progress-bar">0%</div>
                    </div>
                    
                    <div id="update-details" class="update-status-text"></div>
                    
                    <button id="btn-restart" class="btn btn-success" style="display:none; margin-top:15px; width:100%;" onclick="restartAndInstall()">
                        ${iconSvg("rocket", 15)} Mulai Ulang &amp; Terapkan Update
                    </button>
                </div>
            </div>
            
            <div id="changelog-container"></div>
        </div><!-- /#tab-update -->

<div id="tab-dukung" class="tab-content">
    <section class="support-card">
        <div class="support-copy">
            <span class="support-icon">${iconSvg("heart", 22)}</span>
            <h2>Dukung Pengembangan Aplikasi</h2>
            <p>
                Jika aplikasi ini membantu pekerjaan Anda, dukungan melalui Saweria
                akan membantu biaya pengembangan dan pemeliharaan aplikasi.
            </p>
            <p class="support-thanks">Terima kasih atas dukungan Anda!</p>
        </div>
        <div class="saweria-widget-frame">
            <img
                src="../assets/saweria-qr.png"
                alt="QR Saweria untuk mendukung pengembangan aplikasi"
                width="300"
                height="300"
            >
        </div>
        <a
            class="btn btn-primary support-saweria-link"
            href="https://saweria.co/widgets/qr?streamKey=9fa01af30cb97401653a0d92eb5935f7"
            target="_blank"
            rel="noopener noreferrer"
        >Buka QR Saweria</a>
    </section>
</div><!-- /#tab-dukung -->

<div id="tab-data-bku" class="tab-content">
    <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap:wrap; gap:12px; margin-bottom: 15px;">
            <h3>${iconSvg("barChart", 17)} Data BKU</h3>
                <div class="bku-toolbar">
                    <select id="bku-scope-filter" class="form-control" onchange="loadDataBKU()">
                        <option value="all">Semua tahun / sumber dana / anggaran</option>
                    </select>
                    <button class="btn btn-primary" onclick="loadDataBKU()">${iconSvg("refreshCw", 15)} Segarkan Data</button>
                    <button class="btn btn-success" onclick="syncArkas()" title="Impor transaksi BPU dari database ARKAS">Sinkron ARKAS</button>
                    <button class="btn btn-outline-primary" onclick="changeArkasDatabase()" title="Pilih atau ubah lokasi database ARKAS">Ubah Database</button>
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
                                <th>Kode Rekening</th>
                                <th>Nama Barang/Jasa</th>
                                <th>Toko/Penerima</th>
                                <th>Volume</th>
                                <th>Satuan</th>
                                <th>Harga Satuan</th>
                                <th>Harga</th>
                                <th style="width:120px; text-align:center">Aksi</th>
                                <th>Keterangan</th>
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
                            <span style="font-weight: bold; color: #2563eb; display: block; font-size: 15px;">${iconSvg("paperclip", 15)} Pilih File BKU (PDF)</span>
                            <span style="font-size: 11px; color: #6b7280; margin-top: 4px; display:block;">Maksimal 12 file</span>
                        </div>
                        <input type="file" id="bkuFile" accept=".pdf" multiple onchange="updateFileList()" style="display:none;">
                        <div id="selected-files" class="file-list" style="margin-top: 10px; flex-grow: 1;"></div>
                        
                        <div style="display:flex; gap:10px; margin-top:15px;">
                            <button class="btn btn-success" style="flex:2; padding: 10px; border-radius: 8px; font-weight: 600; background-color: #10b981; border: none; color: white; font-size: 13px;" onclick="uploadBKU()">${iconSvg("search", 14)} Ekstrak Data</button>
                            <button class="btn btn-secondary" style="flex:1; padding: 10px; border-radius: 8px; background-color: #6b7280; border: none; color: white; font-size: 13px;" onclick="resetBkuSelection()">Reset</button>
                        </div>
                    </div>
                </div>
                <div style="flex:1; min-width:300px; display: flex; flex-direction: column;">
                    <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #444; font-size: 14px;">Dokumen Pendukung</label>
                    <div style="border: 1px solid #edf2f7; padding: 16px; border-radius: 12px; background:#fdfdfd; flex: 1; display: flex; flex-direction: column; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02);">                        
                        <div class="custom-upload-btn" onclick="document.getElementById('bhpFile').click()" 
                             style="width: 100%; padding: 20px; border: 2px dashed #d1d5db; border-radius: 10px; background: #fafafa; cursor: pointer; text-align: center; transition: all 0.3s ease;">
                            <span style="font-weight: bold; color: #2563eb; display: block; font-size: 15px;">${iconSvg("paperclip", 15)} Pilih File BHP/BHM</span>
                            <span style="font-size: 11px; color: #6b7280; margin-top: 4px; display:block;">File PDF pendukung</span>
                        </div>
                            <input type="hidden" id="bhp-type"  value="BHP">
                        <input type="file" id="bhpFile" accept=".pdf" multiple style="display:none" onchange="updateBhpFileList()">
                        <div id="selected-bhp-files" class="file-list" style="margin-top:10px; flex-grow: 1;"></div>
                        
                        <div style="display:flex; gap:10px; margin-top:15px;">
                            <button class="btn btn-success" style="flex:2; font-size: 13px; padding: 10px; border-radius: 8px; background-color: #10b981; border: none; color: white; font-weight: 600;" onclick="extractBHP()">${iconSvg("search", 14)} Ekstrak Data</button>
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
                    <h3 style="margin:0">${iconSvg("receipt", 17)} Daftar Draft SPJ</h3>
                    <div id="kwitansi-stats"></div>
                </div>
                <div class="scope-filter-toolbar">
                    <label for="spj-scope-filter" style="font-size:12px;">Filter tahun / sumber dana / anggaran:</label>
                    <select id="spj-scope-filter" class="form-control" onchange="loadKwitansiList()" style="max-width:420px;">
                        <option value="all">Semua tahun / sumber dana / anggaran</option>
                    </select>
                    <label for="spj-thp-filter" style="font-size:12px;">Tahap:</label>
                    <select id="spj-thp-filter" class="form-control" onchange="loadKwitansiList()" style="max-width:180px;">
                        <option value="all">Semua tahap</option>
                        <option value="1">Tahap 1</option>
                        <option value="2">Tahap 2</option>
                    </select>
                    <label for="spj-month-filter" style="font-size:12px;">Bulan:</label>
                    <select id="spj-month-filter" class="form-control" onchange="loadKwitansiList()" style="max-width:180px;">
                        <option value="all">Semua bulan</option>
                        <option value="1">Januari</option>
                        <option value="2">Februari</option>
                        <option value="3">Maret</option>
                        <option value="4">April</option>
                        <option value="5">Mei</option>
                        <option value="6">Juni</option>
                        <option value="7">Juli</option>
                        <option value="8">Agustus</option>
                        <option value="9">September</option>
                        <option value="10">Oktober</option>
                        <option value="11">November</option>
                        <option value="12">Desember</option>
                    </select>
                </div>
                <div id="kwitansi-list" class="table-container"></div>
            </div>
        </div>

        <div id="tab-identitas" class="tab-content active">
            <div class="card" style="margin-bottom:20px;">
                <h3 style="margin-top:0">${iconSvg("school", 17)} Identitas Satuan Pendidikan</h3>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <label style="font-weight:600; font-size:13px;">Pratinjau tercetak untuk tanggal:</label>
                    <input type="date" id="idn-tgl-uji" class="form-control" style="max-width:180px;" onchange="loadIdentitasPeriode()">
                    <button class="btn btn-secondary btn-sm" onclick="document.getElementById('idn-tgl-uji').value=new Date().toISOString().slice(0,10); loadIdentitasPeriode();">${iconSvg("refreshCw", 14)} Hari ini</button>
                    <span id="idn-aktif-info" style="font-size:13px; color:#334155;"></span>
                </div>
            </div>

            <div class="card" style="margin-bottom:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h3 style="margin:0">${iconSvg("calendar", 17)} Daftar Periode Identitas (<span id="idn-count">0</span>)</h3>
                    <button class="btn btn-primary btn-sm" onclick="resetIdentitasForm()">${iconSvg("plus", 14)} Tambah Identitas</button>
                </div>
                <div id="idn-list" class="table-container"></div>
            </div>

            <div class="card" id="idn-form-card" hidden>
                <h3 style="margin-top:0" id="idn-form-title">${iconSvg("edit", 17)} Periode Identitas</h3>
                <form id="form-identitas" onsubmit="event.preventDefault(); saveIdentitasPeriode();">
                    <div class="grid-2" style="margin-bottom:8px;">
                        <div class="form-group">
                            <label>Nama Periode / Label <span style="color:#94a3b8;font-weight:400">(opsional, mis. "TA 2025", "Setelah renaming")</span></label>
                            <input type="text" id="idn-label" placeholder="Contoh: Periode Kepala Sekolah Baru">
                        </div>
                        <div class="form-group">
                            <label>Status</label>
                            <select id="idn-active" class="form-control">
                                <option value="1">Aktif (dipakai untuk dokumen)</option>
                                <option value="0">Nonaktif (disimpan sebagai arsip)</option>
                            </select>
                        </div>
                    </div>
                    <div class="grid-2" style="margin-bottom:8px;">
                        <div class="form-group">
                            <label>Tanggal Awal Berlaku <span style="color:#dc2626">*</span></label>
                            <input type="date" id="idn-tanggal-awal" required oninput="updateIdentitasPreview()">
                        </div>
                        <div class="form-group">
                            <label>Tanggal Akhir Berlaku <span style="color:#94a3b8;font-weight:400">(kosong = masih berlaku)</span></label>
                            <input type="date" id="idn-tanggal-akhir" oninput="updateIdentitasPreview()">
                        </div>
                    </div>

                    <h4 style="margin:16px 0 8px 0; font-size:14px; color:#1e293b; border-bottom:1px solid #e2e8f0; padding-bottom:4px;">${iconSvg("landmark", 15)} Kop &amp; Surat</h4>
                    <div class="form-group">
                        <label>Nama Pemerintah Daerah / Yayasan (Baris ke-1)</label>
                        <input type="text" id="idn-pemda" oninput="updateIdentitasPreview()" placeholder="Contoh: PEMERINTAH KABUPATEN XYZ">
                    </div>
                    <div class="form-group">
                        <label>Nama Satuan Pendidikan (Baris ke-2)</label>
                        <input type="text" id="idn-sekolah" oninput="updateIdentitasPreview()" placeholder="Contoh: SDN 1 SUKAMAJU">
                    </div>
                    <div class="form-group">
                        <label>Alamat Lengkap dan Kontak (Baris ke-3)</label>
                        <textarea id="idn-alamat" rows="2" oninput="updateIdentitasPreview()" placeholder="Alamat lengkap sekolah..."></textarea>
                    </div>
                    <div class="form-group">
                        <label>Tempat Terbit Surat</label>
                        <input type="text" id="idn-tempat" oninput="updateIdentitasPreview()" placeholder="Contoh: Jember">
                    </div>
                    <div class="grid-2" style="margin-top:12px;">
                        <div class="form-group">
                            <label>Logo Pemerintah Daerah / Yayasan (Logo Kiri)</label>
                            <input type="file" id="idn-logo-pemda" accept="image/*" onchange="previewImage(this, 'idn-preview-logo-pemda'); updateIdentitasPreview();">
                            <div class="logo-preview-box" onclick="openLogoFull('idn-preview-logo-pemda')" title="Klik untuk melihat gambar penuh">
                                <img id="idn-preview-logo-pemda" src="#" alt="Preview Logo Pemda" class="logo-preview-img" style="display:none;">
                                <span class="logo-preview-placeholder">${iconSvg("image", 22)}<br>Belum ada logo</span>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Logo Satuan Pendidikan (Logo Kanan)</label>
                            <input type="file" id="idn-logo-sekolah" accept="image/*" onchange="previewImage(this, 'idn-preview-logo-sekolah'); updateIdentitasPreview();">
                            <div class="logo-preview-box" onclick="openLogoFull('idn-preview-logo-sekolah')" title="Klik untuk melihat gambar penuh">
                                <img id="idn-preview-logo-sekolah" src="#" alt="Preview Logo Sekolah" class="logo-preview-img" style="display:none;">
                                <span class="logo-preview-placeholder">${iconSvg("image", 22)}<br>Belum ada logo</span>
                            </div>
                        </div>
                    </div>

                    <h4 style="margin:16px 0 8px 0; font-size:14px; color:#1e293b; border-bottom:1px solid #e2e8f0; padding-bottom:4px;">${iconSvg("user", 15)} Pejabat Penanda Tangan</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div class="form-group">
                            <label>Nama Kepala Satuan Pendidikan</label>
                            <input type="text" id="idn-kepala" oninput="updateIdentitasPreview()">
                        </div>
                        <div class="form-group">
                            <label>NIP Kepala Satuan Pendidikan</label>
                            <input type="text" id="idn-nip-kepala" oninput="updateIdentitasPreview()">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div class="form-group">
                            <label>Nama Bendahara</label>
                            <input type="text" id="idn-bendahara" oninput="updateIdentitasPreview()">
                        </div>
                        <div class="form-group">
                            <label>NIP Bendahara</label>
                            <input type="text" id="idn-nip-bendahara" oninput="updateIdentitasPreview()">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div class="form-group">
                            <label>Nama Pengurus Barang</label>
                            <input type="text" id="idn-pengurus" oninput="updateIdentitasPreview()">
                        </div>
                        <div class="form-group">
                            <label>NIP Pengurus Barang</label>
                            <input type="text" id="idn-nip-pengurus" oninput="updateIdentitasPreview()">
                        </div>
                    </div>

                    <h4 style="margin:16px 0 8px 0; font-size:14px; color:#1e293b; border-bottom:1px solid #e2e8f0; padding-bottom:4px;">${iconSvg("eye", 15)} Pratinjau Kop Surat</h4>
                    <div id="idn-kop-preview" style="border:1px solid #cbd5e1; border-radius:8px; padding:14px 16px; background:#fff; text-align:center; font-family:Arial,Helvetica,sans-serif;">
                        <div style="display:flex; align-items:center; gap:14px;">
                            <img id="idn-kop-logo-pemda" src="#" style="display:none; max-height:56px; max-width:64px; object-fit:contain;">
                            <div style="flex:1;">
                                <div id="idn-kop-1" style="font-size:13px; font-weight:700; letter-spacing:0.5px; text-transform:uppercase;">NAMA PEMERINTAH DAERAH</div>
                                <div id="idn-kop-2" style="font-size:17px; font-weight:800; text-transform:uppercase;">NAMA SATUAN PENDIDIKAN</div>
                                <div id="idn-kop-alamat" style="font-size:11px; color:#334155; white-space:pre-wrap;">Alamat akan tampil di sini</div>
                            </div>
                            <img id="idn-kop-logo-sekolah" src="#" style="display:none; max-height:56px; max-width:64px; object-fit:contain;">
                        </div>
                        <div style="border-bottom:3px double #0f172a; margin-top:10px;"></div>
                        <div style="text-align:right; font-size:11px; color:#475569; margin-top:6px;">
                            <span id="idn-kop-periode">Periode: -</span> &nbsp;|&nbsp; Tempat surat: <span id="idn-kop-tempat">-</span><br>
                            Mengetahui, Kepala Satuan Pendidikan: <strong id="idn-kop-kepala">-</strong>
                        </div>
                    </div>

                    <div style="display:flex; gap:10px; margin-top:16px;">
                        <button type="submit" class="btn btn-primary" style="flex:1; padding:12px 18px; font-weight:700;">${iconSvg("save", 15)} Simpan Identitas</button>
                        <button type="button" class="btn btn-secondary" style="padding:12px 18px;" onclick="resetIdentitasForm({show:false})">Batal</button>
                    </div>
                </form>
            </div>
        </div>

        <div id="tab-master" class="tab-content">
            <div class="card">
                <div class="scope-filter-toolbar">
                    <h3 style="margin-top:0">${iconSvg("book", 17)} Data Referensi Kegiatan</h3>
                    <label for="master-scope-filter" style="font-size:12px;">Filter tahun / sumber dana:</label>
                    <select id="master-scope-filter" class="form-control" onchange="loadMasterKegiatan()" style="max-width:320px;">
                        <option value="all">Semua tahun / sumber dana</option>
                    </select>
                    <button class="btn btn-success" onclick="syncMasterKegiatanArkas()" title="Tambah dan perbarui kode kegiatan dari database ARKAS">Sinkron dari ARKAS</button>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h4 style="margin:0">Daftar Referensi Kegiatan Tersimpan (<span id="master-count">0</span>)</h4>
                </div>
                <div id="master-list" class="table-container"></div>
            </div>
        </div>

<div id="tab-rekap" class="tab-content">
    <div class="card" style="margin-top:20px;">
        <h3 style="margin-top:0">${iconSvg("trendingUp", 17)} Rekap Belanja</h3>
        
        <div class="scope-filter-toolbar" style="margin-top:12px;">
            <label>
                <select id="rekap-scope-filter" class="form-control" style="max-width:320px;">
                    <option value="all">Semua tahun / sumber dana</option>
                </select>
            </label>
            <label style="display:flex; align-items:center; gap:8px;">
                <select id="rekap-thp-select" class="form-control" style="max-width:180px;">
                    <option value="all">Semua Tahap</option>
                    <option value="1">Tahap 1</option>
                    <option value="2">Tahap 2</option>
                </select>
            </label>
            <button class="btn btn-primary" onclick="generateRekapTransaksi(false)">${iconSvg("search", 15)} Generate Data</button>
            <button class="btn" onclick="generateRekapTransaksi(true)">${iconSvg("chevronDown", 15)} Detail</button>
        </div>

        <div style="margin-top:15px; padding:15px; border:1px dashed #ccc; background:#f9f9f9; border-radius:8px; display:flex; gap:10px; align-items:center;">
            <div style="flex:1;">
                <strong>Butuh file rekap dalam bentuk excel?</strong><br>
                <small style="color:#666;">Copas "Kode Template" di bawah ini pada file excel template rekap (.xlsx) lalu upload melalui tombol di samping. Sistem akan mengganti "Kode Template" di dalam excel dengan jumlah rekap belanja Anda!.</small>
            </div>
            <input type="file" id="template-file" accept=".xlsx" style="font-size:0.9em;">
            <button class="btn btn-success" onclick="processTemplateExcel()">${iconSvg("download", 15)} Download Rekap</button>
        </div>

        <div id="rekap-result" style="margin-top:20px;"></div>
    </div>
</div>

        <div id="tab-rekening" class="tab-content">
            <div class="card" style="margin-top:20px;">
                <h3 style="margin-top:0">${iconSvg("briefcase", 17)} Data Rekening Belanja</h3>
                <div style="background: #f0f9ff; border: 1px solid #e0f2fe; padding: 15px; border-radius: 12px; margin-bottom: 15px;">
                    <h4 style="margin:0 0 8px 0; font-size:14px;">${iconSvg("download", 15)} Import Rekening dari Excel</h4>
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
        </div><!-- /.app-shell -->
        </div><!-- /.main-area -->
    `;

  // Terapkan state lipatan sidebar & tab aktif sesuai state saat ini
  restoreSidebarState();
  switchTab(activeTab);

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
window.syncArkas = syncArkas;
window.changeArkasDatabase = changeArkasDatabase;
window.syncMasterKegiatanArkas = syncMasterKegiatanArkas;
window.saveTransaksi = saveTransaksi;
window.generateKwitansi = generateKwitansi;
window.downloadKwitansi = downloadKwitansi;
window.previewKwitansi = previewKwitansi;
window.setSpjPreviewZoom = setSpjPreviewZoom;
window.adjustSpjPreviewZoom = adjustSpjPreviewZoom;
window.fitSpjPreviewWidth = fitSpjPreviewWidth;
window.deleteMasterKegiatan = deleteMasterKegiatan;
window.deleteMasterKegiatanArkas = deleteMasterKegiatanArkas;
window.importMasterRekeningBelanja = importMasterRekeningBelanja;
window.openUpdateDetailPopup = openUpdateDetailPopup;
window.changeJenisBelanjaSpj = changeJenisBelanjaSpj;
window.addTandaTerimaRecipientRow = addTandaTerimaRecipientRow;
window.removeTandaTerimaRecipientRow = removeTandaTerimaRecipientRow;
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
window.openLogoFull = openLogoFull;
window.updatePemdaPreview = updatePemdaPreview;
window.saveDataPemda = saveDataPemda;
// Identitas Satuan Pendidikan per periode (menu terpadu kop+surat+pejabat)
window.loadIdentitasPeriode = loadIdentitasPeriode;
window.renderIdentitasPeriodeList = renderIdentitasPeriodeList;
window.resetIdentitasForm = resetIdentitasForm;
window.editIdentitasPeriode = editIdentitasPeriode;
window.duplicateIdentitasPeriode = duplicateIdentitasPeriode;
window.deleteIdentitasPeriode = deleteIdentitasPeriode;
window.saveIdentitasPeriode = saveIdentitasPeriode;
window.updateIdentitasPreview = updateIdentitasPreview;
window.openManualBKUForm = openManualBKUForm;
window.deleteMasterRekening = deleteMasterRekening;
window.loadDataPemda = loadDataPemda;
window.downloadKwitansi = downloadKwitansi;
window.downloadBAST = downloadBAST;
window.deleteMasterKegiatan = deleteMasterKegiatan;
window.deleteMasterKegiatanArkas = deleteMasterKegiatanArkas;
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
