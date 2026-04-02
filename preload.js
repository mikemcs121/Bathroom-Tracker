const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings:      ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:     (s)      => ipcRenderer.invoke('save-settings', s),
  importCSV:        ()       => ipcRenderer.invoke('import-csv'),
  getRawData:       (f)      => ipcRenderer.invoke('get-raw-data',       f || {}),
  getStudentTotals: (f)      => ipcRenderer.invoke('get-student-totals', f || {}),
  getPassDetail:    (f)      => ipcRenderer.invoke('get-pass-detail',    f || {}),
  clearData:        ()       => ipcRenderer.invoke('clear-data'),
  getStats:         ()       => ipcRenderer.invoke('get-stats'),
  getTeachers:      ()       => ipcRenderer.invoke('get-teachers'),
});
