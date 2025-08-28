let NGROK_PUBLIC_URL = '';
let BLE_PROFILES = []; 
let device = null;
let server = null;
let service = null;
let characteristic = null;
let isConnected = false;
let currentSpeed = 'W';
let activeButtons = new Set();
let commandQueue = [];
let isProcessingQueue = false;
let reconnectionAttempts = 0;
let lastSentCommand = null;
let lastSentAt = 0;

const RECONNECTION_ATTEMPTS = 3;
const RECONNECTION_DELAY = 2000;
const COMMAND_TIMEOUT = 5000;
const MAX_LOG_ENTRIES = 50;
const QUEUE_INTERVAL_MS = 10;
const RESEND_SAFETY_MS = 500;
const ERROR_MESSAGES = {
  CONNECTION: "Error de conexión: ",
  COMMAND: "Comando no reconocido: ",
  BLUETOOTH: "Bluetooth no disponible: ",
  DEVICE: "Dispositivo no encontrado: "
};

const vehicleState = { speed: 'W', direction: 'S', lastCommandTime: null, isMoving: false };

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      if (isConnected) await disconnectFromDevice();
      const response = await fetch('/logout', { method: 'GET', credentials: 'include' });
      if (response.ok) window.location.href = '/login.html';
      else {
        const errorData = await response.json();
        console.error('Error al cerrar sesión:', errorData.message);
        alert('Error al cerrar sesión: ' + errorData.message);
        window.location.href = '/login.html';
      }
    } catch {
      window.location.href = '/login.html';
    }
  });
}
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectionStatus = document.getElementById('connectionStatus');
const logElement = document.getElementById('log');

const btnUp = document.getElementById('btnUp');
const btnDown = document.getElementById('btnDown');
const btnLeft = document.getElementById('btnLeft');
const btnRight = document.getElementById('btnRight');

const btnSlow = document.getElementById('btnSlow');
const btnMedium = document.getElementById('btnMedium');
const btnFast = document.getElementById('btnFast');

const refreshBtn = document.getElementById('refreshBtn');
const settingsBtn = document.getElementById('settingsBtn');

