'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  loadData: 'clinic:data:load',
  saveData: 'clinic:data:save',
  exportBackup: 'clinic:backup:export',
  importBackup: 'clinic:backup:import',
  getPrinters: 'clinic:printer:list',
  print: 'clinic:printer:print',
});

const clinicDesktop = Object.freeze({
  loadData: () => ipcRenderer.invoke(CHANNELS.loadData),
  saveData: (data) => ipcRenderer.invoke(CHANNELS.saveData, data),
  exportBackup: (data) => ipcRenderer.invoke(CHANNELS.exportBackup, data),
  importBackup: () => ipcRenderer.invoke(CHANNELS.importBackup),
  getPrinters: () => ipcRenderer.invoke(CHANNELS.getPrinters),
  print: (options) => ipcRenderer.invoke(CHANNELS.print, options),
});

contextBridge.exposeInMainWorld('clinicDesktop', clinicDesktop);

