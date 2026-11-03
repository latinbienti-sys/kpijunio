/*
 * sheet-sync.js — Puente entre el Google Sheet de TI y el dashboard.
 *
 * Se usa de dos formas:
 *   1) En el navegador: <script src="sheet-sync.js"></script> expone window.SheetSync
 *   2) En Node: const SheetSync = require('./sheet-sync.js')
 *
 * Regla de oro: la hoja manda en los datos operativos (estado, prioridad, fechas,
 * avance, responsable y tareas nuevas). Lo que ya está curado en el dashboard
 * (nombre corregido, categoría, hito y notas) NO se pisa con las erratas de la hoja.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SheetSync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var SHEET_ID = '14YvQPXEqqqnioc5chfAxWqpGe8jnXneYnHq82Vs2iR4';

    // gid de cada pestaña del libro. Junio queda fuera a propósito:
    // la hoja de Junio tiene 53 tareas con nombres distintos al tablero (39),
    // así que sincronizarla lo reemplazaría en vez de actualizarlo.
    var TABS = [
        { key: 'junio',      gid: '0',          prefix: '',  label: 'Junio 2026',      short: 'Jun', hasProgress: false, live: false },
        { key: 'julio',      gid: '265243238',  prefix: 'J', label: 'Julio 2026',      short: 'Jul', hasProgress: false, live: true  },
        { key: 'agosto',     gid: '1881944744', prefix: 'A', label: 'Agosto 2026',     short: 'Ago', hasProgress: false, live: true  },
        { key: 'septiembre', gid: '1054444465', prefix: 'S', label: 'Septiembre 2026', short: 'Sep', hasProgress: true,  live: true  },
        { key: 'octubre',    gid: '1693460820', prefix: 'O', label: 'Octubre 2026',    short: 'Oct', hasProgress: true,  live: true  }
    ];

    // Patrones que nunca deben llegar al sitio público.
    var SENSITIVE = /(usuario\s*:\s*\S|clave\s*:\s*\S|contrase(?:n|ñ)a|password|passwd|token\s*:\s*\S|api[_-]?key|LBMHM\d{4,})/i;
    var REDACTED = 'Información restringida (omitida por seguridad)';

    // ------------------------------------------------------------------ utilidades

    function clean(v) {
        return String(v == null ? '' : v).replace(/\uFEFF/g, '').replace(/\s+/g, ' ').trim();
    }

    // Clave de comparación: sin acentos, entidades HTML ni signos.
    function normKey(v) {
        return clean(v)
            .replace(/&[a-z]+;/gi, ' ')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    function dice(a, b) {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.length < 2 || b.length < 2) return 0;
        var grams = {}, n = 0, i, g;
        for (i = 0; i < a.length - 1; i++) {
            g = a.substr(i, 2);
            grams[g] = (grams[g] || 0) + 1;
            n++;
        }
        var inter = 0;
        for (i = 0; i < b.length - 1; i++) {
            g = b.substr(i, 2);
            if (grams[g]) { grams[g]--; inter++; }
        }
        return (2 * inter) / (n + (b.length - 1));
    }

    // ------------------------------------------------------------------- CSV

    function parseCSV(text) {
        var rows = [], row = [], field = '', inQ = false, i, ch;
        text = String(text || '');
        for (i = 0; i < text.length; i++) {
            ch = text[i];
            if (inQ) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; }
                    else inQ = false;
                } else field += ch;
            } else if (ch === '"') {
                inQ = true;
            } else if (ch === ',') {
                row.push(field); field = '';
            } else if (ch === '\n') {
                row.push(field); rows.push(row); row = []; field = '';
            } else if (ch !== '\r') {
                field += ch;
            }
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter(function (r) {
            return r.some(function (c) { return clean(c) !== ''; });
        });
    }

    function toObjects(rows) {
        if (!rows || rows.length < 2) return [];
        var header = rows[0].map(function (h) { return clean(h); });
        var idx = {};
        header.forEach(function (h, i) { if (!(h in idx)) idx[h] = i; });

        function col(r, names) {
            for (var k = 0; k < names.length; k++) {
                if (idx[names[k]] !== undefined) return clean(r[idx[names[k]]]);
            }
            return '';
        }

        return rows.slice(1).map(function (r) {
            return {
                task: col(r, ['Tarea', 'TAREA', 'Tarea ']),
                priority: col(r, ['Prioridad', 'PRIORIDAD']),
                owner: col(r, ['Propietario', 'PROPIETARIO']),
                status: col(r, ['Estado', 'ESTADO']),
                start: col(r, ['Fecha de inicio', 'Fecha inicio']),
                end: col(r, ['Fecha de finalización', 'Fecha de finalizacion', 'Fecha fin']),
                milestone: col(r, ['Hito', 'HITO']),
                notes: col(r, ['Notas', 'NOTAS']),
                progress: col(r, ['% en curso', '% En curso', '% en Curso'])
            };
        }).filter(function (o) { return o.task; });
    }

    // -------------------------------------------------------- normalizaciones

    function normalizePriority(raw) {
        var s = clean(raw).toLowerCase();
        if (s.indexOf('inmediata') >= 0) return 'Inmediata';
        if (s.indexOf('media') >= 0) return 'Media';
        if (s.indexOf('baja') >= 0) return 'Baja';
        return '';
    }

    function normalizeStatus(raw) {
        var s = clean(raw).toLowerCase();
        if (s.indexOf('complet') >= 0) return 'Completada';
        if (s.indexOf('bloque') >= 0) return 'Bloqueada';
        if (s.indexOf('curso') >= 0 || s.indexOf('proceso') >= 0) return 'En curso';
        if (s.indexOf('iniciad') >= 0 || s.indexOf('pendient') >= 0) return 'No iniciada';
        return '';
    }

    function parseProgress(raw) {
        var s = clean(raw).replace(/%/g, '').replace(',', '.');
        if (!s) return undefined;
        var n = parseFloat(s);
        if (!isFinite(n)) return undefined;
        return Math.max(0, Math.min(100, Math.round(n)));
    }

    // La hoja trae una fecha mal escrita (01/072026). La reparamos;
    // si no se puede, devolvemos null para conservar la que ya existía.
    function fixDate(v) {
        v = clean(v);
        if (!v) return '';
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return v;
        var m = v.match(/^(\d{1,2})\/(\d{2})(\d{4})$/);
        if (m) return m[1] + '/' + m[2] + '/' + m[3];
        return null;
    }

    // Si la hoja trae la celda vacía, se conserva la fecha que ya existía:
    // una celda vacía no es una orden de borrado, es falta de dato.
    function pickDate(v, oldVal) {
        var f = fixDate(v);
        if (f === null || f === '') return (oldVal || '');
        return f;
    }

    function sanitizeText(v) {
        var s = clean(v);
        if (!s) return '';
        if (SENSITIVE.test(s)) return REDACTED;
        return s;
    }

    // La hoja escribe a veces "TILATINBIEN"; el tablero usa "TI LATINBIEN".
    function normalizeOwner(v) {
        var s = clean(v);
        if (!s) return '';
        if (/^ti\s*latin\s*bien$/i.test(s)) return 'TI LATINBIEN';
        return s;
    }

    // ------------------------------------------------------------ categorías

    var CAT_RULES = [
        [/pasarela|ciclo de pago|medio de pago|es promo/, 'Pagos'],
        [/factur|multa|cobr|compromiso|anticipo|tesoro|recibida|cuenta por cobrar|balance|flujo de caja/, 'Cobranza'],
        [/seguridad|firma|arca|credencial|contrase|acceso/, 'Seguridad'],
        [/inventario|motor|moto|veh|repuesto|garant/, 'Motors/Inventario'],
        [/chat|bot|manychat|mensaj/, 'Chatroom'],
        [/crm|win\s*loss|formulario|lead|instagram|facebook|gohlevel/, 'CRM/Integración'],
        [/web|pagina|simulador|catalogo|seo/, 'Web'],
        [/promo|descuento|masivo|campa|marketing/, 'Promociones'],
        [/infra|servidor|correo|red|repetidor|impres|qweb|hora/, 'Infraestructura'],
        [/app|api|ocr|desarrollo|automatiz|integra/, 'Desarrollo'],
        [/tablero|reporte|indicador|proyecci|historico/, 'Reportes']
    ];

    function inferCategory(task) {
        var k = normKey(task), i;
        for (i = 0; i < CAT_RULES.length; i++) {
            if (CAT_RULES[i][0].test(k)) return CAT_RULES[i][1];
        }
        return 'Otros';
    }

    // ---------------------------------------------------------------- merge

    /**
     * Combina las filas de la hoja con las tareas que ya tiene el dashboard.
     * @param {Array} existing  tareas actuales del mes
     * @param {Array} rows      filas CSV (incluye encabezado)
     * @param {Object} opts     { hasProgress: boolean }
     * @returns {Array}         nueva lista de tareas lista para renderizar
     */
    function merge(existing, rows, opts) {
        opts = opts || {};
        var data = toObjects(rows);
        var pool = (existing || []).slice();
        var used = pool.map(function () { return false; });
        var matches = data.map(function () { return null; });
        var i, j;

        // 1) coincidencia exacta por nombre normalizado
        var exact = {};
        for (j = 0; j < pool.length; j++) {
            var k = normKey(pool[j].task);
            if (!(k in exact)) exact[k] = j;
        }
        for (i = 0; i < data.length; i++) {
            var kk = normKey(data[i].task);
            if (kk in exact && !used[exact[kk]]) {
                matches[i] = pool[exact[kk]];
                used[exact[kk]] = true;
            }
        }

        // 2) coincidencia difusa (erratas de la hoja)
        for (i = 0; i < data.length; i++) {
            if (matches[i]) continue;
            var key = normKey(data[i].task), best = -1, score = 0;
            for (j = 0; j < pool.length; j++) {
                if (used[j]) continue;
                var s = dice(key, normKey(pool[j].task));
                if (s > score) { score = s; best = j; }
            }
            if (best >= 0 && score >= 0.8) {
                matches[i] = pool[best];
                used[best] = true;
            }
        }

        // 3) si hay el mismo número de filas, emparejar por posición
        //    (resuelve erratas fuertes como "renovacion aproarca" -> "Renovacion ARCA")
        if (data.length === pool.length) {
            for (i = 0; i < data.length; i++) {
                if (!matches[i] && !used[i]) {
                    matches[i] = pool[i];
                    used[i] = true;
                }
            }
        }

        return data.map(function (row, idx) {
            var old = matches[idx];
            var item = {
                id: idx + 1,
                task: old && old.task ? old.task : sanitizeText(row.task),
                cat: old && old.cat ? old.cat : inferCategory(row.task),
                priority: normalizePriority(row.priority) || (old && old.priority) || 'Media',
                status: normalizeStatus(row.status) || (old && old.status) || 'No iniciada',
                owner: normalizeOwner(row.owner) || normalizeOwner(old && old.owner) || 'TI LATINBIEN',
                start: pickDate(row.start, old && old.start),
                end: pickDate(row.end, old && old.end)
            };

            if (opts.hasProgress) {
                var p = parseProgress(row.progress);
                if (p === undefined && old && old.progress !== undefined) p = old.progress;
                if (p !== undefined) item.progress = p;
            }

            // Hito y notas: se conserva lo curado; solo se rellena si estaba vacío.
            item.milestone = (old && old.milestone) ? old.milestone : sanitizeText(row.milestone);
            item.notes = (old && old.notes) ? old.notes : sanitizeText(row.notes);
            return item;
        });
    }

    // ---------------------------------------------------------------- fetch

    function fetchTab(gid, sheetId) {
        var id = sheetId || SHEET_ID;
        var url = 'https://docs.google.com/spreadsheets/d/' + id +
            '/export?format=csv&gid=' + encodeURIComponent(gid) + '&_=' + Date.now();
        return fetch(url, { cache: 'no-store', redirect: 'follow' }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        }).then(parseCSV);
    }

    function containsSecret(text) {
        return SENSITIVE.test(String(text || ''));
    }

    return {
        SHEET_ID: SHEET_ID,
        TABS: TABS,
        REDACTED: REDACTED,
        parseCSV: parseCSV,
        toObjects: toObjects,
        normalizePriority: normalizePriority,
        normalizeStatus: normalizeStatus,
        parseProgress: parseProgress,
        fixDate: fixDate,
        sanitizeText: sanitizeText,
        normalizeOwner: normalizeOwner,
        inferCategory: inferCategory,
        normKey: normKey,
        dice: dice,
        merge: merge,
        fetchTab: fetchTab,
        containsSecret: containsSecret
    };
});
