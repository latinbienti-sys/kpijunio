#!/usr/bin/env node
/*
 * sync-sheet.js — Actualiza los datos incrustados en index.html desde el Google Sheet.
 *
 * Uso:
 *   node sync-sheet.js            # muestra qué cambiaría (no escribe)
 *   node sync-sheet.js --write    # aplica los cambios
 *
 * El dashboard además sincroniza en vivo desde el navegador; este script sirve
 * para dejar el HTML estático al día (respaldo sin conexión y respaldo en git).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SheetSync = require('./sheet-sync.js');

const HTML_PATH = path.join(__dirname, 'index.html');
const WRITE = process.argv.includes('--write');

const ARRAYS = {
    junio: 'tasks',
    julio: 'tasksJulio',
    agosto: 'tasksAgosto',
    septiembre: 'tasksSeptiembre',
    octubre: 'tasksOctubre'
};

function readArray(html, name) {
    const start = html.indexOf('const ' + name + ' = [');
    if (start < 0) throw new Error('No se encontró const ' + name);
    const end = html.indexOf('\n];', start);
    if (end < 0) throw new Error('No se encontró el cierre de ' + name);
    const block = html.slice(start + ('const ' + name + ' = ').length, end + 2);
    return { start, end: end + 3, items: new Function('return ' + block)() };
}

function jsVal(v) {
    if (typeof v === 'number') return String(v);
    return JSON.stringify(String(v)).replace(/<\//g, '<\\/');
}

function serialize(name, items, eol) {
    const nl = eol || '\n';
    const keys = ['id', 'task', 'cat', 'priority', 'status', 'owner', 'start', 'end', 'progress', 'milestone', 'notes'];
    const lines = items.map(function (t) {
        const parts = keys
            .filter(function (k) { return t[k] !== undefined; })
            .map(function (k) { return k + ':' + jsVal(t[k]); });
        return '    {' + parts.join(', ') + '}';
    });
    return 'const ' + name + ' = [' + nl + lines.join(',' + nl) + nl + '];';
}

function short(v) { return v === '' || v === undefined ? '∅' : String(v); }

function occurrenceMap(list) {
    const counts = {};
    const out = {};
    list.forEach(function (t) {
        const k = SheetSync.normKey(t.task);
        counts[k] = (counts[k] || 0) + 1;
        out[k + '#' + counts[k]] = t;
    });
    return out;
}

function summarize(tabKey, before, after) {
    const changes = [];
    const byOld = occurrenceMap(before);
    const seen = {};
    const counts = {};
    after.forEach(function (t) {
        const k = SheetSync.normKey(t.task);
        counts[k] = (counts[k] || 0) + 1;
        const key = k + '#' + counts[k];
        const old = byOld[key];
        if (!old) { changes.push('  + nueva: ' + t.task); return; }
        seen[key] = true;
        ['priority', 'status', 'start', 'end', 'progress', 'owner'].forEach(function (f) {
            if (short(old[f]) !== short(t[f])) {
                changes.push('  ~ ' + t.task + ' · ' + f + ': ' + short(old[f]) + ' → ' + short(t[f]));
            }
        });
        if ((old.milestone || '') !== (t.milestone || '')) changes.push('  ~ ' + t.task + ' · hito actualizado');
        if ((old.notes || '') !== (t.notes || '')) changes.push('  ~ ' + t.task + ' · notas actualizadas');
    });
    Object.keys(byOld).forEach(function (key) {
        if (!seen[key]) changes.push('  - sale: ' + byOld[key].task);
    });
    console.log('\n== ' + tabKey.toUpperCase() + ' == ' + before.length + ' → ' + after.length + ' tareas');
    if (!changes.length) console.log('  sin cambios');
    else changes.slice(0, 40).forEach(function (c) { console.log(c); });
    if (changes.length > 40) console.log('  … y ' + (changes.length - 40) + ' más');
    return changes.length;
}

(async function main() {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const EOL = html.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    const liveTabs = SheetSync.TABS.filter(function (t) { return t.live; });
    const results = [];

    for (const tab of liveTabs) {
        const name = ARRAYS[tab.key];
        const current = readArray(html, name);
        let rows;
        try {
            rows = await SheetSync.fetchTab(tab.gid);
        } catch (err) {
            console.error('ERROR al leer ' + tab.key + ': ' + err.message);
            process.exitCode = 1;
            continue;
        }
        const merged = SheetSync.merge(current.items, rows, { hasProgress: tab.hasProgress });
        if (!merged.length) throw new Error('La hoja ' + tab.key + ' llegó vacía; se aborta');
        if (merged.some(function (t) { return SheetSync.containsSecret(t.task + ' ' + t.milestone + ' ' + t.notes); })) {
            throw new Error('Se detectó una credencial en ' + tab.key + '; se aborta');
        }
        const changed = summarize(tab.key, current.items, merged);
        results.push({ tab: tab.key, name: name, block: serialize(name, merged, EOL), count: merged.length, changed: changed });
    }

    if (!results.length) {
        console.error('No se pudo sincronizar ninguna pestaña.');
        return;
    }

    // Reemplazar de atrás hacia adelante para no invalidar los índices.
    let updated = html;
    const edits = results.map(function (r) {
        const cur = readArray(html, r.name);
        return { start: cur.start, end: cur.end, block: r.block };
    }).sort(function (a, b) { return b.start - a.start; });
    edits.forEach(function (e) {
        updated = updated.slice(0, e.start) + e.block + updated.slice(e.end);
    });

    // ------------------------- validaciones -------------------------
    const scriptStart = updated.indexOf('<script>');
    const scriptEnd = updated.lastIndexOf('</script>');
    const js = updated.slice(scriptStart + 8, scriptEnd);
    const tmp = path.join(require('os').tmpdir(), 'kpijunio_sync_check.js');
    fs.writeFileSync(tmp, 'const Chart=function(){};const document={getElementById:()=>({}),querySelectorAll:()=>[],querySelector:()=>({})};' + js);
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, ['--check', tmp]);
    const divs = function (s) { return (s.match(/<div/g) || []).length + '/' + (s.match(/<\/div>/g) || []).length; };

    // Solo deben cambiar los bloques de datos.
    let maskedBefore = html, maskedAfter = updated;
    results.forEach(function (r) {
        const a = maskedBefore.indexOf('const ' + r.name + ' = [');
        const b = maskedBefore.indexOf('\n];', a);
        maskedBefore = maskedBefore.slice(0, a) + '/*DATA*/' + maskedBefore.slice(b + 3);
        const c = maskedAfter.indexOf('const ' + r.name + ' = [');
        const d = maskedAfter.indexOf('\n];', c);
        maskedAfter = maskedAfter.slice(0, c) + '/*DATA*/' + maskedAfter.slice(d + 3);
    });

    console.log('\n--- validación ---');
    console.log('sintaxis JS: OK');
    console.log('divs antes/después:', divs(html), '→', divs(updated));
    console.log('solo cambian bloques de datos:', maskedBefore === maskedAfter ? 'SÍ' : 'NO');

    if (SheetSync.containsSecret(updated)) {
        throw new Error('El HTML resultante contiene una credencial; se aborta');
    }
    console.log('credenciales en el HTML: ninguna');

    if (!WRITE) {
        console.log('\n(modo ensayo: no se escribió nada. Usa --write para aplicar)');
        return;
    }
    if (maskedBefore !== maskedAfter) throw new Error('Se modificó algo fuera de los datos; se aborta');
    fs.writeFileSync(HTML_PATH, updated, 'utf8');
    console.log('\nindex.html actualizado.');
})().catch(function (err) {
    console.error('\nABORTADO: ' + err.message);
    process.exitCode = 1;
});
