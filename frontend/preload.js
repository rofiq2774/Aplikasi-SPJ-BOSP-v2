const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  isDev: () => ipcRenderer.invoke("is-dev"),

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
