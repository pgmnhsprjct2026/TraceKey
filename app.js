/* =========================================================
   TraceKey — Smart Safety Companion App
   Client-side logic. Contacts/settings persist to localStorage.
   Live TraceKey data (location, SOS) arrives from Firebase
   Realtime Database and triggers EmailJS alerts to guardians.
   ========================================================= */

(() => {
  'use strict';

  /* ----------------------------------------------------
     STORAGE KEYS & DEFAULTS
  ---------------------------------------------------- */
  const STORAGE_KEYS = {
    CONTACTS: 'tracelet_contacts',
    SETTINGS: 'tracelet_settings',
    ACTIVITY: 'tracelet_activity',
    LOCATION: 'tracelet_last_location'
  };

  const LEGACY_KEYS = {
    CONTACTS: 'aurelia_contacts',
    SETTINGS: 'aurelia_settings',
    ACTIVITY: 'aurelia_activity',
    LOCATION: 'aurelia_last_location'
  };

  const DEFAULT_SETTINGS = {
    name: 'Juan',
    deviceName: 'TraceKey',
    battery: 87,
    autoShare: true,
    sound: true
  };

  const MOCK_ORIGIN = { lat: 14.5547, lng: 121.0244 };

  /* ----------------------------------------------------
     UTILITIES
  ---------------------------------------------------- */
  function loadJSON(key, fallback, legacyKey = null) {
    try {
      let raw = localStorage.getItem(key);
      if (!raw && legacyKey) raw = localStorage.getItem(legacyKey);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('Failed to parse localStorage key', key, e);
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('Failed to save to localStorage', e);
    }
  }

  function uid() {
    return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function formatTime(date = new Date()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str = '') {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function initials(name = '?') {
    return name.trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }

  function refreshIcons() {
    if (window.lucide) lucide.createIcons();
  }

  /* ----------------------------------------------------
     STATE
  ---------------------------------------------------- */
  const state = {
    settings: { ...DEFAULT_SETTINGS, ...loadJSON(STORAGE_KEYS.SETTINGS, {}, LEGACY_KEYS.SETTINGS) },
    contacts: loadJSON(STORAGE_KEYS.CONTACTS, [], LEGACY_KEYS.CONTACTS),
    activity: loadJSON(STORAGE_KEYS.ACTIVITY, [], LEGACY_KEYS.ACTIVITY),
    currentLocation: loadJSON(STORAGE_KEYS.LOCATION, MOCK_ORIGIN, LEGACY_KEYS.LOCATION),
    map: null,
    marker: null,
    accuracyCircle: null,
    sosActive: false,
    simInterval: null,
    deviceRef: null,
    lastDeviceUpdate: 0
  };

  /* ----------------------------------------------------
     TOAST NOTIFICATIONS
  ---------------------------------------------------- */
  function toast(message, type = 'info', icon = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4 mt-0.5 flex-shrink-0"></i><span>${escapeHtml(message)}</span>`;
    container.appendChild(el);
    refreshIcons();
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, 3800);
  }

  /* ----------------------------------------------------
     ACTIVITY LOG
  ---------------------------------------------------- */
  function logActivity(text, icon = 'circle') {
    state.activity.unshift({ text, icon, time: formatTime() });
    state.activity = state.activity.slice(0, 8);
    saveJSON(STORAGE_KEYS.ACTIVITY, state.activity);
    renderActivity();
  }

  function renderActivity() {
    const list = document.getElementById('activityLog');
    if (!state.activity.length) {
      list.innerHTML = '<li class="activity-empty">No recent activity yet — your timeline will appear here.</li>';
      return;
    }
    list.innerHTML = state.activity.map(item => `
      <li class="flex items-center gap-2.5">
        <i data-lucide="${escapeHtml(item.icon)}" class="w-3.5 h-3.5 text-gold-400 flex-shrink-0"></i>
        <span class="flex-1">${escapeHtml(item.text)}</span>
        <span class="text-xs text-slate-500">${escapeHtml(item.time)}</span>
      </li>
    `).join('');
    refreshIcons();
  }

  /* ----------------------------------------------------
     TAB NAVIGATION
  ---------------------------------------------------- */
  function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('mobileNav').classList.toggle('hidden');
    });
  }

  function switchTab(name) {
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
    });
    document.querySelectorAll('.nav-tab, .nav-tab-mobile').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.getElementById('mobileNav').classList.add('hidden');

    if (name === 'map' && state.map) {
      setTimeout(() => state.map.invalidateSize(), 80);
    }
  }

  /* ----------------------------------------------------
     CLOCK
  ---------------------------------------------------- */
  function startClock() {
    const el = document.getElementById('liveClock');
    function tick() {
      const now = new Date();
      el.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + formatTime(now);
    }
    tick();
    setInterval(tick, 30000);
  }

  /* ----------------------------------------------------
     DASHBOARD / DEVICE INFO
  ---------------------------------------------------- */
  function renderDashboardInfo() {
    document.getElementById('welcomeName').textContent = `Hello, ${state.settings.name || 'there'}`;
    document.getElementById('deviceNameLabel').textContent = state.settings.deviceName || 'TraceKey';
    document.getElementById('batteryPercentLabel').textContent = `${state.settings.battery}%`;
    document.getElementById('batteryFillBar').style.width = `${state.settings.battery}%`;
    document.getElementById('contactsCountLabel').textContent = `${state.contacts.length} saved`;
  }

  function simulateBatteryDrain() {
    setInterval(() => {
      if (state.settings.battery > 5) {
        state.settings.battery -= 1;
        saveJSON(STORAGE_KEYS.SETTINGS, state.settings);
        renderDashboardInfo();
      }
    }, 45000);
  }

  /* ----------------------------------------------------
     GPS / MAP
  ---------------------------------------------------- */
  const VECTOR_SOURCE = {
    style: 'https://tiles.openfreemap.org/styles/dark',
    attribution:
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
      '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  };

  const TILE_SOURCES = [
    {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: {
        maxNativeZoom: 16,
        maxZoom: 19,
        attribution: 'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>'
      }
    },
    {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      options: {
        maxZoom: 19,
        attribution: 'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>'
      }
    },
    {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      }
    }
  ];

  function webglSupported() {
    try {
      const canvas = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch (e) {
      return false;
    }
  }

  function initMap() {
    if (!window.L) {
      toast('Map library could not be loaded.', 'danger', 'alert-triangle');
      updateLocationDisplays();
      return;
    }

    state.map = L.map('map', { zoomControl: true, attributionControl: false })
      .setView([state.currentLocation.lat, state.currentLocation.lng], 15);

    L.control.attribution({ prefix: false }).addTo(state.map);

    let rasterIndex = 0;
    let baseLayer = null;

    const useRaster = (i) => {
      if (baseLayer) state.map.removeLayer(baseLayer);
      baseLayer = L.tileLayer(TILE_SOURCES[i].url, TILE_SOURCES[i].options).addTo(state.map);
      let errors = 0;
      baseLayer.on('tileerror', () => {
        errors++;
        if (errors >= 5 && rasterIndex < TILE_SOURCES.length - 1) {
          rasterIndex++;
          useRaster(rasterIndex);
        }
      });
    };

    const useVector = () => {
      try {
        baseLayer = L.maplibreGL({
          style: VECTOR_SOURCE.style,
          attribution: VECTOR_SOURCE.attribution
        }).addTo(state.map);

        let errors = 0;
        const gl = baseLayer.getMaplibreMap();
        gl.on('error', () => {
          errors++;
          if (errors === 3) useRaster(rasterIndex);
        });
      } catch (e) {
        if (baseLayer) state.map.removeLayer(baseLayer);
        baseLayer = null;
        useRaster(rasterIndex);
      }
    };

    if (window.maplibregl && L.maplibreGL && webglSupported()) {
      useVector();
    } else {
      useRaster(rasterIndex);
    }

    const goldIcon = L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:#e8c987;border:3px solid #fff;box-shadow:0 0 12px rgba(232,201,135,0.8)"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });

    state.marker = L.marker([state.currentLocation.lat, state.currentLocation.lng], { icon: goldIcon }).addTo(state.map);
    state.accuracyCircle = L.circle([state.currentLocation.lat, state.currentLocation.lng], {
      radius: 60,
      color: '#e8c987',
      weight: 1,
      fillColor: '#e8c987',
      fillOpacity: 0.08
    }).addTo(state.map);

    updateLocationDisplays();
  }

  function setLocation(lat, lng, persist = true) {
    state.currentLocation = { lat, lng };
    if (persist) saveJSON(STORAGE_KEYS.LOCATION, state.currentLocation);

    if (state.map && state.marker) {
      state.marker.setLatLng([lat, lng]);
      state.accuracyCircle.setLatLng([lat, lng]);
      state.map.panTo([lat, lng]);
    }
    updateLocationDisplays();
  }

  function updateLocationDisplays() {
    const { lat, lng } = state.currentLocation;
    const latStr = lat.toFixed(5);
    const lngStr = lng.toFixed(5);
    document.getElementById('latValue').textContent = latStr;
    document.getElementById('lngValue').textContent = lngStr;
    document.getElementById('lastUpdatedValue').textContent = formatTime();
    document.getElementById('locationLabel').textContent = `${latStr}, ${lngStr}`;
  }

  function useRealGps() {
    if (!('geolocation' in navigator)) {
      toast('Geolocation is not supported on this device.', 'danger', 'alert-triangle');
      return;
    }
    toast('Requesting device location permission…', 'info', 'locate-fixed');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation(pos.coords.latitude, pos.coords.longitude);
        const accuracy = Math.round(pos.coords.accuracy);
        document.getElementById('gpsAccuracyLabel').textContent = `±${accuracy}m`;
        if (state.accuracyCircle) state.accuracyCircle.setRadius(pos.coords.accuracy);
        if (state.map) state.map.setView([pos.coords.latitude, pos.coords.longitude], 16);
        toast('Live GPS location acquired.', 'success', 'check-circle-2');
        logActivity('Switched to real device GPS', 'locate-fixed');
      },
      (err) => {
        toast('Could not access real GPS (' + err.message + ').', 'danger', 'alert-triangle');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function simulateMovement() {
    if (Date.now() - state.lastDeviceUpdate < 60000) {
      toast('A live TraceKey is sending its location — simulation is disabled.', 'info', 'radio');
      return;
    }
    if (state.simInterval) {
      clearInterval(state.simInterval);
      state.simInterval = null;
      toast('Movement simulation stopped.', 'info', 'pause');
      return;
    }
    toast('Simulating live TraceKey movement…', 'info', 'shuffle');
    state.simInterval = setInterval(() => {
      const jitterLat = (Math.random() - 0.5) * 0.0015;
      const jitterLng = (Math.random() - 0.5) * 0.0015;
      setLocation(state.currentLocation.lat + jitterLat, state.currentLocation.lng + jitterLng);
    }, 2000);
  }

  /* ----------------------------------------------------
     LIVE TRACEKEY (Firebase Realtime Database)
  ---------------------------------------------------- */
  function isLiveConfigured(cfg) {
    return !!(cfg && cfg.firebase && cfg.deviceId &&
      cfg.firebase.databaseURL && !String(cfg.firebase.databaseURL).includes('PASTE') &&
      cfg.firebase.apiKey && !String(cfg.firebase.apiKey).includes('PASTE') &&
      !String(cfg.deviceId).includes('CHANGE-ME'));
  }

  function initLiveDevice() {
    const cfg = window.TRACELET_CONFIG;
    if (!isLiveConfigured(cfg)) {
      console.info('Live TraceKey sync is off — fill in config.js to enable it.');
      return;
    }
    if (!window.firebase) {
      toast('Could not load Firebase. Live TraceKey sync is off.', 'danger', 'alert-triangle');
      return;
    }

    try {
      firebase.initializeApp(cfg.firebase);
      state.deviceRef = firebase.database().ref('devices/' + cfg.deviceId);
      let firstData = true;

      state.deviceRef.on('value', (snap) => {
        const data = snap.val();
        if (!data) return;
        if (firstData) {
          firstData = false;
          toast('TraceKey connected — receiving live data.', 'success', 'radio');
          logActivity('Live TraceKey connected', 'radio');
        }
        handleDeviceData(data);
      }, (err) => {
        console.error('Live TraceKey listener error', err);
        toast('Live TraceKey sync error: ' + err.message, 'danger', 'alert-triangle');
      });
    } catch (e) {
      console.error('Live TraceKey init failed', e);
      toast('Live TraceKey sync failed to start.', 'danger', 'alert-triangle');
    }
  }

  function handleDeviceData(d) {
    state.lastDeviceUpdate = Date.now();

    if (state.simInterval) {
      clearInterval(state.simInterval);
      state.simInterval = null;
    }

    if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
      setLocation(d.lat, d.lng);
    }

    if (Number.isFinite(d.battery)) {
      state.settings.battery = Math.max(0, Math.min(100, Math.round(d.battery)));
      saveJSON(STORAGE_KEYS.SETTINGS, state.settings);
      renderDashboardInfo();
    }

    if (d.sos === true && !state.sosActive) {
      triggerSos({ lat: d.lat, lng: d.lng });
    }
  }

  /* ----------------------------------------------------
     SOS / EMERGENCY EMAIL ALERT SYSTEM
  ---------------------------------------------------- */
  function triggerSos(coords = null) {
    if (state.sosActive) return;
    state.sosActive = true;

    const overlay = document.getElementById('sosOverlay');
    overlay.classList.remove('hidden');
    document.getElementById('sosStatusText').textContent = 'Dispatching email alert to guardians…';
    document.getElementById('sosCoordsText').textContent = 'Acquiring precise location…';

    if (state.settings.sound) playAlertTone();
    logActivity(coords ? 'SOS triggered from ESP32 TraceKey' : 'SOS triggered manually', 'shield-alert');

    const finishDispatch = (lat, lng) => {
      if (!state.sosActive) return;
      setLocation(lat, lng);
      const coordText = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      document.getElementById('sosCoordsText').textContent = `Coordinates: ${coordText}`;
      dispatchEmailAlerts(coordText);
    };

    // Prioritize browser GPS if ESP32 only sends dummy test coords, or use ESP32 coords if valid
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => finishDispatch(pos.coords.latitude, pos.coords.longitude),
        () => {
          const fallbackLat = (coords && Number.isFinite(coords.lat)) ? coords.lat : state.currentLocation.lat;
          const fallbackLng = (coords && Number.isFinite(coords.lng)) ? coords.lng : state.currentLocation.lng;
          finishDispatch(fallbackLat, fallbackLng);
        },
        { enableHighAccuracy: true, timeout: 4000 }
      );
    } else {
      const fallbackLat = (coords && Number.isFinite(coords.lat)) ? coords.lat : state.currentLocation.lat;
      const fallbackLng = (coords && Number.isFinite(coords.lng)) ? coords.lng : state.currentLocation.lng;
      finishDispatch(fallbackLat, fallbackLng);
    }
  }

  function dispatchEmailAlerts(coordText) {
    const statusEl = document.getElementById('sosStatusText');
    const cfg = window.TRACELET_CONFIG?.emailjs;

    const emailContacts = state.contacts.filter(c => c.email && c.email.trim() !== '');

    if (!emailContacts.length) {
      statusEl.textContent = 'No emergency emails saved — add a guardian email to enable alerts.';
      toast('SOS active, but no guardian emails are registered.', 'danger', 'user-x');
      return;
    }

    if (!cfg || !cfg.publicKey || cfg.publicKey.includes('PASTE')) {
      statusEl.textContent = 'EmailJS keys missing in config.js — check console.';
      console.warn('[EMAIL ALERT] Configure emailjs in config.js to dispatch real emails.');
      return;
    }

    if (!window.emailjs) {
      statusEl.textContent = 'EmailJS library failed to load.';
      return;
    }

    emailjs.init({ publicKey: cfg.publicKey });

    const mapsLink = `https://www.google.com/maps?q=${encodeURIComponent(coordText.replace(/\s/g, ''))}`;
    let sentCount = 0;

    emailContacts.forEach((contact) => {
      statusEl.textContent = `Sending emergency email to ${contact.name} (${contact.email})…`;

      const templateParams = {
        to_name: contact.name,
        guardian_email: contact.email,
        user_name: state.settings.name || 'TraceKey User',
        device_name: state.settings.deviceName || 'TraceKey',
        coordinates: coordText,
        location_link: mapsLink,
        timestamp: new Date().toLocaleString()
      };

      emailjs.send(cfg.serviceId, cfg.templateId, templateParams)
        .then(() => {
          sentCount++;
          logActivity(`SOS email sent to ${contact.name}`, 'mail');
          if (sentCount === emailContacts.length) {
            statusEl.textContent = `Emergency email sent to all ${emailContacts.length} guardian(s)!`;
            toast(`SOS email delivered to ${sentCount} guardian(s).`, 'success', 'mail-check');
          }
        })
        .catch((err) => {
          console.error('EmailJS error for', contact.email, err);
          statusEl.textContent = `Failed to send email to ${contact.name}. Check console.`;
          toast(`Email failed for ${contact.name}.`, 'danger', 'alert-triangle');
        });
    });
  }

  function cancelSos() {
    state.sosActive = false;
    if (state.deviceRef) {
      state.deviceRef.child('sos').set(false).catch((e) => console.warn('Could not clear SOS flag', e));
    }
    document.getElementById('sosOverlay').classList.add('hidden');
    toast('SOS alert cancelled.', 'info', 'shield-off');
    logActivity('SOS alert cancelled', 'shield-off');
  }

  function playAlertTone() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 660, 880].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.value = 0.15;
        osc.connect(gain).connect(ctx.destination);
        const start = ctx.currentTime + idx * 0.28;
        osc.start(start);
        osc.stop(start + 0.22);
      });
    } catch (e) {
      console.warn('Audio alert unavailable', e);
    }
  }

  /* ----------------------------------------------------
     EMERGENCY CONTACTS (CRUD via localStorage)
  ---------------------------------------------------- */
  function renderContacts() {
    const grid = document.getElementById('contactsGrid');
    const empty = document.getElementById('contactsEmptyState');

    if (!state.contacts.length) {
      grid.innerHTML = '';
      empty.classList.remove('hidden');
      document.getElementById('contactsCountLabel').textContent = '0 saved';
      return;
    }
    empty.classList.add('hidden');
    document.getElementById('contactsCountLabel').textContent = `${state.contacts.length} saved`;

    grid.innerHTML = state.contacts.map(c => `
      <div class="glass-card p-5 contact-card" data-id="${escapeHtml(c.id)}">
        <div class="flex items-start gap-3 overflow-hidden">
          <div class="contact-avatar">${escapeHtml(initials(c.name))}</div>
          <div class="min-w-0">
            <p class="font-semibold text-white truncate">${escapeHtml(c.name)}</p>
            <p class="text-sm text-gold-400 truncate">${escapeHtml(c.email || 'No email set')}</p>
            ${c.phone ? `<p class="text-xs text-slate-400 mt-0.5">${escapeHtml(c.phone)}</p>` : ''}
            ${c.relation ? `<span class="inline-block mt-1.5 text-[10px] uppercase tracking-wide text-gold-400 bg-gold-400/10 px-2 py-0.5 rounded-full">${escapeHtml(c.relation)}</span>` : ''}
          </div>
        </div>
        <div class="flex flex-col gap-1.5 flex-shrink-0">
          <button class="glass-btn w-8 h-8 rounded-full flex items-center justify-center edit-contact-btn" data-id="${escapeHtml(c.id)}" title="Edit">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>
          </button>
          <button class="glass-btn w-8 h-8 rounded-full flex items-center justify-center delete-contact-btn" data-id="${escapeHtml(c.id)}" title="Remove">
            <i data-lucide="trash-2" class="w-3.5 h-3.5 text-rose-400"></i>
          </button>
        </div>
      </div>
    `).join('');

    refreshIcons();

    grid.querySelectorAll('.edit-contact-btn').forEach(btn =>
      btn.addEventListener('click', () => openContactModal(btn.dataset.id))
    );
    grid.querySelectorAll('.delete-contact-btn').forEach(btn =>
      btn.addEventListener('click', () => deleteContact(btn.dataset.id))
    );
  }

  function openContactModal(id = null) {
    const modal = document.getElementById('contactModal');
    const title = document.getElementById('contactModalTitle');
    const form = document.getElementById('contactForm');
    form.reset();

    if (id) {
      const contact = state.contacts.find(c => c.id === id);
      if (!contact) return;
      title.textContent = 'Edit Guardian';
      document.getElementById('contactId').value = contact.id;
      document.getElementById('contactName').value = contact.name;
      document.getElementById('contactEmail').value = contact.email || '';
      document.getElementById('contactPhone').value = contact.phone || '';
      document.getElementById('contactRelation').value = contact.relation || '';
    } else {
      title.textContent = 'Add Guardian';
      document.getElementById('contactId').value = '';
    }

    modal.classList.remove('hidden');
  }

  function closeContactModal() {
    document.getElementById('contactModal').classList.add('hidden');
  }

  function saveContactFromForm(e) {
    e.preventDefault();
    const id = document.getElementById('contactId').value;
    const name = document.getElementById('contactName').value.trim();
    const email = document.getElementById('contactEmail').value.trim();
    const phone = document.getElementById('contactPhone').value.trim();
    const relation = document.getElementById('contactRelation').value.trim();

    if (!name || !email) {
      toast('Name and email address are required.', 'danger', 'alert-triangle');
      return;
    }

    if (id) {
      const contact = state.contacts.find(c => c.id === id);
      if (!contact) return;
      Object.assign(contact, { name, email, phone, relation });
      toast(`Updated ${name}.`, 'success', 'check-circle-2');
      logActivity(`Updated guardian ${name}`, 'pencil');
    } else {
      state.contacts.push({ id: uid(), name, email, phone, relation });
      toast(`${name} added as a guardian.`, 'success', 'user-plus');
      logActivity(`Added guardian ${name}`, 'user-plus');
    }

    saveJSON(STORAGE_KEYS.CONTACTS, state.contacts);
    renderContacts();
    renderDashboardInfo();
    closeContactModal();
  }

  function deleteContact(id) {
    const contact = state.contacts.find(c => c.id === id);
    if (!contact) return;
    if (!confirm(`Remove ${contact.name} from your emergency contacts?`)) return;
    state.contacts = state.contacts.filter(c => c.id !== id);
    saveJSON(STORAGE_KEYS.CONTACTS, state.contacts);
    renderContacts();
    renderDashboardInfo();
    toast(`${contact.name} removed.`, 'info', 'trash-2');
    logActivity(`Removed guardian ${contact.name}`, 'trash-2');
  }

  function initContactsUI() {
    document.getElementById('openContactModalBtn').addEventListener('click', () => openContactModal());
    document.getElementById('closeContactModalBtn').addEventListener('click', closeContactModal);
    document.getElementById('cancelContactBtn').addEventListener('click', closeContactModal);
    document.getElementById('contactForm').addEventListener('submit', saveContactFromForm);
    document.getElementById('contactModal').addEventListener('click', (e) => {
      if (e.target.id === 'contactModal') closeContactModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeContactModal();
    });
  }

  /* ----------------------------------------------------
     ABOUT — RESEARCH TEAM
     Edit this list: name, role, and optional photo path.
     Leave photo as '' to show an initials avatar instead.
  ---------------------------------------------------- */
  const TEAM_MEMBERS = [
    { name: 'Researcher Name 1', role: 'Project Lead / Firmware', photo: '', bio: 'Add a short description of this member\'s contribution.' },
    { name: 'Researcher Name 2', role: 'Web Application Developer', photo: '', bio: 'Add a short description of this member\'s contribution.' },
    { name: 'Researcher Name 3', role: 'Hardware & Circuit Design', photo: '', bio: 'Add a short description of this member\'s contribution.' },
    { name: 'Researcher Name 4', role: 'Research & Documentation', photo: '', bio: 'Add a short description of this member\'s contribution.' }
  ];

  function getInitials(name = '') {
    return name.trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase() || '?';
  }

  function renderTeam() {
    const grid = document.getElementById('teamGrid');
    if (!grid) return;
    grid.innerHTML = TEAM_MEMBERS.map(m => `
      <div class="glass-card p-6 text-center team-card">
        ${m.photo
          ? `<img src="${escapeHtml(m.photo)}" alt="${escapeHtml(m.name)}" class="team-photo" loading="lazy">`
          : `<div class="team-avatar">${escapeHtml(getInitials(m.name))}</div>`}
        <h3 class="font-display text-xl font-bold text-white mt-4">${escapeHtml(m.name)}</h3>
        <span class="text-[10px] uppercase tracking-wider text-gold-400/80">${escapeHtml(m.role)}</span>
        <p class="text-sm text-slate-400 leading-relaxed mt-3">${escapeHtml(m.bio)}</p>
      </div>
    `).join('');

    grid.querySelectorAll('.team-photo').forEach(img => {
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    });
  }

  /* ----------------------------------------------------
     SETTINGS
  ---------------------------------------------------- */
  function renderSettingsForm() {
    document.getElementById('settingName').value = state.settings.name || '';
    document.getElementById('settingDeviceName').value = state.settings.deviceName || '';
    document.getElementById('settingAutoShare').checked = !!state.settings.autoShare;
    document.getElementById('settingSound').checked = !!state.settings.sound;
  }

  function initSettingsUI() {
    document.getElementById('settingsForm').addEventListener('submit', (e) => {
      e.preventDefault();
      state.settings.name = document.getElementById('settingName').value.trim() || 'Juan';
      state.settings.deviceName = document.getElementById('settingDeviceName').value.trim() || 'TraceKey';
      state.settings.autoShare = document.getElementById('settingAutoShare').checked;
      state.settings.sound = document.getElementById('settingSound').checked;
      saveJSON(STORAGE_KEYS.SETTINGS, state.settings);
      renderDashboardInfo();
      toast('Settings saved.', 'success', 'check-circle-2');
      logActivity('Profile settings updated', 'settings');
    });

    document.getElementById('resetDataBtn').addEventListener('click', () => {
      if (!confirm('This will erase all contacts, activity, and settings stored in this browser. Continue?')) return;
      Object.values(STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
      Object.values(LEGACY_KEYS).forEach(key => localStorage.removeItem(key));
      toast('All local data has been reset.', 'info', 'trash-2');
      setTimeout(() => location.reload(), 800);
    });
  }

  /* ----------------------------------------------------
     QUICK ACTIONS
  ---------------------------------------------------- */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('Clipboard unavailable'));
  }

  function initQuickActions() {
    document.querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        switch (action) {
          case 'share-location': {
            const { lat, lng } = state.currentLocation;
            const link = `https://www.google.com/maps?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
            copyToClipboard(link)
              .then(() => toast('Location link copied — ready to share with your guardians.', 'success', 'share-2'))
              .catch(() => toast('Location link ready: ' + link, 'info', 'share-2'));
            logActivity('Shared current location', 'share-2');
            break;
          }
          case 'check-in':
            toast('Safe check-in logged.', 'success', 'check-circle-2');
            logActivity('Sent a safe check-in', 'check-circle-2');
            break;
          case 'goto-contacts':
            switchTab('contacts');
            break;
          case 'goto-map':
            switchTab('map');
            break;
        }
      });
    });
  }

  /* ----------------------------------------------------
     SOS BUTTON BINDINGS
  ---------------------------------------------------- */
  function initSosUI() {
    document.getElementById('sosTriggerBtn').addEventListener('click', () => triggerSos());
    document.getElementById('cancelSosBtn').addEventListener('click', cancelSos);
    document.getElementById('useRealGpsBtn').addEventListener('click', useRealGps);
    document.getElementById('simulateMoveBtn').addEventListener('click', simulateMovement);
  }

  /* ----------------------------------------------------
     INIT
  ---------------------------------------------------- */
  function init() {
    refreshIcons();
    initTabs();
    initContactsUI();
    initSettingsUI();
    initQuickActions();
    initSosUI();

    // Migrate old saved device name to the new product name
    if (state.settings.deviceName === 'TraceKey') {
      state.settings.deviceName = 'TraceKey';
      saveJSON(STORAGE_KEYS.SETTINGS, state.settings);
    }

    startClock();
    renderDashboardInfo();
    renderContacts();
    renderTeam();
    renderSettingsForm();
    renderActivity();
    simulateBatteryDrain();

    initMap();
    initLiveDevice();

    if (!state.contacts.length && !state.activity.length) {
      logActivity('Welcome to TraceKey — add a guardian email to get started', 'sparkles');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
