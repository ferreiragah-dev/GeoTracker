const CIRCLE_REFRESH_INTERVAL_MS = 10000;

const state = {
  map: null,
  ownMarker: null,
  memberMarkers: new Map(),
  watchId: null,
  isLoggedIn: false,
  userInitials: "GS",
  authToken: null,
  user: null,
  circles: [],
  selectedCircleId: null,
  circleRefreshTimer: null,
  pendingInviteCode: null,
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
const circleText = document.getElementById("circleText");
const trackingToggle = document.getElementById("trackingToggle");
const avatarEl = document.querySelector(".avatar");

const menuButton = document.getElementById("menuButton");
const menuPanel = document.getElementById("menuPanel");
const closeMenuButton = document.getElementById("closeMenuButton");
const menuBackdrop = document.getElementById("menuBackdrop");
const createCircleMenuBtn = document.getElementById("createCircleMenuBtn");
const refreshCirclesBtn = document.getElementById("refreshCirclesBtn");
const circleList = document.getElementById("circleList");

const circleModal = document.getElementById("circleModal");
const createCircleForm = document.getElementById("createCircleForm");
const closeCircleModalBtn = document.getElementById("closeCircleModalBtn");
const circleModalStatus = document.getElementById("circleModalStatus");
const inviteLinkBox = document.getElementById("inviteLinkBox");
const inviteLinkInput = document.getElementById("inviteLinkInput");
const copyInviteLinkBtn = document.getElementById("copyInviteLinkBtn");

loginForm.addEventListener("submit", handleLogin);
registerForm.addEventListener("submit", handleRegister);
goToRegisterBtn.addEventListener("click", () => showAuthScreen("register"));
backToLoginBtn.addEventListener("click", () => showAuthScreen("login"));
forgotPasswordBtn.addEventListener("click", handleForgotPassword);

startBtn.addEventListener("click", startLocationSharing);
trackingToggle.addEventListener("change", handleToggleChange);

menuButton.addEventListener("click", toggleMenu);
closeMenuButton.addEventListener("click", closeMenu);
menuBackdrop.addEventListener("click", closeMenu);
createCircleMenuBtn.addEventListener("click", openCreateCircleModal);
refreshCirclesBtn.addEventListener("click", loadCircles);

closeCircleModalBtn.addEventListener("click", closeCreateCircleModal);
circleModal.addEventListener("click", (event) => {
  if (event.target === circleModal) closeCreateCircleModal();
});
createCircleForm.addEventListener("submit", handleCreateCircle);
copyInviteLinkBtn.addEventListener("click", handleCopyInviteLink);

window.addEventListener("popstate", handleBrowserNavigation);

registerServiceWorker();
capturePendingInviteFromPath();
restoreSession();

function capturePendingInviteFromPath() {
  const inviteCode = getJoinCodeFromPath(window.location.pathname);
  if (!inviteCode) return;

  state.pendingInviteCode = inviteCode;
  localStorage.setItem("geoTrackerPendingInvite", inviteCode);
}

function handleBrowserNavigation() {
  if (state.isLoggedIn) {
    if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }
    return;
  }

  capturePendingInviteFromPath();
  const target = resolveAuthScreenFromPath(window.location.pathname);
  showAuthScreen(target, { updateHistory: false });
}

function showAuthScreen(target, options = {}) {
  const { updateHistory = true, historyMode = "push" } = options;
  const showLogin = target !== "register";

  loginScreen.classList.toggle("active", showLogin);
  registerScreen.classList.toggle("active", !showLogin);
  mainScreen.classList.remove("active");

  closeMenu();
  closeCreateCircleModal();

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

    await enterMainScreen(data.user);
  } catch (error) {
    setLoginStatus(error.message || "Email ou senha invalidos.", "error");
  }
}

async function restoreSession() {
  const token = localStorage.getItem("geoTrackerToken");
  const pendingFromStorage = localStorage.getItem("geoTrackerPendingInvite");

  if (!state.pendingInviteCode && pendingFromStorage) {
    state.pendingInviteCode = pendingFromStorage;
  }

  if (!token) {
    const target = resolveAuthScreenFromPath(window.location.pathname);
    showAuthScreen(target, {
      historyMode: "replace",
      updateHistory: !window.location.pathname.startsWith("/login") && !window.location.pathname.startsWith("/register"),
    });

    if (state.pendingInviteCode) {
      setLoginStatus("Faca login para entrar no circulo compartilhado.");
    }
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
    await enterMainScreen(data.user);
  } catch (_error) {
    localStorage.removeItem("geoTrackerToken");
    state.authToken = null;
    showAuthScreen("login", { historyMode: "replace" });
    setLoginStatus("Sessao expirada. Faca login novamente.", "error");
  }
}

