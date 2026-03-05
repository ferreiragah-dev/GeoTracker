const state = {
  map: null,
  marker: null,
  watchId: null,
  isLoggedIn: false,
  userInitials: "GS",
  authToken: null,
  user: null,
};

const loginScreen = document.getElementById("loginScreen");
const mainScreen = document.getElementById("mainScreen");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("statusText");
const trackingToggle = document.getElementById("trackingToggle");
const avatarEl = document.querySelector(".avatar");
const loginTab = document.getElementById("loginTab");
const registerTab = document.getElementById("registerTab");
const authStatus = document.getElementById("authStatus");

loginForm.addEventListener("submit", handleLogin);
registerForm.addEventListener("submit", handleRegister);
startBtn.addEventListener("click", startLocationSharing);
trackingToggle.addEventListener("change", handleToggleChange);
loginTab.addEventListener("click", () => switchAuthTab("login"));
registerTab.addEventListener("click", () => switchAuthTab("register"));

registerServiceWorker();
restoreSession();

function switchAuthTab(tabName) {
  const loginActive = tabName === "login";

  loginTab.classList.toggle("active", loginActive);
  registerTab.classList.toggle("active", !loginActive);
  loginForm.classList.toggle("hidden", !loginActive);
  registerForm.classList.toggle("hidden", loginActive);
  setAuthStatus("");
}

async function handleRegister(event) {
  event.preventDefault();

  const payload = {
    firstName: registerForm.firstName.value.trim(),
    lastName: registerForm.lastName.value.trim(),
    email: registerForm.registerEmail.value.trim(),
    password: registerForm.registerPassword.value,
  };

  if (!payload.firstName || !payload.lastName || !payload.email || !payload.password) {
    setAuthStatus("Preencha Nome, Sobrenome, Email e Senha.", "error");
    return;
  }

  try {
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao criar conta.");
    }

    loginForm.email.value = payload.email;
    loginForm.password.value = "";
    registerForm.reset();
    switchAuthTab("login");
    setAuthStatus("Conta criada. Agora faça login.", "success");
  } catch (error) {
    setAuthStatus(error.message || "Erro ao criar conta.", "error");
  }
}

async function handleLogin(event) {
  event.preventDefault();

  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  if (!email || !password) {
    setAuthStatus("Informe email e senha.", "error");
    return;
  }

  setAuthStatus("Autenticando...");

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha no login.");
    }

    state.authToken = data.token;
    state.user = data.user;
    localStorage.setItem("geoTrackerToken", data.token);

    enterMainScreen(data.user);
  } catch (error) {
    setAuthStatus(error.message || "Email ou senha invalidos.", "error");
  }
}

async function restoreSession() {
  const token = localStorage.getItem("geoTrackerToken");

  if (!token) {
    switchAuthTab("login");
    return;
  }

  state.authToken = token;

  try {
    const response = await fetch("/api/auth/me", {
      headers: authHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Sessao invalida.");
    }

    state.user = data.user;
    enterMainScreen(data.user);
  } catch (_error) {
    localStorage.removeItem("geoTrackerToken");
    state.authToken = null;
    switchAuthTab("login");
    setAuthStatus("Sessao expirada. Faca login novamente.", "error");
  }
}

function enterMainScreen(user) {
  state.isLoggedIn = true;
  state.userInitials = user?.initials || deriveUserInitials(user?.email, user?.firstName, user?.lastName);
  avatarEl.textContent = state.userInitials;

  loginScreen.classList.remove("active");
  mainScreen.classList.add("active");

  initializeMap();
}

function initializeMap() {
  if (state.map) return;

  const defaultCoords = [-23.55052, -46.633308];

  state.map = L.map("map", {
    zoomControl: false,
  }).setView(defaultCoords, 13);

  L.control
    .zoom({
      position: "bottomright",
    })
    .addTo(state.map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(state.map);
}

function startLocationSharing() {
  if (!state.authToken) {
    setStatus("Faca login para compartilhar localizacao.");
    return;
  }

  if (!navigator.geolocation) {
    setStatus("Geolocation nao e suportado neste dispositivo.");
    return;
  }

  if (!trackingToggle.checked) {
    trackingToggle.checked = true;
  }

  if (state.watchId !== null) {
    setStatus("Compartilhamento ja esta ativo.");
    return;
  }

  setStatus("Iniciando compartilhamento...");

  state.watchId = navigator.geolocation.watchPosition(
    handleLocationUpdate,
    handleLocationError,
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    }
  );
}

function handleLocationUpdate(position) {
  const { latitude, longitude, accuracy } = position.coords;
  const timestamp = new Date(position.timestamp).toISOString();
  const latlng = [latitude, longitude];

  if (!state.marker) {
    state.marker = L.marker(latlng, { icon: createUserMarkerIcon() }).addTo(state.map);
  } else {
    state.marker.setLatLng(latlng);
  }

  state.map.setView(latlng, 16);
  setStatus(`Tracking ativo. Precisao: ${Math.round(accuracy)}m`);

  sendLocation(latitude, longitude, accuracy, timestamp);
}

function handleLocationError(error) {
  const errorMap = {
    1: "Permissao de localizacao negada.",
    2: "Localizacao indisponivel no momento.",
    3: "Timeout ao buscar localizacao.",
  };

  setStatus(errorMap[error.code] || "Nao foi possivel obter localizacao.");
}

function handleToggleChange() {
  if (trackingToggle.checked) {
    startLocationSharing();
    return;
  }

  stopLocationSharing();
}

function stopLocationSharing() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }

  setStatus("Tracking pausado.");
}

async function sendLocation(lat, lng, accuracy, timestamp) {
  const payload = {
    lat,
    lng,
    accuracy,
    timestamp,
  };

  try {
    const response = await fetch("/api/location", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error("Location API error:", data.error || response.statusText);
    }
  } catch (error) {
    console.error("Failed to send location:", error);
  }
}

function authHeaders() {
  if (!state.authToken) return {};
  return { Authorization: `Bearer ${state.authToken}` };
}

function setStatus(message) {
  statusText.textContent = message;
}

function setAuthStatus(message, type = "info") {
  authStatus.textContent = message;
  authStatus.classList.remove("error", "success");

  if (type === "error") authStatus.classList.add("error");
  if (type === "success") authStatus.classList.add("success");
}

function deriveUserInitials(email, firstName, lastName) {
  const fromName = `${firstName || ""} ${lastName || ""}`.trim();

  if (fromName) {
    const parts = fromName.split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) || "G";
    const second = parts[1]?.charAt(0) || parts[0]?.charAt(1) || "S";
    return `${first}${second}`.toUpperCase();
  }

  const localPart = (email || "").split("@")[0].trim();
  const clean = localPart.replace(/[^a-zA-Z0-9]+/g, " ").trim();

  if (!clean) return "GS";

  const pieces = clean.split(/\s+/).filter(Boolean);
  const first = pieces[0]?.charAt(0) || "G";
  const second = pieces[1]?.charAt(0) || pieces[0]?.charAt(1) || "S";

  return `${first}${second}`.toUpperCase();
}

function createUserMarkerIcon() {
  return L.divIcon({
    className: "user-marker",
    html: `<span class="user-marker__label">${state.userInitials}</span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("service-worker.js");
    } catch (error) {
      console.error("Service worker registration failed:", error);
    }
  });
}
