const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, exec } = require("child_process");
const http = require("http");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

// ===================== SATU FILE LOG: app.log (WAJIB) =====================
// Semua kejadian frontend (main process Electron + renderer) dan backend
// (child_process FastAPI) tercatat pada satu file yang sama: app.log.
// Lokasi disamakan dengan backend (database.py):
//   - Windows packaged : %LOCALAPPDATA%\AplikasiSPJ\app.log
//   - development      : <repo>/backend/app.log
function resolveAppLogPath() {
  if (process.platform === "win32" && app.isPackaged && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "AplikasiSPJ", "app.log");
  }
  return path.join(__dirname, "..", "backend", "app.log");
}

let APP_LOG_PATH = null;
try {
  APP_LOG_PATH = resolveAppLogPath();
  fs.mkdirSync(path.dirname(APP_LOG_PATH), { recursive: true });
} catch (e) {
  // fallback ke electron-log default bila path utama tidak bisa dibuat
  APP_LOG_PATH = path.join(app.getPath("logs") || os.tmpdir(), "app.log");
  try { fs.mkdirSync(path.dirname(APP_LOG_PATH), { recursive: true }); } catch (e2) {}
}

log.transports.file.level = "info";
log.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB rotasi
log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
try { log.transports.file.resolvePathFn = () => APP_LOG_PATH; } catch (e) {}

function writeAppLog(level, source, message) {
  const line = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] [${source}] ${message}`;
  if (APP_LOG_PATH) {
    try { fs.appendFileSync(APP_LOG_PATH, line + os.EOL); } catch (e) {}
  }
  try {
    if (level === "error") log.error(`[${source}] ${message}`);
    else if (level === "warn") log.warn(`[${source}] ${message}`);
    else log.info(`[${source}] ${message}`);
  } catch (e) {}
  try { console[level === "warn" ? "warn" : level](line); } catch (e) {}
}

writeAppLog("info", "frontend-main", `=== Aplikasi SPJ BOSP v${app.getVersion()} dimulai (log: ${APP_LOG_PATH}) ===`);

// Capture unexpected errors in the main process to aid debugging
process.on("uncaughtException", (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  writeAppLog("error", "frontend-main", `Uncaught Exception: ${msg}`);
  // Ensure backend is stopped if main crashes
  try { stopBackend(); } catch(e) {}
});

process.on("unhandledRejection", (reason) => {
  writeAppLog("error", "frontend-main", `Unhandled Rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// Teruskan log dari renderer (frontend) supaya ikut tercatat di app.log
ipcMain.handle("renderer-log", (_evt, payload) => {
  try {
    const level = payload && payload.level ? payload.level : "info";
    const msg = payload && payload.message ? String(payload.message) : "";
    writeAppLog(level, "frontend-renderer", msg);
  } catch (e) {}
  return true;
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

let pyProcess = null;
let mainWindow = null;

// ===================== DYNAMIC PORT (child_process) =====================
// Backend FastAPI dijalankan lewat child_process dan TIDAK lagi dipatok di port
// 8000, supaya tidak bentrok dengan aplikasi lain / instance sebelumnya.
let backendPort = 0;

const net = require("net");

function getRandomPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function getBackendBaseUrl() {
  // backendPort = 0 berarti child_process belum siap -> kembalikan string kosong
  // agar renderer (ensureBackendReady) melakukan retry, BUKAN mengembalikan URL port 0.
  if (!backendPort) return "";
  return `http://127.0.0.1:${backendPort}`;
}
// =========================================================================

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
/* ===================== STOP BACKEND ===================== */
function stopBackend() {
  if (pyProcess) {
    const pid = pyProcess.pid;
    try {
      if (process.platform === "win32") {
        // /t ikut mematikan anak-anak proses (mis. worker uvicorn)
        exec(`taskkill /pid ${pid} /f /t`, () => {});
      } else {
        pyProcess.kill("SIGTERM");
      }
      writeAppLog("info", "frontend-main", `Backend child_process dihentikan (pid=${pid})`);
    } catch (e) {
      writeAppLog("error", "frontend-main", `Gagal menghentikan backend (pid=${pid}): ${e.message || e}`);
    }
    pyProcess = null;
  }
}

process.on("SIGINT", stopBackend);
process.on("SIGTERM", stopBackend);
process.on("exit", stopBackend);
/* ======================================================= */


/* ===================== WAIT BACKEND ===================== */
function waitForBackend(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });

      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });

      function retry() {
        if (Date.now() - start > timeout) {
          reject(new Error("Backend tidak siap"));
        } else {
          setTimeout(check, 500);
        }
      }
    };

    check();
  });
}

/* ======================================================= */