async function enterMainScreen(user) {
  state.isLoggedIn = true;
  state.userInitials = user?.initials || deriveUserInitials(user?.email, user?.firstName, user?.lastName);
  avatarEl.textContent = state.userInitials;

  loginScreen.classList.remove("active");
  registerScreen.classList.remove("active");
  mainScreen.classList.add("active");

  closeMenu();
  closeCreateCircleModal();

  if (window.location.pathname !== "/") {
    window.history.replaceState({}, "", "/");
  }

  initializeMap();
  startCirclePolling();

  await loadCircles();

  if (state.pendingInviteCode) {
    await joinCircleByCode(state.pendingInviteCode, { showStatus: true });
  } else if (state.selectedCircleId) {
    await loadSelectedCircleMembers();
  }
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

function toggleMenu() {
  if (menuPanel.classList.contains("open")) {
    closeMenu();
  } else {
    openMenu();
  }
}

function openMenu() {
  menuPanel.classList.add("open");
  menuBackdrop.classList.add("open");
}

function closeMenu() {
  menuPanel.classList.remove("open");
  menuBackdrop.classList.remove("open");
}

function openCreateCircleModal() {
  closeMenu();
  circleModal.classList.add("open");
  setCircleModalStatus("");
  inviteLinkBox.classList.add("hidden");
  createCircleForm.reset();
}

function closeCreateCircleModal() {
  circleModal.classList.remove("open");
}

async function handleCreateCircle(event) {
  event.preventDefault();

  const name = createCircleForm.circleNameInput.value.trim();

  if (!name) {
    setCircleModalStatus("Informe o nome do circulo.", "error");
    return;
  }

  setCircleModalStatus("Criando circulo...");

  try {
    const response = await fetch("/api/circles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ name }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao criar circulo.");
    }

    const inviteLink = buildInviteLink(data.circle.inviteCode);
    inviteLinkInput.value = inviteLink;
    inviteLinkBox.classList.remove("hidden");
    setCircleModalStatus("Circulo criado. Compartilhe o link com amigos.", "success");

    await loadCircles();
    selectCircle(data.circle.id);
  } catch (error) {
    setCircleModalStatus(error.message || "Erro ao criar circulo.", "error");
  }
}

async function handleCopyInviteLink() {
  const link = inviteLinkInput.value.trim();
  if (!link) return;

  try {
    await navigator.clipboard.writeText(link);
    setCircleModalStatus("Link copiado.", "success");
  } catch (_error) {
    inviteLinkInput.select();
    document.execCommand("copy");
    setCircleModalStatus("Link copiado.", "success");
  }
}

