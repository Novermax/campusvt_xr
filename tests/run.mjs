#!/usr/bin/env node
/**
 * run.mjs — lancia tutte le prove del layer XR.
 *
 *     node tests/run.mjs
 *
 * Le prove girano **senza visore**: caricano i moduli veri di `xr/` dentro stub
 * di `window`, `document` e Three, e verificano la logica con pose simulate.
 * È l'unico modo di controllare qualcosa in automatico — dentro una sessione
 * immersiva la tab resta `hidden`, rAF è congelato e nessun frame gira, quindi
 * il comportamento vero va comunque provato sul Quest.
 *
 * Cosa si può verificare qui: soglie e distanze di attivazione, continuità
 * dell'attrazione, isteresi, dispatch verso `core/`, posizionamento dei
 * pannelli, disambiguazione fra teleport e interfaccia, vincoli
 * dell'impugnatura. Cosa no: fluidità, resa, comfort.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('-test.mjs')).sort();

let failed = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, [join(here, f)], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = (out.match(/^OK/gm) || []).length;
    const ko = (out.match(/^FAIL/gm) || []).length;
    if (r.status !== 0 || ko) {
        failed += ko || 1;
        console.log(`\n❌ ${f} — ${ko} fallite su ${ok + ko}`);
        out.split('\n').filter((l) => l.startsWith('FAIL') || l.includes('Error')).forEach((l) => console.log('   ' + l));
    } else {
        console.log(`✅ ${f.padEnd(22)} ${ok} controlli`);
    }
}

console.log(failed ? `\n${failed} PROVE FALLITE` : '\nTutte le prove passate');
process.exit(failed ? 1 : 0);