/* ===================== START BACKEND ===================== */
// Backend HANYA dijalankan sebagai child_process dengan port dinamis.
// Tidak ada lagi "servis localhost" statis (port 8000) — jika port dinamis
// gagal diperoleh, proses dihentikan dengan pesan error yang jelas di app.log.
async function spawnBackendOnPort(port) {
  const isDev = !app.isPackaged;

  const pyPath = isDev
    ? path.join(__dirname, "..", "backend", "main.py")
    : path.join(process.resourcesPath, "backend", "main.exe");

  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  backendPort = port;

  const env = {
    ...process.env,
    PYTHON_ENV: isDev ? "development" : "production",
    PORT: String(backendPort),
    // Satu file log bersama frontend & renderer — WAJIB mencatat semua kejadian
    SPJ_LOG_FILE: APP_LOG_PATH
  };

  writeAppLog(
    "info",
    "frontend-main",
    `Spawn backend child_process (${isDev ? "Development" : "Production"}): ${isDev ? pythonCmd + " " + pyPath : pyPath} pada port dinamis ${backendPort}`
  );

  pyProcess = isDev
    ? spawn(pythonCmd, [pyPath], { env, stdio: "pipe", detached: false })
    : spawn(pyPath, [], { env, stdio: "pipe", detached: false });

  pyProcess.on("error", (err) => {
    writeAppLog("error", "frontend-main", `Gagal menjalankan backend: ${err.message || err}`);
  });

  // Pantau proses anak agar kita tahu kalau backend mati mendadak
  // (mis. Python tidak terinstall / crash saat startup).
  pyProcess.on("exit", (code, signal) => {
    writeAppLog(
      code === 0 || code === null ? "info" : "error",
      "frontend-main",
      `Backend child_process berhenti (code=${code}, signal=${signal})`
    );
  });

  // stdout/stderr pipe WAJIB dikonsumsi di dev maupun production supaya pipe
  // tidak penuh dan proses Python tidak terblokir. Karena backend sudah
  // mencatat semuanya ke app.log (logging + tee stdout/stderr), di sini pipe
  // hanya diteruskan ke konsol untuk debugging — bukan sebagai sumber log.
  if (pyProcess.stdout) {
    pyProcess.stdout.on("data", (data) => console.log(`[backend] ${data.toString()}`));
  }
  if (pyProcess.stderr) {
    pyProcess.stderr.on("data", (data) => console.error(`[backend] ${data.toString()}`));
  }
}

async function startPythonBackend() {
  const MAX_PORT_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt++) {
    let port;
    try {
      port = await getRandomPort();
    } catch (e) {
      // TIDAK ada fallback ke port 8000 — servis localhost statis sudah ditiadakan.
      writeAppLog("error", "frontend-main", `Gagal mendapat port dinamis (percobaan ${attempt}): ${e.message || e}`);
      continue;
    }

    await spawnBackendOnPort(port);

    try {
      await waitForBackend(`${getBackendBaseUrl()}/health`, 20000);
      writeAppLog("info", "frontend-main", `Backend siap di http://127.0.0.1:${port}`);
      return;
    } catch (e) {
      writeAppLog(
        "error",
        "frontend-main",
        `Backend tidak siap pada port ${port} (percobaan ${attempt}/${MAX_PORT_ATTEMPTS}): ${e.message || e}. Detail penyebab ada di app.log (output child_process).`
      );
      stopBackend();
    }
  }

  throw new Error(
    "Backend child_process gagal berjalan pada port dinamis setelah beberapa percobaan. Periksa app.log."
  );
}
/* ======================================================= */


/* ===================== SET LOCALE ===================== */
app.commandLine.appendSwitch("lang", "id-ID");
/* ===================================================== */


async function createWindow() {
  const version = app.getVersion();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false, // ⬅️ penting: cegah tampil kecil dulu
    title: `Aplikasi SPJ BOSP v${version}`,
    icon: path.join(__dirname, "assets", "logo.png"),
    autoHideMenuBar: true,
    webPreferences: {
  preload: path.join(__dirname, "preload.js"),
  nodeIntegration: false,
  contextIsolation: true
}
  });
  mainWindow = win;
  win.on("page-title-updated", (e) => e.preventDefault());

  // Tampilkan setelah siap + maximize (BUKAN fullscreen)
