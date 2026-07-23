// Same-page presence, live pointers and saved-change notifications.
// No field values are transmitted.
(function () {
  "use strict";

  const token =
    localStorage.getItem("authToken") || sessionStorage.getItem("authToken");
  if (!token || String(location.pathname).endsWith("login.html")) return;

  const page = (String(location.pathname).split("/").pop() || "dashboard.html")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 80);
  const apiOrigin = String(window.API_ORIGIN || location.origin).replace(/\/+$/, "");
  const socketOrigin = apiOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const apiPrefix = (() => {
    try {
      return new URL(String(window.API_ROOT || "/api/v1"), location.href).pathname
        .replace(/\/+$/, "");
    } catch (_) {
      return "/api/v1";
    }
  })();
  const socketUrl = `${socketOrigin}${apiPrefix}/collaboration/ws`;

  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let reconnectAttempt = 0;
  let ownConnectionId = null;
  let pointerLastSent = 0;
  let lastInputActivity = 0;
  let dataRefreshTimer = null;
  const remotePointers = new Map();

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function describeElement(raw) {
    const element = raw?.closest?.(
      "button, a, [role='button'], input, select, textarea, label, [data-action]"
    ) || raw;
    if (!element) return "Seite";

    let text = element.getAttribute?.("aria-label")
      || element.getAttribute?.("title")
      || element.getAttribute?.("placeholder")
      || "";
    if (!text && element.labels?.length) text = element.labels[0].textContent || "";
    if (!text && ["BUTTON", "A", "LABEL"].includes(element.tagName)) {
      text = element.textContent || "";
    }
    if (!text) text = element.id || element.name || element.tagName || "Seite";
    return String(text).replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function ensureUi() {
    if (document.getElementById("livePresence")) return;

    const presence = document.createElement("aside");
    presence.id = "livePresence";
    presence.className = "live-presence";
    presence.setAttribute("aria-label", "Aktive Kollegen auf dieser Seite");

    const status = document.createElement("span");
    status.className = "live-presence-status";
    status.title = "Live-Verbindung";

    const avatars = document.createElement("div");
    avatars.className = "live-avatar-stack";

    const count = document.createElement("span");
    count.className = "live-presence-count";
    count.textContent = "Verbinden…";

    presence.append(status, avatars, count);

    const activity = document.createElement("div");
    activity.id = "liveActivity";
    activity.className = "live-activity";
    activity.setAttribute("aria-live", "polite");

    const pointerLayer = document.createElement("div");
    pointerLayer.id = "livePointerLayer";
    pointerLayer.className = "live-pointer-layer";
    pointerLayer.setAttribute("aria-hidden", "true");

    document.body.append(pointerLayer, activity, presence);
  }

  function setConnectionState(connected) {
    const presence = document.getElementById("livePresence");
    if (!presence) return;
    presence.classList.toggle("connected", connected);
    if (!connected) {
      const count = presence.querySelector(".live-presence-count");
      if (count) count.textContent = "Offline";
    }
  }

  function renderPresence(participants) {
    const stack = document.querySelector("#livePresence .live-avatar-stack");
    const count = document.querySelector("#livePresence .live-presence-count");
    if (!stack || !count) return;
    stack.replaceChildren();

    participants.slice(0, 6).forEach(person => {
      const avatar = document.createElement("span");
      avatar.className = "live-avatar";
      if (person.connection_id === ownConnectionId) avatar.classList.add("self");
      avatar.textContent = String(person.initials || "?").slice(0, 2);
      avatar.style.setProperty("--avatar-color", person.color || "#2563eb");
      avatar.title = `${person.name || person.username || "Kollege"}${
        person.connection_id === ownConnectionId ? " (Du)" : ""
      }`;
      stack.appendChild(avatar);
    });

    if (participants.length > 6) {
      const more = document.createElement("span");
      more.className = "live-avatar live-avatar-more";
      more.textContent = `+${participants.length - 6}`;
      stack.appendChild(more);
    }

    const colleagues = Math.max(0, participants.length - 1);
    count.textContent = colleagues
      ? `${colleagues} ${colleagues === 1 ? "Kollege" : "Kollegen"} live`
      : "Nur du";

    const activeConnections = new Set(
      participants.map(person => person.connection_id).filter(Boolean)
    );
    remotePointers.forEach((pointer, key) => {
      if (!activeConnections.has(key)) {
        clearTimeout(pointer._hideTimer);
        pointer.remove();
        remotePointers.delete(key);
      }
    });
  }

  function showActivity(person, action, important) {
    const host = document.getElementById("liveActivity");
    if (!host || !action) return;
    const item = document.createElement("div");
    item.className = `live-activity-item${important ? " important" : ""}`;

    const avatar = document.createElement("span");
    avatar.className = "live-activity-avatar";
    avatar.textContent = String(person?.initials || "?").slice(0, 2);
    avatar.style.setProperty("--avatar-color", person?.color || "#2563eb");

    const text = document.createElement("span");
    const name = person?.name || person?.username || "Ein Kollege";
    text.textContent = `${name}: ${action}`;
    item.append(avatar, text);
    host.appendChild(item);

    requestAnimationFrame(() => item.classList.add("show"));
    setTimeout(() => {
      item.classList.remove("show");
      setTimeout(() => item.remove(), 220);
    }, important ? 5200 : 2600);
  }

  function pointerFor(person) {
    const key = person?.connection_id || String(person?.id || "");
    if (!key) return null;
    let pointer = remotePointers.get(key);
    if (pointer) return pointer;

    pointer = document.createElement("div");
    pointer.className = "live-remote-pointer";
    pointer.style.setProperty("--pointer-color", person.color || "#2563eb");
    const arrow = document.createElement("span");
    arrow.className = "live-pointer-arrow";
    const label = document.createElement("span");
    label.className = "live-pointer-label";
    label.textContent = person.name || person.username || "Kollege";
    pointer.append(arrow, label);
    document.getElementById("livePointerLayer")?.appendChild(pointer);
    remotePointers.set(key, pointer);
    return pointer;
  }

  function moveRemotePointer(message, clicked) {
    const pointer = pointerFor(message.participant);
    if (!pointer) return;
    pointer.style.left = `${Number(message.x || 0) * innerWidth}px`;
    pointer.style.top = `${Number(message.y || 0) * innerHeight}px`;
    pointer.classList.add("visible");

    clearTimeout(pointer._hideTimer);
    pointer._hideTimer = setTimeout(() => pointer.classList.remove("visible"), 3200);

    if (clicked) {
      const ring = document.createElement("span");
      ring.className = "live-click-ring";
      pointer.appendChild(ring);
      setTimeout(() => ring.remove(), 650);
    }
  }

  function humanizeDataChange(message) {
    const target = message.target || "Daten";
    if (message.method === "DELETE") return `${target} gelöscht`;
    if (message.method === "PATCH" || message.method === "PUT") return `${target} geändert`;
    return `${target} gespeichert`;
  }

  function handleMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }

    if (message.type === "ready") {
      ownConnectionId = message.participant?.connection_id || null;
      setConnectionState(true);
      return;
    }
    if (message.type === "presence") {
      renderPresence(Array.isArray(message.participants) ? message.participants : []);
      return;
    }
    if (message.type === "cursor" || message.type === "click") {
      moveRemotePointer(message, message.type === "click");
      if (message.type === "click" && message.target) {
        showActivity(message.participant, `klickt auf „${message.target}“`, false);
      }
      return;
    }
    if (message.type === "activity") {
      showActivity(message.participant, message.action, false);
      return;
    }
    if (message.type === "data_changed") {
      showActivity(message.participant, humanizeDataChange(message), true);
      clearTimeout(dataRefreshTimer);
      dataRefreshTimer = setTimeout(() => {
        window.dispatchEvent(new CustomEvent("collaboration:data-changed", {
          detail: message,
        }));
      }, 220);
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    socket = new WebSocket(socketUrl);
    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      send({ type: "auth", token, page });
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => send({ type: "ping" }), 25000);
    });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", event => {
      clearInterval(heartbeatTimer);
      setConnectionState(false);
      if (event.code === 1008) {
        const count = document.querySelector("#livePresence .live-presence-count");
        if (count) count.textContent = "Sitzung abgelaufen";
        return;
      }
      reconnectAttempt += 1;
      const delay = Math.min(15000, 700 * (2 ** Math.min(reconnectAttempt, 5)));
      reconnectTimer = setTimeout(connect, delay);
    });
    socket.addEventListener("error", () => socket?.close());
  }

  function bindActivityTracking() {
    document.addEventListener("pointermove", event => {
      const now = performance.now();
      if (now - pointerLastSent < 90 || !innerWidth || !innerHeight) return;
      pointerLastSent = now;
      send({
        type: "cursor",
        x: event.clientX / innerWidth,
        y: event.clientY / innerHeight,
      });
    }, { passive: true });

    document.addEventListener("click", event => {
      if (!innerWidth || !innerHeight) return;
      send({
        type: "click",
        x: event.clientX / innerWidth,
        y: event.clientY / innerHeight,
        target: describeElement(event.target),
      });
    }, true);

    document.addEventListener("input", event => {
      const now = Date.now();
      if (now - lastInputActivity < 900) return;
      lastInputActivity = now;
      send({
        type: "activity",
        action: `bearbeitet „${describeElement(event.target)}“`,
      });
    }, true);

    window.addEventListener("beforeunload", () => {
      clearTimeout(reconnectTimer);
      clearInterval(heartbeatTimer);
      socket?.close(1000, "page closed");
    });
  }

  function dataTargetFromUrl(rawUrl) {
    try {
      const path = new URL(rawUrl, location.href).pathname.toLowerCase();
      if (path.includes("kw_changes")) return "KW-Maßnahme";
      if (path.includes("kw_plans")) return "KW-Plan";
      if (path.includes("migration-audit")) return "Migration Audit";
      if (path.includes("cross-connect")) return "Cross-Connect";
      if (path.includes("patchpanel")) return "Patchpanel";
      if (path.includes("troubleshooting")) return "Troubleshooting";
      if (path.includes("access-restriction")) return "Access-Anfrage";
      return "Daten";
    } catch (_) {
      return "Daten";
    }
  }

  function wrapFetchForChanges() {
    const previousFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      const rawUrl = typeof input === "string" ? input : input?.url || "";
      return previousFetch(input, init).then(response => {
        if (
          response.ok
          && ["POST", "PUT", "PATCH", "DELETE"].includes(method)
          && !String(rawUrl).includes("/auth/")
          && !String(rawUrl).includes("/collaboration/")
        ) {
          let path = "";
          try { path = new URL(rawUrl, location.href).pathname; } catch (_) {}
          send({
            type: "data_changed",
            method,
            path,
            target: dataTargetFromUrl(rawUrl),
          });
        }
        return response;
      });
    };
  }

  function init() {
    ensureUi();
    bindActivityTracking();
    wrapFetchForChanges();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
