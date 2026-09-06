'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  loadData: 'clinic:data:load',
  saveData: 'clinic:data:save',
  exportBackup: 'clinic:backup:export',
  importBackup: 'clinic:backup:import',
  restoreBackup: 'clinic:backup:restore',
  restorePreviousBackup: 'clinic:backup:restore-previous',
  getStorageInfo: 'clinic:storage:info',
  openDataFolder: 'clinic:storage:open-folder',
  setDirty: 'clinic:window:set-dirty',
  closeReady: 'clinic:window:close-ready',
  closeRequest: 'clinic:window:close-request',
  respondClose: 'clinic:window:respond-close',
  getPrinters: 'clinic:printer:list',
  print: 'clinic:printer:print',
});

const clinicDesktop = Object.freeze({
  loadData: () => ipcRenderer.invoke(CHANNELS.loadData),
  saveData: (data) => ipcRenderer.invoke(CHANNELS.saveData, data),
  exportBackup: (data) => ipcRenderer.invoke(CHANNELS.exportBackup, data),
  importBackup: () => ipcRenderer.invoke(CHANNELS.importBackup),
  restoreBackup: (data) => ipcRenderer.invoke(CHANNELS.restoreBackup, data),
  restorePreviousBackup: () => ipcRenderer.invoke(CHANNELS.restorePreviousBackup),
  getStorageInfo: () => ipcRenderer.invoke(CHANNELS.getStorageInfo),
  openDataFolder: () => ipcRenderer.invoke(CHANNELS.openDataFolder),
  setDirty: (dirty) => ipcRenderer.invoke(CHANNELS.setDirty, dirty),
  onCloseRequest: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('关闭回调必须是函数。');
    const listener = (_event, details) => callback(details);
    ipcRenderer.on(CHANNELS.closeRequest, listener);
    ipcRenderer.invoke(CHANNELS.closeReady).catch(() => {});
    return () => ipcRenderer.removeListener(CHANNELS.closeRequest, listener);
  },
  respondClose: (response) => ipcRenderer.invoke(CHANNELS.respondClose, response),
  getPrinters: () => ipcRenderer.invoke(CHANNELS.getPrinters),
  print: (options) => ipcRenderer.invoke(CHANNELS.print, options),
});

contextBridge.exposeInMainWorld('clinicDesktop', clinicDesktop);