win.once("ready-to-show", () => {
  win.maximize();
  win.show();

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates();
    }, 3000);
  }
});

  // BUGFIX: CSP injected ini menimpa CSP meta di Index.html. Karena backend kini
  // berjalan pada port dinamis (child_process), src 'self' saja akan memblokir
  // semua request http://127.0.0.1:<port>. Gunakan wildcard origin untuk host lokal.
  // Catatan: tidak ada lagi servis localhost statis — hanya child_process.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "img-src 'self' data: blob: http://127.0.0.1:* file:; " +
          "connect-src 'self' http://127.0.0.1:* https://api.github.com https://github.com https://objects.githubusercontent.com; " +
          "style-src 'self' 'unsafe-inline';"
        ]
      }
    });
  });

  // Backend sudah dipastikan siap oleh startPythonBackend() sebelum jendela dibuat.
  // Health check ulang di sini hanya sebagai penjaga (guard) terakhir.
  try {
    writeAppLog("info", "frontend-main", "Verifikasi akhir kesiapan backend child_process...");
    await waitForBackend(`${getBackendBaseUrl()}/health`, 5000);
    writeAppLog("info", "frontend-main", `Backend siap, memuat UI renderer`);
  } catch (e) {
    writeAppLog("error", "frontend-main", `Backend gagal start: ${e.message || e}`);
    const msg = String((e && e.message) || e).replace(/["'<>]/g, "");
    win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<html><body style="font-family:sans-serif;padding:40px;">` +
            `<h2>Backend gagal berjalan</h2><p>${msg}</p>` +
            `<p>Layanan REST hanya tersedia lewat child_process dengan port dinamis — servis localhost statis sudah dinonaktifkan.</p>` +
            `<p>Periksa app.log (${APP_LOG_PATH}) dan pastikan Python/backend terinstall dengan benar.</p>` +
            `</body></html>`
        )
    );
    return;
  }

  const isDev = !app.isPackaged;
  if (isDev) {
    // Vite dev server HANYA untuk pengembangan frontend (bukan servis backend).
    // Build produksi memakai loadFile (file://) tanpa server HTTP apa pun.
    writeAppLog("info", "frontend-main", "Mode dev: memuat renderer dari Vite (http://localhost:5173)");
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, "dist", "Index.html");
    writeAppLog("info", "frontend-main", `Production: memuat renderer dari file ${indexPath}`);
    win.loadFile(indexPath).catch((e) =>
      writeAppLog("error", "frontend-main", `Gagal memuat index.html: ${e.message || e}`)
    );
  }

  // Tangkap error runtime & console dari renderer agar ikut tercatat ke app.log
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // level: 0=log/debug, 1=info, 2=warning, 3=error
    const lvl = level >= 3 ? "error" : level === 2 ? "warn" : "info";
    writeAppLog(lvl, "frontend-renderer", `${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
    writeAppLog("error", "frontend-main", `Gagal memuat halaman ${validatedURL}: ${errorCode} ${errorDescription}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    writeAppLog("error", "frontend-main", `Renderer process gone: ${JSON.stringify(details)}`);
  });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    writeAppLog("error", "frontend-main", `Preload error (${preloadPath}): ${error.message || error}`);
  });
}

/* ===================== UPDATER EVENTS (IPC) ===================== */
// Bagian ini menghubungkan logika Frontend (UI) dengan Backend Electron

// 1. Menerima perintah "Cek Update" dari tombol di UI
ipcMain.on('check-for-updates', () => {
  if (!app.isPackaged) {
    if (mainWindow) {
      mainWindow.webContents.send(
        'update-error',
        'Update hanya bisa dicek di aplikasi hasil install (.exe)'
      );
    }
    return;
  }

  autoUpdater.checkForUpdates();
});


// 2. Menerima perintah "Restart" dari tombol di UI
ipcMain.on('restart-app', () => {
    autoUpdater.quitAndInstall();
});

// 3. Mengirim status ke UI saat update tersedia
autoUpdater.on('update-available', (info) => {
    if(mainWindow) mainWindow.webContents.send('update-available', info);
});

// 4. Mengirim status ke UI saat TIDAK ada update
autoUpdater.on('update-not-available', (info) => {
    if(mainWindow) mainWindow.webContents.send('update-not-available', info);
});

// 5. MENGIRIM DATA PROGRESS DOWNLOAD (Persen & Kecepatan)
autoUpdater.on('download-progress', (progressObj) => {
    if(mainWindow) mainWindow.webContents.send('download-progress', progressObj);
});

// 6. Memberitahu UI bahwa download selesai
autoUpdater.on('update-downloaded', (info) => {
    if(mainWindow) mainWindow.webContents.send('update-downloaded', info);
});

// 7. Mengirim pesan Error ke UI
autoUpdater.on('error', (err) => {
    if(mainWindow) mainWindow.webContents.send('update-error', err.toString());
});

ipcMain.handle("is-dev", () => !app.isPackaged);

// BUGFIX: renderer tidak boleh lagi hardcode port 8000. Main process yang
// memiliki informasi child_process, jadi expose base URL backend via IPC.
ipcMain.handle("get-backend-url", () => getBackendBaseUrl());

// Lokasi app.log agar bisa ditampilkan/diakses dari UI bila perlu
ipcMain.handle("get-log-path", () => APP_LOG_PATH);

/* ================================================================ */

Menu.setApplicationMenu(null);

/* ===================== APP EVENTS ===================== */
app.whenReady().then(async () => {
  // Backend WAJIB siap sebagai child_process (port dinamis) sebelum jendela
  // dibuat. Tidak ada servis localhost statis untuk diandalkan.
  try {
    await startPythonBackend();
  } catch (e) {
    writeAppLog("error", "frontend-main", `Gagal memulai backend child_process: ${e.message || e}`);
  }
  createWindow();
});

app.on("before-quit", () => {
  writeAppLog("info", "frontend-main", "Aplikasi ditutup (before-quit)");
  stopBackend();
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", stopBackend);
/* ===================================================== */
