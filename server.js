const { spawn } = require('child_process');
const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const express = require('express');
const http = require('http');
const crypto = require('crypto');

dotenv.config();

console.log("🌐 NGROK_PUBLIC_URL:", process.env.NGROK_PUBLIC_URL);

const app = express();
const serverHttp = http.createServer(app);
require('express-ws')(app, serverHttp);

serverHttp.setTimeout(0); 
const PORT = process.env.PORT || 3000;

const User = require('./models/User');
const { checkAuth } = require('./middlewares/auth');

function isUuid128(u) {
  return typeof u === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(u.trim());
}
let BLE_PROFILES = [];
let bleValidation = { ok: true, reasons: [], profiles: [] };
try {
  const raw = process.env.BLE_PROFILES ? JSON.parse(process.env.BLE_PROFILES) : [];
  if (Array.isArray(raw)) {
    BLE_PROFILES = raw
      .filter(p => p && p.service && p.characteristic)
      .map(p => ({
        service: String(p.service).trim().toLowerCase(),
        characteristic: String(p.characteristic).trim().toLowerCase()
      }));
  }
} catch (e) {
  bleValidation.ok = false;
  bleValidation.reasons.push('BLE_PROFILES no es JSON válido en .env');
  BLE_PROFILES = [];
}
if (!BLE_PROFILES.length) {
  bleValidation.ok = false;
  bleValidation.reasons.push('No hay perfiles BLE en .env (BLE_PROFILES).');
}
BLE_PROFILES.forEach((p, i) => {
  const sOk = isUuid128(p.service);
  const cOk = isUuid128(p.characteristic);
  bleValidation.profiles.push({
    index: i,
    service: p.service,
    characteristic: p.characteristic,
    serviceValid: sOk,
    characteristicValid: cOk
  });
  if (!sOk || !cOk) {
    bleValidation.ok = false;
    bleValidation.reasons.push(`Perfil ${i}: UUID inválido (service=${p.service}, characteristic=${p.characteristic})`);
  }
});
console.log(`🔧 BLE_PROFILES cargados: ${BLE_PROFILES.length}`);
if (!bleValidation.ok) {
  console.warn('⚠️  Problemas con BLE_PROFILES:', bleValidation);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

const cookieConfig = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 3600000, 
  path: '/'
};

app.get('/api/user', checkAuth, (req, res) => {
  const { nombre, email } = req.user;
  res.status(200).json({ nombre, email });
});

app.use(express.static(__dirname, { index: false }));
app.use('/private', checkAuth, express.static(path.join(__dirname, 'private')));

app.post('/api/registro', async (req, res) => {
  const { nombre, email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'El correo ya está registrado.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ nombre, email, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: 'Registro exitoso, redirigiendo a login...' });
  } catch (err) {
    console.error('Error en registro:', err);
    res.status(500).json({ message: 'Error en el servidor.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Usuario no encontrado.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Contraseña incorrecta.' });

    const token = jwt.sign({ id: user._id, nombre: user.nombre, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    res.cookie('jwt', token, cookieConfig);
    res.status(200).json({
      message: 'Inicio de sesión exitoso',
      redirect: '/private/index.html'
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ message: 'Error en el servidor.' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('jwt', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
  res.status(200).json({
    message: 'Sesión cerrada exitosamente',
    redirect: '/login.html'
  });
});


app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Correo requerido.' });

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'No existe una cuenta con ese correo.' });
    }

    const crypto = require('crypto');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    user.resetPasswordTokenHash = tokenHash;
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000); 
    await user.save();

    const host = (process.env.NGROK_PUBLIC_URL || req.headers.host || `localhost:${PORT}`)
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const resetUrl = `${protocol}://${host}/reset.html?token=${rawToken}`;

    return res.status(200).json({
      message: 'Te redirigiremos para restablecer tu contraseña.',
      redirect: resetUrl
    });
  } catch (err) {
    console.error('Error en forgot-password:', err);
    res.status(500).json({ message: 'Error en el servidor.' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ message: 'Token y nueva contraseña son requeridos.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Token inválido o expirado.' });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    user.password = hashed;
    user.resetPasswordTokenHash = null;
    user.resetPasswordExpires = null;
    await user.save();

    return res.status(200).json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (err) {
    console.error('Error en reset-password:', err);
    res.status(500).json({ message: 'Error en el servidor.' });
  }
});

app.get('/perfil', checkAuth, (req, res) => {
  res.send(`Bienvenido, ${req.user.nombre}`);
});

app.get('/', (req, res) => {
  const token = req.cookies.jwt;
  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      res.redirect('/private/index.html');
    } catch (err) {
      res.clearCookie('jwt', cookieConfig);
      res.redirect('/login.html');
    }
  } else {
    res.redirect('/login.html');
  }
});

const clients = new Set();

