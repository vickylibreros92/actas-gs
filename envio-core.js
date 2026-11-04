/* Núcleo de la bandeja de envío (lo usan la página y el service worker).
   Cada acta en cola guarda todo lo necesario para subirse sola: URL del flujo
   de Power Automate y el cuerpo JSON con el PDF en base64. */
var ENVIO = (function () {
  'use strict';
  var DB = 'actaGAM006', VER = 2, dbp = null;
  var canal = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('actaGAM006-envio') : null;

  function abrir() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function db() { return dbp || (dbp = abrir()); }
  function tx(storeName, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(storeName, mode), s = t.objectStore(storeName), out;
        var r = fn(s); if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  function avisar(tipo, item) { try { canal && canal.postMessage({ tipo: tipo, id: item && item.id, nombre: item && item.nombre }); } catch (e) {} }

  var api = {
    kvGet: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
    kvSet: function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); },
    kvDel: function (k) { return tx('kv', 'readwrite', function (s) { return s.delete(k); }); },
    todos: function () { return tx('outbox', 'readonly', function (s) { return s.getAll(); }); },
    guardar: function (it) { return tx('outbox', 'readwrite', function (s) { return s.put(it); }).then(function () { avisar('cambio', it); }); },
    quitar: function (id) { return tx('outbox', 'readwrite', function (s) { return s.delete(id); }).then(function () { avisar('cambio', { id: id }); }); },
    canal: canal
  };

  // Reclama un acta para enviarla (evita que la página y el service worker la suban a la vez)
  function reclamar(id, forzar) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('outbox', 'readwrite'), s = t.objectStore('outbox'), ok = null;
        var g = s.get(id);
        g.onsuccess = function () {
          var it = g.result, ahora = Date.now();
          if (!it) return;
          var libre = it.estado === 'pendiente' || (forzar && it.estado === 'error') || (it.estado === 'enviando' && ahora - (it.lockAt || 0) > 120000);
          if (!libre) return;
          if (!forzar && it.estado === 'pendiente' && it.proximo && it.proximo > ahora) return; // esperando reintento
          it.estado = 'enviando'; it.lockAt = ahora; s.put(it); ok = it;
        };
        t.oncomplete = function () { res(ok); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  function enviarUno(id, forzar) {
    return reclamar(id, forzar).then(function (it) {
      if (!it) return null;
      avisar('cambio', it);
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var tmr = setTimeout(function () { ctrl && ctrl.abort(); }, 120000);
      return fetch(it.flowUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: it.payload, signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          clearTimeout(tmr);
          return r.text().catch(function () { return ''; }).then(function (txt) {
            it.intentos = (it.intentos || 0) + 1; it.lockAt = 0;
            if (r.ok) {
              it.estado = 'subido'; it.subido = Date.now(); it.error = ''; it.payload = null; // libera espacio
              return api.guardar(it).then(function () { avisar('subido', it); return 'ok'; });
            }
            var msg = 'El flujo respondió ' + r.status + (txt ? ': ' + txt.replace(/\s+/g, ' ').slice(0, 180) : '');
            if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
              it.estado = 'error'; it.error = msg; // configuración o datos: requiere revisión
            } else {
              it.estado = 'pendiente'; it.error = msg; it.proximo = Date.now() + Math.min(15 * 60000, 30000 * Math.pow(2, Math.min(it.intentos, 5)));
            }
            return api.guardar(it).then(function () { return 'fallo'; });
          });
        })
        .catch(function (e) {
          clearTimeout(tmr);
          it.intentos = (it.intentos || 0) + 1; it.lockAt = 0;
          it.estado = 'pendiente';
          it.error = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'Sin conexión: se subirá al recuperar la señal.' : 'No se pudo contactar el flujo (sin señal o el flujo no respondió).';
          it.proximo = Date.now() + Math.min(10 * 60000, 20000 * Math.pow(2, Math.min(it.intentos - 1, 4)));
          return api.guardar(it).then(function () { return 'fallo'; });
        });
    });
  }

  // Intenta subir todo lo pendiente. Devuelve cuántas quedaron pendientes.
  api.procesar = function (forzar) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return api.todos().then(function (l) { return { subidas: 0, pendientes: l.filter(function (x) { return x.estado === 'pendiente' || x.estado === 'enviando'; }).length }; });
    }
    return api.todos().then(function (lista) {
      var subidas = 0, cadena = Promise.resolve();
      lista.sort(function (a, b) { return a.creado - b.creado; }).forEach(function (it) {
        if (it.estado !== 'pendiente' && it.estado !== 'enviando') return;
        cadena = cadena.then(function () { return enviarUno(it.id, forzar).then(function (r) { if (r === 'ok') subidas++; }); });
      });
      return cadena.then(api.todos).then(function (l) {
        return { subidas: subidas, pendientes: l.filter(function (x) { return x.estado === 'pendiente' || x.estado === 'enviando'; }).length };
      });
    });
  };
  api.reintentar = function (id) {
    return db().then(function () { return tx('outbox', 'readonly', function (s) { return s.get(id); }); }).then(function (it) {
      if (!it) return null; it.estado = 'pendiente'; it.proximo = 0; return api.guardar(it).then(function () { return enviarUno(id, true); });
    });
  };
  return api;
})();