async function loadCircles() {
  if (!state.authToken) return;

  try {
    const response = await fetch("/api/circles", {
      headers: authHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao carregar circulos.");
    }

    state.circles = Array.isArray(data.circles) ? data.circles : [];

    if (state.circles.length === 0) {
      state.selectedCircleId = null;
      circleText.textContent = "Sem circulo selecionado.";
      renderCircleList();
      clearMemberMarkers();
      return;
    }

    const selectedExists = state.circles.some((circle) => circle.id === state.selectedCircleId);
    if (!selectedExists) {
      state.selectedCircleId = state.circles[0].id;
    }

    renderCircleList();
  } catch (error) {
    setStatus(error.message || "Erro ao carregar circulos.");
  }
}

function renderCircleList() {
  circleList.innerHTML = "";

  if (state.circles.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "circle-item";
    emptyItem.textContent = "Nenhum circulo ainda.";
    circleList.appendChild(emptyItem);
    return;
  }

  state.circles.forEach((circle) => {
    const item = document.createElement("li");
    item.className = `circle-item${circle.id === state.selectedCircleId ? " active" : ""}`;

    const title = document.createElement("p");
    title.className = "circle-name";
    title.textContent = circle.name;

    const meta = document.createElement("p");
    meta.className = "circle-meta";
    meta.textContent = `${circle.memberCount || 0} membros`;

    const actions = document.createElement("div");
    actions.className = "circle-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "mini-btn";
    openBtn.textContent = "Abrir";
    openBtn.addEventListener("click", async () => {
      selectCircle(circle.id);
      closeMenu();
      await loadSelectedCircleMembers();
    });

    const inviteBtn = document.createElement("button");
    inviteBtn.type = "button";
    inviteBtn.className = "mini-btn";
    inviteBtn.textContent = "Convite";
    inviteBtn.addEventListener("click", async () => {
      const link = buildInviteLink(circle.inviteCode);
      await copyToClipboard(link);
      setStatus("Link de convite copiado.");
    });

    actions.appendChild(openBtn);
    actions.appendChild(inviteBtn);

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(actions);

    circleList.appendChild(item);
  });
}

function selectCircle(circleId) {
  state.selectedCircleId = circleId;
  renderCircleList();
}

async function joinCircleByCode(inviteCode, options = {}) {
  const { showStatus = false } = options;

  if (!inviteCode) return;

  try {
    const response = await fetch("/api/circles/join", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: JSON.stringify({ inviteCode }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Nao foi possivel entrar no circulo.");
    }

    state.pendingInviteCode = null;
    localStorage.removeItem("geoTrackerPendingInvite");

    await loadCircles();
    selectCircle(data.circle.id);
    await loadSelectedCircleMembers();

    if (showStatus) {
      setStatus(`Voce entrou no circulo: ${data.circle.name}`);
    }
  } catch (error) {
    if (showStatus) {
      setStatus(error.message || "Falha ao entrar no circulo.");
    }
  }
}

async function loadSelectedCircleMembers() {
  if (!state.authToken || !state.selectedCircleId) return;

  try {
    const response = await fetch(`/api/circles/${state.selectedCircleId}/members/locations`, {
      headers: authHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Falha ao carregar membros do circulo.");
    }

    circleText.textContent = `${data.circle.name} - ${data.circle.memberCount} membros`;
    updateCircleMemberMarkers(data.members || []);
  } catch (error) {
    setStatus(error.message || "Erro ao carregar localizacao do circulo.");
  }
}

function updateCircleMemberMarkers(members) {
  if (!state.map) return;

  const keepIds = new Set();

  members.forEach((member) => {
    if (!member.lastLocation) {
      if (member.userId !== state.user?.id) {
        const existing = state.memberMarkers.get(member.userId);
        if (existing) {
          state.map.removeLayer(existing);
          state.memberMarkers.delete(member.userId);
        }
      }
      return;
    }

    const latlng = [member.lastLocation.lat, member.lastLocation.lng];
    keepIds.add(member.userId);

    if (member.userId === state.user?.id) {
      if (!state.ownMarker) {
        state.ownMarker = L.marker(latlng, { icon: createUserMarkerIcon() }).addTo(state.map);
      } else if (state.watchId === null) {
        state.ownMarker.setLatLng(latlng);
      }
      return;
    }

    const label = `${member.firstName} ${member.lastName}`.trim() || member.email;
    const popup = `${label}<br/>Atualizado: ${new Date(member.lastLocation.timestamp).toLocaleString()}`;

    if (!state.memberMarkers.has(member.userId)) {
      const marker = L.marker(latlng, {
        icon: createMemberMarkerIcon(member.initials),
      })
        .addTo(state.map)
        .bindPopup(popup);

      state.memberMarkers.set(member.userId, marker);
    } else {
      const marker = state.memberMarkers.get(member.userId);
      marker.setLatLng(latlng);
      marker.setPopupContent(popup);
    }
  });

  Array.from(state.memberMarkers.keys()).forEach((userId) => {
    if (!keepIds.has(userId)) {
      const marker = state.memberMarkers.get(userId);
      state.map.removeLayer(marker);
      state.memberMarkers.delete(userId);
    }
  });
}

function clearMemberMarkers() {
  Array.from(state.memberMarkers.values()).forEach((marker) => {
    if (state.map) state.map.removeLayer(marker);
  });
  state.memberMarkers.clear();
}

function startCirclePolling() {
  if (state.circleRefreshTimer) {
    clearInterval(state.circleRefreshTimer);
  }

  state.circleRefreshTimer = setInterval(() => {
    if (!state.isLoggedIn || !state.selectedCircleId) return;
    loadSelectedCircleMembers();
  }, CIRCLE_REFRESH_INTERVAL_MS);
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
  if (!state.map) return;

  const { latitude, longitude, accuracy } = position.coords;
  const timestamp = new Date(position.timestamp).toISOString();
  const latlng = [latitude, longitude];

  if (!state.ownMarker) {
    state.ownMarker = L.marker(latlng, { icon: createUserMarkerIcon() }).addTo(state.map);
  } else {
    state.ownMarker.setLatLng(latlng);
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

function setCircleModalStatus(message, type = "info") {
  setStatusText(circleModalStatus, message, type);
}

function setStatusText(element, message, type = "info") {
  if (!element) return;

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

function getJoinCodeFromPath(pathname) {
  const match = pathname.match(/^\/join\/([a-zA-Z0-9_-]+)$/);
  if (!match) return null;

  return match[1];
}

function deriveUserInitials(email, firstName, lastName) {
  const fromName = `${firstName || ""} ${lastName || ""}`.trim();

  if (fromName) {
    const parts = fromName.split(/\s+/).filter(Boolean);
    const first = parts[0] ? parts[0].charAt(0) : "G";
    const second = parts[1] ? parts[1].charAt(0) : parts[0] ? parts[0].charAt(1) : "S";
    return `${first}${second}`.toUpperCase();
  }

  const localPart = (email || "").split("@")[0].trim();
  const clean = localPart.replace(/[^a-zA-Z0-9]+/g, " ").trim();

  if (!clean) return "GS";

  const pieces = clean.split(/\s+/).filter(Boolean);
  const first = pieces[0] ? pieces[0].charAt(0) : "G";
  const second = pieces[1] ? pieces[1].charAt(0) : pieces[0] ? pieces[0].charAt(1) : "S";

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

function createMemberMarkerIcon(initials) {
  return L.divIcon({
    className: "member-marker",
    html: `<span class="member-marker__label">${initials || "MB"}</span>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

function buildInviteLink(inviteCode) {
  return `${window.location.origin}/join/${inviteCode}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_error) {
    const temp = document.createElement("input");
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand("copy");
    temp.remove();
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
    } catch (error) {
      console.error("Service worker registration failed:", error);
    }
  });
}
