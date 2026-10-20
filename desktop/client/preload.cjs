const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('deviceApp', Object.freeze({
  signIn: () => ipcRenderer.invoke('device:sign-in'),
  signOut: () => ipcRenderer.invoke('device:sign-out'),
  reconnect: () => ipcRenderer.invoke('device:reconnect'),
  permission: (name, on) => ipcRenderer.invoke('device:permission', name, on),
  stop: () => ipcRenderer.invoke('device:stop'),
  onState: callback => ipcRenderer.on('device:state', (_, state) => callback(state)),
  ready: () => ipcRenderer.invoke('device:ready'),
}));