app.ws('/stream', (ws) => {
  try { ws._socket && ws._socket.setNoDelay(true); } catch (_) {}
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

const RTSP_URL = process.env.RTSP_URL;
const RTSP_TRANSPORT = (process.env.CAMERA_TRANSPORT || 'udp').toLowerCase(); 

const ffmpegArgs = [
  '-rtsp_transport', RTSP_TRANSPORT,
  '-i', RTSP_URL,
  '-an',
  '-f', 'mpegts',
  '-codec:v', 'mpeg1video',
  '-s', process.env.CAMERA_RES || '640x480',
  '-b:v', process.env.CAMERA_BITRATE || '800k',
  '-r', process.env.CAMERA_FPS || '30',
  '-g', process.env.CAMERA_FPS || '30',
  '-bf', '0',
  '-tune', 'zerolatency',
  '-preset', 'ultrafast',
  '-'
];

console.log('🎥 FFmpeg args:', ffmpegArgs.join(' '));
const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

ffmpeg.stdout.on('data', (data) => {
  for (const client of clients) {
    if (client.readyState === 1 ) {
      try { client.send(data, { binary: true, compress: false }); } catch (_) {}
    }
  }
});

ffmpeg.stderr.on('data', (data) => {
  const msg = data.toString();
  if (msg && !/frame=.*fps=|bitrate=/.test(msg)) {
    console.log('FFmpeg:', msg.trim());
  }
});

ffmpeg.on('close', (code) => {
  console.log(`FFmpeg finalizó con código ${code}`);
});

let autoProcess = null;
const activeAutoConnections = new Set();

app.ws('/auto-control', (ws) => {
  console.log("🧠 Nueva conexión de modo automático");
  try { ws._socket && ws._socket.setNoDelay(true); } catch (_) {}
  activeAutoConnections.add(ws);

  let isAlive = true;
  const heartbeatInterval = setInterval(() => {
    if (!isAlive) {
      console.log("💔 Conexión inactiva, cerrando...");
      return ws.close();
    }
    isAlive = false;
    try { ws.ping(); } catch (_) {}
  }, 20000);

  ws.on('pong', () => { isAlive = true; });

  ws.on('message', (msg) => {
    const message = msg.toString().trim();
    if (!message) return;

    if (message === 'ping') {
      try { ws.send('pong', { compress: false }); } catch (_) {}
      return;
    }

    const validCommands = ['F', 'B', 'L', 'R', 'S', 'V', 'W', 'X'];
    if (validCommands.includes(message)) {
      activeAutoConnections.forEach(client => {
        if (client !== ws && client.readyState === 1 ) {
          try { client.send(message, { compress: false }); } catch (_) {}
        }
      });
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatInterval);
    activeAutoConnections.delete(ws);
    console.log("❌ Conexión automática cerrada");

    if (activeAutoConnections.size === 0 && autoProcess) {
      console.log("🧠 Deteniendo IA por inactividad...");
      try { autoProcess.kill('SIGINT'); } catch (_) {}
      autoProcess = null;
    }
  });

  if (!autoProcess) startAIController();
});

function startAIController() {
  if (autoProcess) return;

  let wsUrl = process.env.NGROK_PUBLIC_URL || 'localhost:3000';
  wsUrl = wsUrl.replace(/^https?:\/\//, '')
               .replace(/^wss?:\/\//, '')
               .replace(/\/+$/, '');

  const fullWsUrl = `wss://${wsUrl}/auto-control`;
  console.log('🎯 Iniciando IA con WS URL:', fullWsUrl);

  autoProcess = spawn('python', ['auto_ai_server.py'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NGROK_PUBLIC_URL: wsUrl, RTSP_URL: process.env.RTSP_URL }
  });

  autoProcess.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) console.log(`🐍 IA: ${output}`);
  });

  autoProcess.stderr.on('data', (data) => {
    console.error(`❌ IA Error: ${data.toString().trim()}`);
  });

  autoProcess.on('close', (code) => {
    console.log(`🧠 Proceso IA terminado (código ${code})`);
    autoProcess = null;

    if (activeAutoConnections.size > 0) {
      console.log("🔄 Reiniciando IA por clientes activos...");
      startAIController();
    }
  });
}

app.get('/config', (_req, res) => {
  res.json({ ngrokUrl: process.env.NGROK_PUBLIC_URL, bleProfiles: BLE_PROFILES });
});
app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    ngrokUrl: !!process.env.NGROK_PUBLIC_URL,
    rtspUrl: !!process.env.RTSP_URL,
    transport: RTSP_TRANSPORT
  });
});
app.get('/ble/validate', (_req, res) => {
  res.json({ ok: bleValidation.ok, reasons: bleValidation.reasons, profiles: bleValidation.profiles });
});

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado a MongoDB');

    startAIController(); 

    serverHttp.listen(PORT, () => {
      console.log(`🚀 Servidor con WebSocket corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Error al conectar a MongoDB:', err);
  }
}
main();
