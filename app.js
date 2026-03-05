const state = {
  map: null,
  marker: null,
  watchId: null,
  isLoggedIn: false,
};

const loginScreen = document.getElementById("loginScreen");
const mainScreen = document.getElementById("mainScreen");
const loginForm = document.getElementById("loginForm");
const startBtn = document.getElementById("startBtn");
const statusText = document.getElementById("statusText");
const trackingToggle = document.getElementById("trackingToggle");

loginForm.addEventListener("submit", handleLogin);
startBtn.addEventListener("click", startLocationSharing);
trackingToggle.addEventListener("change", handleToggleChange);

registerServiceWorker();

function handleLogin(event) {
  event.preventDefault();
  state.isLoggedIn = true;

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

  // Dark-ish OSM style without API key.
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(state.map);
}

function startLocationSharing() {
  if (!navigator.geolocation) {
    setStatus("Geolocation is not supported on this device.");
    return;
  }

  if (!trackingToggle.checked) {
    trackingToggle.checked = true;
  }

  if (state.watchId !== null) {
    setStatus("Location sharing already running.");
    return;
  }

  setStatus("Starting location sharing...");

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
    state.marker = L.marker(latlng).addTo(state.map);
  } else {
    state.marker.setLatLng(latlng);
  }

  state.map.setView(latlng, 16);
  setStatus(`Tracking active. Accuracy: ${Math.round(accuracy)}m`);

  sendLocation(latitude, longitude, accuracy, timestamp);
}

function handleLocationError(error) {
  const errorMap = {
    1: "Permission denied for location access.",
    2: "Location unavailable right now.",
    3: "Location request timed out.",
  };

  setStatus(errorMap[error.code] || "Unable to retrieve location.");
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

  setStatus("Tracking paused.");
}

async function sendLocation(lat, lng, accuracy, timestamp) {
  const payload = {
    lat,
    lng,
    accuracy,
    timestamp,
  };

  try {
    await fetch("/api/location", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("Failed to send location:", error);
  }
}

function setStatus(message) {
  statusText.textContent = message;
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
