/**
 * Hikari – AI Companion
 * Main application module
 */
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// ──────────────────────────────────────────
// 0. Constants & Config
// ──────────────────────────────────────────
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const MAX_CHAT_LOG_HEIGHT = 145;    // px
const AFFECTION_INCREMENT = 2;       // per user message
const AFFECTION_DECAY_INTERVAL = 300_000; // 5 min without interaction → -1

// ──────────────────────────────────────────
// 1. State (encapsulated)
// ──────────────────────────────────────────
const state = {
  apiKey: null,
  affection: 0,
  theme: 'default',
  threeEnabled: true,
  voiceSpeed: 1.0,
  messages: [],            // { role: 'user'|'hikari', content: string, liked?: boolean }
  speaking: false,
  listening: false,
  thinking: false,
  lastInteraction: Date.now(),
  threeScene: null,        // cleanup reference
  audioContext: null,
  recognition: null,
  particlesAnimationId: null,
  visible: true,
};

// ──────────────────────────────────────────
// 2. DOM element references (self‑explanatory IDs)
// ──────────────────────────────────────────
const dom = {
  bgCanvas: document.getElementById('bgCanvas'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  rememberKeyCheckbox: document.getElementById('rememberKeyCheckbox'),
  affectionFill: document.getElementById('affectionFill'),
  affectionLabel: document.getElementById('affectionLabel'),
  avatarWrapper: document.getElementById('avatarWrapper'),
  threeCanvas: document.getElementById('threeCanvas'),
  svgAvatar: document.getElementById('svgAvatar'),
  vizCanvas: document.getElementById('vizCanvas'),
  emotionBadge: document.getElementById('emotionBadge'),
  statusBadge: document.getElementById('statusBadge'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  chatLog: document.getElementById('chatLog'),
  typingIndicator: document.getElementById('typingIndicator'),
  statusMessage: document.getElementById('statusMessage'),
  textInput: document.getElementById('textInput'),
  sendBtn: document.getElementById('sendBtn'),
  micBtn: document.getElementById('micBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsOverlay: document.getElementById('settingsOverlay'),
  voiceSpeedSlider: document.getElementById('voiceSpeedSlider'),
  voiceSpeedValue: document.getElementById('voiceSpeedValue'),
  threeToggle: document.getElementById('threeToggle'),
  themeButtons: document.querySelectorAll('.tb'),
  toastContainer: document.getElementById('toastContainer'),
  settingsBtn: document.getElementById('settingsBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  resetBtn: document.getElementById('resetBtn'),
};

// ──────────────────────────────────────────
// 3. Utility helpers
// ──────────────────────────────────────────
const sanitizeHTML = (str) => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;  // now safe for innerHTML insertion
};

const escapeAttr = (str) => str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const showToast = (msg, duration = 3000) => {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
};

const setStatus = (mode, text) => {
  dom.statusBadge.className = mode; // 'listening'|'thinking'|'speaking'
  dom.statusText.textContent = text;
  if (mode === 'listening') {
    dom.statusDot.style.background = '#ef4444';
  } else if (mode === 'thinking') {
    dom.statusDot.style.background = '#f59e0b';
  } else if (mode === 'speaking') {
    dom.statusDot.style.background = '#22c55e';
  } else {
    dom.statusDot.style.background = '#22c55e';
  }
  dom.statusBadge.classList.toggle('listening', mode === 'listening');
  dom.statusBadge.classList.toggle('thinking', mode === 'thinking');
  dom.statusBadge.classList.toggle('speaking', mode === 'speaking');
};

// ──────────────────────────────────────────
// 4. Persistence (session‑only for API key, localStorage for affection/settings)
// ──────────────────────────────────────────
const persist = {
  save() {
    const data = {
      affection: state.affection,
      theme: state.theme,
      threeEnabled: state.threeEnabled,
      voiceSpeed: state.voiceSpeed,
    };
    localStorage.setItem('hikari_settings', JSON.stringify(data));
  },
  load() {
    try {
      const raw = localStorage.getItem('hikari_settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        state.affection = parsed.affection ?? 0;
        state.theme = parsed.theme || 'default';
        state.threeEnabled = parsed.threeEnabled ?? true;
        state.voiceSpeed = parsed.voiceSpeed || 1.0;
      }
      // API key is stored only if "Remember" was checked
      if (dom.rememberKeyCheckbox.checked) {
        state.apiKey = localStorage.getItem('hikari_apikey');
      }
    } catch { /* ignore corrupt data */ }
  },
  saveApiKey() {
    if (dom.rememberKeyCheckbox.checked) {
      localStorage.setItem('hikari_apikey', state.apiKey);
    } else {
      localStorage.removeItem('hikari_apikey');
    }
  },
  clear() {
    localStorage.removeItem('hikari_settings');
    localStorage.removeItem('hikari_apikey');
  }
};

// ──────────────────────────────────────────
// 5. Affection management
// ──────────────────────────────────────────
function increaseAffection(amount = AFFECTION_INCREMENT) {
  state.affection = Math.min(100, state.affection + amount);
  updateAffectionUI();
  persist.save();
}

function decayAffection() {
  if (Date.now() - state.lastInteraction > AFFECTION_DECAY_INTERVAL) {
    state.affection = Math.max(0, state.affection - 1);
    updateAffectionUI();
    persist.save();
  }
}

function updateAffectionUI() {
  dom.affectionFill.style.width = `${state.affection}%`;
  dom.affectionLabel.textContent = `Bond: ${state.affection}%`;
}

// ──────────────────────────────────────────
// 6. Chat log (XSS‑safe)
// ──────────────────────────────────────────
function addMessage({ role, content, liked = false }) {
  state.messages.push({ role, content, liked });
  state.lastInteraction = Date.now();
  renderMessages();
}

function renderMessages() {
  dom.chatLog.innerHTML = '';
  for (const msg of state.messages) {
    const div = document.createElement('div');
    div.className = `m ${msg.role === 'user' ? 'u' : msg.role === 'hikari' ? 'h' : 's'}`;
    div.textContent = msg.content;  // textContent prevents XSS
    const foot = document.createElement('div');
    foot.className = 'm-foot';
    foot.innerHTML = `<span class="m-heart${msg.liked ? ' liked' : ''}" data-index="${state.messages.indexOf(msg)}">♥</span>`;
    foot.querySelector('.m-heart').addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      state.messages[idx].liked = !state.messages[idx].liked;
      renderMessages();
    });
    div.appendChild(foot);
    dom.chatLog.appendChild(div);
  }
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

function showTypingIndicator(show) {
  dom.typingIndicator.classList.toggle('on', show);
}

// ──────────────────────────────────────────
// 7. API communication
// ──────────────────────────────────────────
async function callGemini(prompt) {
  if (!state.apiKey) throw new Error('API key missing');
  const url = `${GEMINI_API_URL}?key=${encodeURIComponent(state.apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      // ... other categories
    ],
    generationConfig: {
      temperature: 0.85,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 256,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }
  const json = await res.json();
  if (!json.candidates || !json.candidates[0]?.content?.parts?.[0]?.text) {
    throw new Error('Empty response from Gemini');
  }
  return json.candidates[0].content.parts[0].text;
}

async function handleUserMessage(text) {
  addMessage({ role: 'user', content: text });
  increaseAffection();
  showTypingIndicator(true);
  setStatus('thinking', 'Thinking...');
  try {
    // Build conversation context (last 6 messages)
    const context = state.messages
      .slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Hikari'}: ${m.content}`)
      .join('\n');
    const prompt = `You are Hikari, a warm anime AI companion. Keep responses short (1-2 sentences), kind, and slightly playful. Current affection: ${state.affection}%.\n${context}\nHikari:`;
    const reply = await callGemini(prompt);
    addMessage({ role: 'hikari', content: reply });
    speak(reply);
    // Show emotion badge briefly
    dom.emotionBadge.textContent = '✨';
    setTimeout(() => (dom.emotionBadge.textContent = ''), 2000);
  } catch (err) {
    console.error('Gemini error:', err);
    addMessage({ role: 's', content: 'Something went wrong. Please check your API key and connection.' });
    setStatus('', 'Error');
  } finally {
    showTypingIndicator(false);
    if (!state.speaking) setStatus('', 'Ready');
  }
}