function addLog(message, type = 'info') {
  const now = new Date();
  const timeString = now.toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${type}`;
  logEntry.innerHTML = `[${timeString}] ${message}`;
  logElement.appendChild(logEntry);
  logElement.scrollTop = logElement.scrollHeight;
  if (logElement.children.length > MAX_LOG_ENTRIES) {
    logElement.removeChild(logElement.children[0]);
  }
}

function updateConnectionStatus() {
  if (!connectionStatus) return;
  const textEl = connectionStatus.querySelector('.status-text');
  const iconEl = connectionStatus.querySelector('.status-icon');
  const detailEl = connectionStatus.querySelector('.status-detail');

  if (isConnected) {
    if (textEl) textEl.textContent = 'Conectado';
    connectionStatus.className = 'status connected';
    if (iconEl) iconEl.innerHTML = '<i class="fas fa-link"></i>';
    if (detailEl) detailEl.textContent = device?.name || 'Dispositivo conectado';
    connectBtn.disabled = true; disconnectBtn.disabled = false;
  } else {
    if (textEl) textEl.textContent = 'Desconectado';
    connectionStatus.className = 'status disconnected';
    if (iconEl) iconEl.innerHTML = '<i class="fas fa-unlink"></i>';
    if (detailEl) detailEl.textContent = 'Buscando dispositivo Bluetooth...';
    connectBtn.disabled = false; disconnectBtn.disabled = true;
  }
}

function throttle(func, limit) {
  let lastFunc; let lastRan;
  return function() {
    const context = this; const args = arguments;
    if (!lastRan) { func.apply(context, args); lastRan = Date.now(); }
    else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(function() {
        if ((Date.now() - lastRan) >= limit) { func.apply(context, args); lastRan = Date.now(); }
      }, limit - (Date.now() - lastRan));
    }
  };
}
const throttledSendCommand = throttle(sendCommand, 100);

async function connectToDevice() {
  try {
    if (!navigator.bluetooth) throw new Error('API Bluetooth no soportada en este navegador');

    if (!BLE_PROFILES.length) {
      addLog('⚠️ No hay perfiles BLE en /config. El navegador no permitirá acceder a tu servicio personalizado.', 'warning');
      addLog('Pide al admin que configure BLE_PROFILES en el servidor (.env).', 'warning');
    } else {
      addLog(`Perfiles BLE cargados: ${BLE_PROFILES.length}`, 'debug');
      console.table && console.table(BLE_PROFILES);
    }

    addLog('Abriendo selector Bluetooth (verás TODOS los dispositivos)...');

    const optionalServices = [
      ...new Set([
        ...BLE_PROFILES.map(p => p.service).filter(Boolean),
        '00001800-0000-1000-8000-00805f9b34fb',
        '00001801-0000-1000-8000-00805f9b34fb'
      ])
    ];

    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices
    }).catch(err => {
      if (err.name === 'NotFoundError') throw new Error('Selección de dispositivo cancelada');
      throw err;
    });

    device.addEventListener('gattserverdisconnected', onDisconnected);

    addLog(`Conectando a: ${device.name || device.id} ...`);
    server = await device.gatt.connect();
    if (!server) throw new Error('No se pudo establecer la conexión GATT');

    let ok = false;
    for (const prof of BLE_PROFILES) {
      try {
        if (!prof?.service || !prof?.characteristic) continue;
        addLog(`Probando servicio: ${prof.service}`);
        const svc = await server.getPrimaryService(prof.service);
        const ch = await svc.getCharacteristic(prof.characteristic);
        await finalizeGattSelection(svc, ch);
        ok = true; break;
      } catch (_) { /* probar siguiente */ }
    }

    if (!ok) {
      addLog('Intentando descubrimiento automático de características escribibles...', 'debug');
      ok = await autoDiscoverWriteCharacteristic(server);
    }

    if (!ok) {
      throw new Error('No se encontró característica escribible. Revisa BLE_PROFILES en el backend y el servicio del ESP32.');
    }

  } catch (error) {
    addLog(`${ERROR_MESSAGES.CONNECTION}${error.message}`, 'error');
    isConnected = false; updateConnectionStatus();
    try { if (device?.gatt?.connected) device.gatt.disconnect(); } catch(_) {}
    device = null; server = null; service = null; characteristic = null;
  }
}

async function autoDiscoverWriteCharacteristic(gattServer) {
  try {
    const services = await gattServer.getPrimaryServices();
    addLog(`Servicios accesibles: ${services.length}`, 'debug');
    for (const svc of services) {
      try {
        const chars = await svc.getCharacteristics();
        for (const ch of chars) {
          const p = ch.properties || {};
          if (p.write || p.writeWithoutResponse) {
            addLog(`Característica escribible encontrada:\nServicio: ${svc.uuid}\nCaracterística: ${ch.uuid}`, 'success');
            await finalizeGattSelection(svc, ch);
            return true;
          }
        }
      } catch(_) {}
    }
    return false;
  } catch(_) {
    return false;
  }
}

async function finalizeGattSelection(svc, ch) {
  service = svc; characteristic = ch;
  isConnected = true; reconnectionAttempts = 0;
  updateConnectionStatus();
  addLog('¡Conectado! Configurando velocidad media...', 'success');
  sendCommand(currentSpeed);
  savePreferences();
  setInterval(() => {
    if (!isConnected || !characteristic) return;
    const now = Date.now();
    if (lastSentCommand && now - lastSentAt >= RESEND_SAFETY_MS) {
      enqueueCommand(lastSentCommand, /*force=*/true);
    }
  }, RESEND_SAFETY_MS);
}

function disconnectFromDevice() {
  if (!device || !isConnected) return;
  addLog('Desconectando...');
  if (device.gatt.connected) device.gatt.disconnect();
  isConnected = false; updateConnectionStatus();
  addLog('Desconectado'); activeButtons.clear();
}

function onDisconnected() {
  addLog('¡Dispositivo desconectado!', 'warning');
  isConnected = false; updateConnectionStatus(); activeButtons.clear();
  if (reconnectionAttempts < RECONNECTION_ATTEMPTS) {
    reconnectionAttempts++;
    addLog(`Intentando reconectar (${reconnectionAttempts}/${RECONNECTION_ATTEMPTS})...`);
    setTimeout(connectToDevice, RECONNECTION_DELAY);
  } else reconnectionAttempts = 0;
}

function enqueueCommand(command, force = false) {
  if (commandQueue.length > 0) {
    const last = commandQueue[commandQueue.length - 1];
    if (last === command && !force) return; 
    commandQueue.length = 0; 
  }
  commandQueue.push(command);
  processCommandQueue();
}

async function sendCommand(command) {
  const valid = ['F', 'B', 'L', 'R', 'S', 'V', 'W', 'X'];
  if (!valid.includes(command)) { addLog(`${ERROR_MESSAGES.COMMAND}${command}`, 'error'); return; }
  if (!isConnected || !characteristic) { addLog('No hay característica escribible seleccionada. Conecta primero.', 'error'); return; }

  if (['V', 'W', 'X'].includes(command)) vehicleState.speed = command;
  else if (command !== 'S') { vehicleState.direction = command; vehicleState.isMoving = true; }
  else vehicleState.isMoving = false;
  vehicleState.lastCommandTime = new Date();

  if (command === 'S') {
    commandQueue.length = 0;
    commandQueue.push('S');
    return processCommandQueue(true);
  }
  enqueueCommand(command);
}

async function processCommandQueue(forceImmediate = false) {
  if (isProcessingQueue || commandQueue.length === 0 || !isConnected || !characteristic) return;
  isProcessingQueue = true;
  const command = commandQueue.shift();

  try {
    const buffer = new TextEncoder().encode(command);
    if (typeof characteristic.writeValueWithoutResponse === 'function') {
      await characteristic.writeValueWithoutResponse(buffer);
    } else if (typeof characteristic.writeValue === 'function') {
      await characteristic.writeValue(buffer);
    } else if (typeof characteristic.writeValueWithResponse === 'function') {
      await characteristic.writeValueWithResponse(buffer);
    } else {
      throw new Error('La característica no soporta escritura en este navegador.');
    }
    lastSentCommand = command;
    lastSentAt = Date.now();
    addLog(`Enviado: ${command}`);
  } catch (err) {
    addLog(`Error enviando comando: ${command} - ${err}`, 'error');
    commandQueue.length = 0;
    commandQueue.push(command);
  } finally {
    isProcessingQueue = false;
    if (commandQueue.length > 0) {
      setTimeout(processCommandQueue, forceImmediate ? 0 : QUEUE_INTERVAL_MS);
    }
  }
}

function handleMovementStart(command) {
  if (!isConnected) return;
  activeButtons.add(command);
  throttledSendCommand(command);
  const timeoutId = setTimeout(() => {
    if (activeButtons.has(command)) {
      addLog(`Timeout: Comando ${command} no confirmado`, 'warning');
      handleMovementEnd(command);
    }
  }, COMMAND_TIMEOUT);
  activeButtons.timeout = timeoutId;
}
function handleMovementEnd(command) {
  if (!isConnected) return;
  if (activeButtons.timeout) clearTimeout(activeButtons.timeout);
  activeButtons.delete(command);
  if (activeButtons.size === 0) sendCommand('S');
}

function checkVehicleStatus() {
  if (!vehicleState.isMoving) return;
  const now = new Date();
  const t = now - vehicleState.lastCommandTime;
  if (t > 10000) addLog('Advertencia: El vehículo lleva mucho tiempo en movimiento sin actualización', 'warning');
}

function savePreferences() {
  const preferences = {
    speed: currentSpeed,
    lastConnectedDevice: device ? device.id : null,
    lastDeviceName: device ? device.name : null
  };
  localStorage.setItem('carControlPrefs', JSON.stringify(preferences));
}
function loadPreferences() {
  const prefs = JSON.parse(localStorage.getItem('carControlPrefs'));
  if (prefs) {
    currentSpeed = prefs.speed || 'W';
    updateSpeedButtons(document.querySelector(`.speed-btn[data-speed="${currentSpeed}"]`) || btnMedium);
    if (prefs.lastDeviceName) addLog(`Último dispositivo usado: ${prefs.lastDeviceName}`, 'debug');
  }
}
function updateSpeedButtons(activeButton) {
  document.querySelectorAll('.speed-btn').forEach(btn => btn.classList.remove('active'));
  if (activeButton) activeButton.classList.add('active');
}

function setupControls() {
  connectBtn.addEventListener('click', connectToDevice);
  disconnectBtn.addEventListener('click', disconnectFromDevice);

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      addLog('Refrescando lista: pulsa "Conectar" para abrir el selector de dispositivos.', 'info');
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/ble/validate');
        const v = await res.json();
        if (v.ok) {
          addLog('BLE_PROFILES válidos en backend ✅', 'success');
        } else {
          addLog('BLE_PROFILES con problemas ❌', 'error');
          (v.reasons || []).forEach(r => addLog(`- ${r}`, 'error'));
        }
        addLog(`Perfiles cargados: ${BLE_PROFILES.length}`, 'debug');
      } catch {
        addLog('No se pudo validar BLE_PROFILES en backend.', 'error');
      }
    });
  }

  const setupMovementControl = (el, cmd) => {
    el.addEventListener('mousedown', () => handleMovementStart(cmd));
    el.addEventListener('mouseup', () => handleMovementEnd(cmd));
    el.addEventListener('mouseleave', () => handleMovementEnd(cmd));
    el.addEventListener('touchstart', e => { e.preventDefault(); handleMovementStart(cmd); });
    el.addEventListener('touchend',   e => { e.preventDefault(); handleMovementEnd(cmd); });
  };
  setupMovementControl(btnUp, 'F');
  setupMovementControl(btnDown, 'B');
  setupMovementControl(btnLeft, 'L');
  setupMovementControl(btnRight, 'R');

  btnSlow.addEventListener('click', (e) => { currentSpeed = 'V'; sendCommand('V'); updateSpeedButtons(e.target); savePreferences(); });
  btnMedium.addEventListener('click', (e) => { currentSpeed = 'W'; sendCommand('W'); updateSpeedButtons(e.target); savePreferences(); });
  btnFast.addEventListener('click',  (e) => { currentSpeed = 'X'; sendCommand('X'); updateSpeedButtons(e.target); savePreferences(); });
}

function setupAutoMode() {
  const autoModeBtn = document.getElementById('autoModeBtn');
  let autoSocket = null; let pingInterval = null; let lastCommandRecv = null;

  autoModeBtn.addEventListener('click', () => {
    const isActive = autoModeBtn.classList.toggle('active');

    if (isActive) {
      addLog('Modo automático ACTIVADO', 'success');
      activeButtons.clear(); sendCommand('S');

      if (autoSocket) autoSocket.close();
      autoSocket = new WebSocket(`wss://${NGROK_PUBLIC_URL}/auto-control`);
      autoSocket.binaryType = 'arraybuffer';

      autoSocket.onopen = () => {
        addLog('Conexión IA establecida', 'success');
        pingInterval = setInterval(() => {
          if (autoSocket.readyState === WebSocket.OPEN) autoSocket.send('ping');
        }, 10000);
      };

      autoSocket.onmessage = (event) => {
        const command = (typeof event.data === 'string' ? event.data : '').trim();
        if (command === 'pong') { addLog('🔄 Keep-alive recibido de IA', 'debug'); return; }
        if (['F', 'B', 'L', 'R', 'S', 'V', 'W', 'X'].includes(command)) {
          if (command !== lastCommandRecv) { sendCommand(command); lastCommandRecv = command; addLog(`📡 Comando IA: ${command}`, 'info'); }
        } else if (command.length) {
          addLog(`❓ Comando IA desconocido: ${command}`, 'warning');
        }
      };

      autoSocket.onerror = (error) => {
        addLog(`Error IA: ${error.message}`, 'error');
        autoModeBtn.classList.remove('active'); cleanupAutoMode();
      };

      autoSocket.onclose = () => {
        if (autoModeBtn.classList.contains('active')) {
          addLog('Conexión IA cerrada', 'warning');
          autoModeBtn.classList.remove('active');
        }
        cleanupAutoMode(); sendCommand('S');
      };
    } else {
      addLog('Modo automático DESACTIVADO', 'warning');
      cleanupAutoMode(); sendCommand('S');
    }
  });

  function cleanupAutoMode() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (autoSocket)   { autoSocket.close(); autoSocket = null; }
    lastCommandRecv = null;
  }
}

function init() {
  loadPreferences();
  updateConnectionStatus();
  setupControls();
  setupAutoMode();
  setInterval(checkVehicleStatus, 5000);
  addLog('Sistema listo. Conecta el dispositivo para comenzar.');
}

fetch('/config')
  .then(res => res.json())
  .then(data => {
    NGROK_PUBLIC_URL = data.ngrokUrl || '';
    BLE_PROFILES = Array.isArray(data.bleProfiles) ? data.bleProfiles.filter(p => p?.service && p?.characteristic) : [];
    if (!BLE_PROFILES.length) {
      addLog('⚠️ No hay BLE_PROFILES en backend. Intentaré auto-descubrir, pero puede fallar si el servicio es personalizado.', 'warning');
    }
    init();
  })
  .catch(err => {
    console.error('Error obteniendo /config:', err);
    addLog('No se pudo obtener la configuración del servidor. Intentaré auto-descubrir.', 'warning');
    init();
  });
