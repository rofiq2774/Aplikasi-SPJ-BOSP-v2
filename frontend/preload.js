const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  isDev: () => ipcRenderer.invoke("is-dev"),

  // BUGFIX: backend sekarang child_process dengan port dinamis — renderer
  // tidak boleh hardcode http://127.0.0.1:8000 lagi. Ambil base URL dari main process.
  getBackendUrl: () => ipcRenderer.invoke("get-backend-url"),
  readArkasTransactions: () => ipcRenderer.invoke("read-arkas-transactions"),
  getArkasDatabaseInfo: () => ipcRenderer.invoke("get-arkas-database-info"),
  selectArkasDatabase: () => ipcRenderer.invoke("select-arkas-database"),
  getArialPdfFonts: () => ipcRenderer.invoke("get-arial-pdf-fonts"),
  getAiImageSettings: () => ipcRenderer.invoke("get-ai-image-settings"),
  saveAiImageSettings: settings =>
    ipcRenderer.invoke("save-ai-image-settings", settings),
  clearAiImageSettings: () => ipcRenderer.invoke("clear-ai-image-settings"),
  generateAiImage: (kwitansiId, input) =>
    ipcRenderer.invoke("generate-ai-image", kwitansiId, input),

  // WAJIB: semua kejadian frontend dicatat ke app.log (ditulis main process,
  // satu file yang sama dengan log backend child_process).
  logApp: (level, message) =>
    ipcRenderer.invoke("renderer-log", { level: String(level || "info"), message: String(message || "") }),
  getLogPath: () => ipcRenderer.invoke("get-log-path"),

  checkForUpdates: () => ipcRenderer.send("check-for-updates"),
  restartApp: () => ipcRenderer.send("restart-app"),

  onUpdateAvailable: listener =>
    ipcRenderer.on("update-available", (_, info) => listener(info)),

  onUpdateNotAvailable: listener =>
    ipcRenderer.on("update-not-available", (_, info) => listener(info)),

  onDownloadProgress: listener =>
    ipcRenderer.on("download-progress", (_, progress) => listener(progress)),

  onUpdateDownloaded: listener =>
    ipcRenderer.on("update-downloaded", (_, info) => listener(info)),

  onUpdateError: listener =>
    ipcRenderer.on("update-error", (_, error) => listener(error)),
});