// ──────────────────────────────────────────
// 8. Speech (TTS & STT) – abstracted
// ──────────────────────────────────────────
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = state.voiceSpeed;
  utterance.onstart = () => {
    state.speaking = true;
    setStatus('speaking', 'Speaking...');
    startViz();
  };
  utterance.onend = () => {
    state.speaking = false;
    setStatus('', 'Ready');
    stopViz();
  };
  utterance.onerror = () => {
    state.speaking = false;
    setStatus('', 'Ready');
    stopViz();
  };
  window.speechSynthesis.speak(utterance);
}

function startListening() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    showToast('Speech recognition not supported in this browser');
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (state.recognition) state.recognition.abort();
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = false;
  rec.lang = 'en-US';
  rec.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    if (transcript) {
      dom.textInput.value = transcript;
      handleUserMessage(transcript);
    }
    stopListeningUI();
  };
  rec.onerror = (e) => {
    console.error('Speech recognition error:', e.error);
    showToast('Mic error. Check permissions.');
    stopListeningUI();
  };
  rec.onend = () => stopListeningUI();
  state.recognition = rec;
  rec.start();
  state.listening = true;
  setStatus('listening', 'Listening...');
  dom.micBtn.classList.add('on');
}

function stopListening() {
  if (state.recognition) {
    state.recognition.stop();
    state.recognition = null;
  }
  state.listening = false;
  setStatus('', 'Ready');
  dom.micBtn.classList.remove('on');
}

