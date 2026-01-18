const { app, BrowserWindow, Menu, ipcMain} = require("electron");
const path = require("path");
const { spawn, exec } = require("child_process");
const http = require("http");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

// Capture unexpected errors in the main process to aid debugging
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception in main:", err && err.stack ? err.stack : err);
  try { log.error("Uncaught Exception in main:", err); } catch(e) {}
  // Ensure backend is stopped if main crashes
  try { stopBackend(); } catch(e) {}
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection in main:", reason);
  try { log.error("Unhandled Rejection in main:", reason); } catch(e) {}
});

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

let pyProcess = null;
let mainWindow = null;
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;
/* ===================== STOP BACKEND ===================== */
function stopBackend() {
  if (pyProcess && !pyProcess.killed) {
    try {
      if (process.platform === "win32") {
        exec(`taskkill /pid ${pyProcess.pid} /f /t`);
      } else {
        pyProcess.kill("SIGTERM");
      }
    } catch (e) {
      console.error("Gagal menghentikan backend:", e);
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
function startPythonBackend() {
  const isDev = !app.isPackaged;

  const pyPath = isDev
    ? path.join(__dirname, "..", "backend", "main.py")
    : path.join(process.resourcesPath, "backend", "main.exe");

  const pythonCmd = process.platform === "win32" ? "python" : "python3";

  const env = {
    ...process.env,
    PYTHON_ENV: isDev ? "development" : "production"
  };

  pyProcess = isDev
    ? spawn(pythonCmd, [pyPath], { env, stdio: "pipe", detached: false })
    : spawn(pyPath, [], { env, stdio: "pipe", detached: false });

  pyProcess.on("error", (err) => {
    console.error("Gagal menjalankan backend:", err);
  });

  console.log(
    `Backend berjalan (${isDev ? "Development" : "Production"})`
  );

  if (isDev) {
    pyProcess.stdout.on("data", (data) =>
      console.log(`Python Output: ${data.toString()}`)
    );
    pyProcess.stderr.on("data", (data) =>
      console.error(`Python Error: ${data.toString()}`)
    );
  }
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

  // CSP
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "img-src 'self' data: blob: http://127.0.0.1:8000 file:; " +
          "connect-src 'self' http://127.0.0.1:8000 https://api.github.com https://github.com https://objects.githubusercontent.com; " +
          "style-src 'self' 'unsafe-inline';"
        ]
      }
    });
  });

  // Tunggu backend
  try {
    console.log("Menunggu backend FastAPI...");
    await waitForBackend("http://127.0.0.1:8000/health");
    console.log("Backend siap");
  } catch (e) {
    console.error("Backend gagal start:", e);
  }

  const isDev = !app.isPackaged;
  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    const indexPath = path.join(__dirname, "dist", "Index.html");
    win.loadFile(indexPath).catch((e) =>
      console.error("Gagal memuat index.html:", e)
    );
    
  }
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

/* ================================================================ */

Menu.setApplicationMenu(null);

/* ===================== APP EVENTS ===================== */
app.whenReady().then(() => {
  startPythonBackend();
  createWindow();
});

app.on("before-quit", stopBackend);

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", stopBackend);
/* ===================================================== */
