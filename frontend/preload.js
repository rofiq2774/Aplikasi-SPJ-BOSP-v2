const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  isDev: () => ipcRenderer.invoke("is-dev"),

  // BUGFIX: backend sekarang child_process dengan port dinamis — renderer
  // tidak boleh hardcode http://127.0.0.1:8000 lagi. Ambil base URL dari main process.
  getBackendUrl: () => ipcRenderer.invoke("get-backend-url"),

  // WAJIB: semua kejadian frontend dicatat ke app.log (ditulis main process,
  // satu file yang sama dengan log backend child_process).
  logApp: (level, message) =>
    ipcRenderer.invoke("renderer-log", { level: String(level || "info"), message: String(message || "") }),
  getLogPath: () => ipcRenderer.invoke("get-log-path"),

  checkForUpdates: () => ipcRenderer.send("check-for-updates"),
  restartApp: () => ipcRenderer.send("restart-app"),

  onUpdateAvailable: cb =>
    ipcRenderer.on("update-available", (_, info) => cb(info)),

  onUpdateNotAvailable: cb =>
    ipcRenderer.on("update-not-available", (_, info) => cb(info)),

  onDownloadProgress: cb =>
    ipcRenderer.on("download-progress", (_, progress) => cb(progress)),

  onUpdateDownloaded: cb =>
    ipcRenderer.on("update-downloaded", (_, info) => cb(info)),

  onUpdateError: cb =>
    ipcRenderer.on("update-error", (_, error) => cb(error)),
});