function stopListeningUI() {
  state.listening = false;
  dom.micBtn.classList.remove('on');
  if (!state.thinking && !state.speaking) setStatus('', 'Ready');
}

// ──────────────────────────────────────────
// 9. Audio visualizer (mic‑based)
// ──────────────────────────────────────────
let vizAudioContext = null, vizAnalyser = null, vizSource = null, vizAnimationId = null;

async function startViz() {
  if (vizAudioContext) return; // already running
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    vizAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    vizAnalyser = vizAudioContext.createAnalyser();
    vizAnalyser.fftSize = 64;
    vizSource = vizAudioContext.createMediaStreamSource(stream);
    vizSource.connect(vizAnalyser);
    dom.vizCanvas.classList.add('on');
    drawViz();
  } catch (err) {
    console.warn('Cannot access microphone for visualizer:', err);
  }
}

function stopViz() {
  if (vizAnimationId) cancelAnimationFrame(vizAnimationId);
  if (vizAudioContext) {
    vizAudioContext.close();
    vizAudioContext = null;
    vizAnalyser = null;
    vizSource = null;
  }
  dom.vizCanvas.classList.remove('on');
}

function drawViz() {
  if (!vizAnalyser) return;
  const canvas = dom.vizCanvas;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * devicePixelRatio;
  canvas.height = canvas.offsetHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const dataArray = new Uint8Array(vizAnalyser.frequencyBinCount);
  vizAnalyser.getByteFrequencyData(dataArray);
  ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
  const barWidth = canvas.offsetWidth / dataArray.length;
  for (let i = 0; i < dataArray.length; i++) {
    const barHeight = (dataArray[i] / 255) * canvas.offsetHeight * 0.8;
    const x = i * barWidth;
    const y = canvas.offsetHeight - barHeight;
    ctx.fillStyle = `hsl(${280 + (dataArray[i] / 255) * 40}, 80%, 65%)`;
    ctx.fillRect(x, y, barWidth - 2, barHeight);
  }
  vizAnimationId = requestAnimationFrame(drawViz);
}

// ──────────────────────────────────────────
// 10. Three.js 3D avatar
// ──────────────────────────────────────────
let threeCleanup = null;

