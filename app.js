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
const registerScreen = document.getElementById("registerScreen");
const mainScreen = document.getElementById("mainScreen");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");

const loginStatus = document.getElementById("loginStatus");
const registerStatus = document.getElementById("registerStatus");
const goToRegisterBtn = document.getElementById("goToRegister");
const backToLoginBtn = document.getElementById("backToLogin");
const forgotPasswordBtn = document.getElementById("forgotPasswordLink");

const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("statusText");
const trackingToggle = document.getElementById("trackingToggle");
const avatarEl = document.querySelector(".avatar");

loginForm.addEventListener("submit", handleLogin);
registerForm.addEventListener("submit", handleRegister);
goToRegisterBtn.addEventListener("click", () => showAuthScreen("register"));
backToLoginBtn.addEventListener("click", () => showAuthScreen("login"));
forgotPasswordBtn.addEventListener("click", handleForgotPassword);

startBtn.addEventListener("click", startLocationSharing);
trackingToggle.addEventListener("change", handleToggleChange);

registerServiceWorker();
restoreSession();
window.addEventListener("popstate", handleBrowserNavigation);

function handleBrowserNavigation() {
  if (state.isLoggedIn) return;

  const target = resolveAuthScreenFromPath(window.location.pathname);
  showAuthScreen(target, { updateHistory: false });
}

function showAuthScreen(target, options = {}) {
  const { updateHistory = true, historyMode = "push" } = options;
  const showLogin = target !== "register";

  loginScreen.classList.toggle("active", showLogin);
  registerScreen.classList.toggle("active", !showLogin);
  mainScreen.classList.remove("active");
  state.isLoggedIn = false;

  setLoginStatus("");
  setRegisterStatus("");

  if (updateHistory) {
    const path = showLogin ? "/login" : "/register";
    if (window.location.pathname !== path) {
      if (historyMode === "replace") {
        window.history.replaceState({}, "", path);
      } else {
        window.history.pushState({}, "", path);
      }
    }
  }
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
    setRegisterStatus("Preencha Nome, Sobrenome, Email e Senha.", "error");
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

    showAuthScreen("login");
    setLoginStatus("Conta criada. Agora faca login.", "success");
  } catch (error) {
    setRegisterStatus(error.message || "Erro ao criar conta.", "error");
  }
}

async function handleLogin(event) {
  event.preventDefault();

  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  if (!email || !password) {
    setLoginStatus("Informe email e senha.", "error");
    return;
  }

  setLoginStatus("Autenticando...");

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
    setLoginStatus(error.message || "Email ou senha invalidos.", "error");
  }
}

async function restoreSession() {
  const token = localStorage.getItem("geoTrackerToken");

  if (!token) {
    const target = resolveAuthScreenFromPath(window.location.pathname);
    showAuthScreen(target, { updateHistory: false });
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
    showAuthScreen("login", { historyMode: "replace" });
    setLoginStatus("Sessao expirada. Faca login novamente.", "error");
  }
}

function enterMainScreen(user) {
  state.isLoggedIn = true;
  state.userInitials = user?.initials || deriveUserInitials(user?.email, user?.firstName, user?.lastName);
  avatarEl.textContent = state.userInitials;

  loginScreen.classList.remove("active");
  registerScreen.classList.remove("active");
  mainScreen.classList.add("active");
  if (window.location.pathname !== "/") {
    window.history.replaceState({}, "", "/");
  }

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

function setLoginStatus(message, type = "info") {
  setStatusText(loginStatus, message, type);
}

function setRegisterStatus(message, type = "info") {
  setStatusText(registerStatus, message, type);
}

function setStatusText(element, message, type = "info") {
  element.textContent = message;
  element.classList.remove("error", "success");

  if (type === "error") element.classList.add("error");
  if (type === "success") element.classList.add("success");
}

function handleForgotPassword() {
  const email = loginForm.email.value.trim();

  if (!email) {
    setLoginStatus("Informe seu email para recuperar a senha.", "error");
    return;
  }

  setLoginStatus("Link de recuperacao em breve. Contate o suporte por enquanto.");
}

function resolveAuthScreenFromPath(pathname) {
  if (pathname === "/register") return "register";
  return "login";
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
