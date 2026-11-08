// Service worker mínimo: permite instalar LetraLab como app. No guarda nada en caché a
// propósito, para que la app siempre cargue la versión más nueva del servidor local.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