async function initThree() {
  if (!state.threeEnabled) return;
  // Dispose previous scene
  if (threeCleanup) threeCleanup();

  try {
    const canvas = dom.threeCanvas;
    canvas.style.display = 'block';
    dom.svgAvatar.style.display = 'none';
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // cap for performance
    renderer.setSize(canvas.offsetWidth, canvas.offsetHeight, false);
    const scene = new THREE.Scene();
    scene.background = null;
    const camera = new THREE.PerspectiveCamera(45, canvas.offsetWidth / canvas.offsetHeight, 0.1, 100);
    camera.position.set(0, 1.4, 3.5);
    camera.lookAt(0, 1, 0);

    // Lights
    const ambient = new THREE.AmbientLight(0x404066, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(1, 3, 2);
    scene.add(dirLight);

    // Load Miku OBJ
    const loader = new OBJLoader();
    const objUrl = 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/models/obj/miku/miku.obj';
    const object = await new Promise((resolve, reject) => {
      loader.load(objUrl, resolve, undefined, reject);
    });
    object.position.y = -0.2;
    object.rotation.y = Math.PI;
    scene.add(object);
    state.threeScene = { renderer, scene, camera, object };

    // Animation loop
    function animate() {
      if (!state.threeScene) return;
      requestAnimationFrame(animate);
      object.rotation.y += 0.002; // gentle spin
      renderer.render(scene, camera);
    }
    animate();

    threeCleanup = () => {
      if (state.threeScene) {
        state.threeScene.renderer.dispose();
        state.threeScene.scene.traverse((child) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
        state.threeScene = null;
      }
      canvas.style.display = 'none';
    };
  } catch (err) {
    console.warn('3D avatar failed, falling back to SVG:', err);
    dom.threeCanvas.style.display = 'none';
    dom.svgAvatar.style.display = 'block';
  }
}

function toggleThree(enable) {
  state.threeEnabled = enable;
  if (enable) {
    initThree();
  } else {
    if (threeCleanup) threeCleanup();
    dom.svgAvatar.style.display = 'block';
  }
  persist.save();
}

// ──────────────────────────────────────────
// 11. Particle background
// ──────────────────────────────────────────
function startParticles() {
  const canvas = dom.bgCanvas;
  const ctx = canvas.getContext('2d');
  let particles = [];
  const maxParticles = 90;
  let animationId;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function createParticle() {
    return {
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      size: Math.random() * 3 + 1,
      opacity: Math.random() * 0.4 + 0.1,
    };
  }

  while (particles.length < maxParticles) particles.push(createParticle());

  function draw() {
    if (!document.hidden) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(168,85,247,${p.opacity})`;
        ctx.fill();
      }
    }
    state.particlesAnimationId = requestAnimationFrame(draw);
  }
  state.particlesAnimationId = requestAnimationFrame(draw);

  // Pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(state.particlesAnimationId);
    } else {
      state.particlesAnimationId = requestAnimationFrame(draw);
    }
  });
}

function stopParticles() {
  if (state.particlesAnimationId) cancelAnimationFrame(state.particlesAnimationId);
}

// ──────────────────────────────────────────
// 12. Settings UI
// ──────────────────────────────────────────
function openSettings() {
  dom.settingsPanel.classList.add('open');
  dom.settingsOverlay.classList.add('open');
}
function closeSettings() {
  dom.settingsPanel.classList.remove('open');
  dom.settingsOverlay.classList.remove('open');
}

function applyTheme(theme) {
  document.body.className = theme === 'default' ? '' : `t-${theme}`;
  state.theme = theme;
  persist.save();
  dom.themeButtons.forEach(btn => {
    btn.classList.toggle('on', btn.dataset.theme === theme);
  });
}

// ──────────────────────────────────────────
// 13. Event wiring & initialization
// ──────────────────────────────────────────
function bindEvents() {
  dom.sendBtn.addEventListener('click', () => {
    const text = dom.textInput.value.trim();
    if (text) {
      dom.textInput.value = '';
      handleUserMessage(text);
    }
  });
  dom.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.sendBtn.click();
  });

  dom.micBtn.addEventListener('click', () => {
    if (state.listening) {
      stopListening();
    } else {
      startListening();
    }
  });

  dom.settingsBtn.addEventListener('click', openSettings);
  dom.closeSettingsBtn.addEventListener('click', closeSettings);
  dom.settingsOverlay.addEventListener('click', closeSettings);

  dom.voiceSpeedSlider.addEventListener('input', (e) => {
    state.voiceSpeed = parseFloat(e.target.value);
    dom.voiceSpeedValue.textContent = state.voiceSpeed.toFixed(1);
    persist.save();
  });

  dom.threeToggle.addEventListener('change', (e) => {
    toggleThree(e.target.checked);
  });

  dom.themeButtons.forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  dom.rememberKeyCheckbox.addEventListener('change', () => {
    if (dom.rememberKeyCheckbox.checked) {
  