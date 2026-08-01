#!/usr/bin/env node
/**
 * build.mjs — genera `_site/`, la directory pubblicabile di Campus Virtual Training XR.
 *
 * Perché esiste
 * -------------
 * `core/` è un submodule READ-ONLY di Novermax/campusvt. Il suo codice usa path
 * relativi alla root (`./js/...`, `css/...`, `scenes/...`) — vedi core/js/app.js
 * loadModules(). Quindi non si può servire da una sottocartella: il sito va
 * "appiattito", con core/ alla radice e il layer `xr/` sovrapposto.
 *
 * Il build fa esattamente tre cose:
 *   1. copia da core/ solo ciò che serve a runtime;
 *   2. sovrappone xr/ e libs-xr/;
 *   3. TRASFORMA core/index.html (non lo duplica) applicando patch dichiarative.
 *
 * Il punto 3 è il motivo per cui non esiste un index.html copiato a mano in questo
 * repo: le modifiche fatte a monte su campusvt continuano ad arrivare da sole.
 *
 * Uso:  node scripts/build.mjs [--lite] [--out <dir>]
 *       --lite   salta gli asset pesanti non ancora usati in XR (media, screens,
 *                menuimages): ~175 MB → ~10 MB, build molto più rapido.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'core');

const args = process.argv.slice(2);
const LITE = args.includes('--lite');
const outIdx = args.indexOf('--out');
const OUT = resolve(ROOT, outIdx !== -1 ? args[outIdx + 1] : '_site');

/** Asset di core/ necessari a runtime. Tutto il resto (docs, pptx, electron,
 *  scorm_tutorials, tools, host-portatile, node_modules) NON viene pubblicato. */
const CORE_ASSETS = [
    { path: 'js',                heavy: false },
    { path: 'css',               heavy: false },
    { path: 'libs',              heavy: false },
    { path: 'scenes',            heavy: false },
    { path: 'cursors',           heavy: false },
    { path: 'utilimages',        heavy: false },
    { path: 'assembly_configs',  heavy: false },
    { path: 'models',            heavy: false }, // solo texture; i .glb arrivano dal Worker
    { path: 'users.txt',         heavy: false },
    { path: 'interfaceconfig.ini', heavy: false },
    { path: 'information.png',   heavy: false },
    { path: 'newlogo.png',       heavy: false },
    { path: 'menuimages',        heavy: true },  // card scenari home (~30 MB)
    { path: 'screens',           heavy: true },  // frame AnimatedWindowSystem (~62 MB)
    { path: 'media',             heavy: true },  // video/immagini modali (~83 MB)
];

/* NON pubblicati di proposito:
 *   core/facce/  — cubemap skybox, 41 MB di PNG, non referenziata da alcun file di
 *                  core (grep su js/ css/ index.html scenes/ → 0 risultati). In VR uno
 *                  skybox servirebbe eccome, ma non a 41 MB: va prima convertito in
 *                  KTX2/equirect compresso dalla pipeline asset (Milestone 2).
 *   core/docs|build|dist|host-portatile|tools|scorm_tutorials|node_modules — fuori runtime.
 */

/** Overlay del layer XR: sovrascrive/aggiunge sopra i file di core. */
const XR_OVERLAY = ['xr', 'libs-xr'];

// ---------------------------------------------------------------------------
// Trasformazioni su core/index.html
// ---------------------------------------------------------------------------

/** Moduli di core esclusi dalla build XR (vedi piano §B7). Restano nel desktop. */
const DROP_SCRIPT_PATTERNS = [
    /^js\/editor\//,   // editor scenari: solo admin, non portato in XR
    /^js\/scorm\//,    // tracking SCORM: fuori scope XR
];
const DROP_STYLE_PATTERNS = [/^css\/editor\.css/];

const XR_STYLES = ['xr/xr.css'];
// XRButton e XRInput prima di XRSession: quest'ultimo li usa a init e a sessione avviata.
const XR_SCRIPTS = ['xr/XRButton.js', 'xr/XRInput.js', 'xr/XRSession.js'];

function transformIndexHtml(html) {
    const report = { droppedScripts: [], droppedStyles: [], injected: [] };

    // 1. Rimuove gli <script src="..."> dei moduli non portati.
    html = html.replace(/[ \t]*<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>\s*\n?/g, (m, src) => {
        const clean = src.replace(/^\.\//, '').split('?')[0];
        if (DROP_SCRIPT_PATTERNS.some((re) => re.test(clean))) {
            report.droppedScripts.push(clean);
            return '';
        }
        return m;
    });

    // 2. Rimuove i <link rel=stylesheet> non necessari.
    html = html.replace(/[ \t]*<link\b[^>]*\bhref="([^"]+)"[^>]*>\s*\n?/g, (m, href) => {
        const clean = href.replace(/^\.\//, '').split('?')[0];
        if (m.includes('stylesheet') && DROP_STYLE_PATTERNS.some((re) => re.test(clean))) {
            report.droppedStyles.push(clean);
            return '';
        }
        return m;
    });

    // 3. Inietta il CSS XR prima di </head>.
    const styleTags = XR_STYLES.map((h) => `    <link rel="stylesheet" href="${h}">`).join('\n');
    if (!html.includes('</head>')) throw new Error('index.html: </head> non trovato');
    html = html.replace('</head>', `\n    <!-- === CVT-XR: stili layer WebXR === -->\n${styleTags}\n</head>`);
    report.injected.push(...XR_STYLES);

    // 4. Inietta gli script XR in coda al body. Devono girare DOPO i moduli di
    //    core: si agganciano comunque all'evento `app:initialized` (core/js/app.js:570),
    //    quindi l'ordine esatto rispetto a js/app.js (type=module, async) è indifferente.
    const scriptTags = XR_SCRIPTS.map((s) => `    <script src="${s}"></script>`).join('\n');
    if (!html.includes('</body>')) throw new Error('index.html: </body> non trovato');
    html = html.replace('</body>', `\n    <!-- === CVT-XR: layer WebXR === -->\n${scriptTags}\n</body>`);
    report.injected.push(...XR_SCRIPTS);

    // 5. Titolo, per distinguere la scheda dalla versione standard.
    html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>Campus Virtual Training — WebXR</title>');

    return { html, report };
}

// ---------------------------------------------------------------------------

async function dirSize(p) {
    let total = 0;
    const st = await stat(p);
    if (!st.isDirectory()) return st.size;
    for (const e of await readdir(p, { withFileTypes: true })) {
        total += await dirSize(join(p, e.name));
    }
    return total;
}

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;

async function main() {
    if (!existsSync(join(CORE, 'index.html'))) {
        console.error('\n❌ Submodule `core/` non inizializzato.');
        console.error('   Esegui:  git submodule update --init --depth 1\n');
        process.exit(1);
    }

    console.log(`\n🏗️  Build CVT-XR${LITE ? ' (lite)' : ''} → ${OUT}\n`);

    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });

    // --- 1. asset da core/ ---
    let copied = 0;
    for (const { path: p, heavy } of CORE_ASSETS) {
        const src = join(CORE, p);
        if (!existsSync(src)) {
            console.warn(`   ⚠️  core/${p} assente — saltato`);
            continue;
        }
        if (LITE && heavy) {
            console.log(`   ⏭️  core/${p} saltato (--lite)`);
            continue;
        }
        await cp(src, join(OUT, p), { recursive: true });
        const size = await dirSize(src);
        copied += size;
        console.log(`   ✓ core/${p.padEnd(20)} ${mb(size).padStart(10)}`);
    }

    // --- 2. overlay XR ---
    for (const p of XR_OVERLAY) {
        const src = join(ROOT, p);
        if (!existsSync(src)) continue;
        await cp(src, join(OUT, p), { recursive: true });
        const size = await dirSize(src);
        copied += size;
        console.log(`   ✓ ${p.padEnd(25)} ${mb(size).padStart(10)}`);
    }

    // --- 3. index.html trasformato ---
    const original = await readFile(join(CORE, 'index.html'), 'utf8');
    const { html, report } = transformIndexHtml(original);
    await writeFile(join(OUT, 'index.html'), html, 'utf8');

    // GitHub Pages: evita che Jekyll ignori file/cartelle che iniziano con _
    await writeFile(join(OUT, '.nojekyll'), '', 'utf8');

    console.log(`\n   index.html trasformato:`);
    console.log(`     − ${report.droppedScripts.length} script rimossi (${[...new Set(report.droppedScripts.map((s) => s.split('/').slice(0, 2).join('/')))].join(', ') || 'nessuno'})`);
    console.log(`     − ${report.droppedStyles.length} stili rimossi`);
    console.log(`     + ${report.injected.length} risorse XR iniettate`);

    console.log(`\n✅ Build completata — ${mb(await dirSize(OUT))} totali\n`);
    // --directory invece di `cd _site`: se la cwd del server sta dentro _site,
    // su Windows il rebuild successivo fallisce con EBUSY sulla rmdir.
    console.log(`   Serve in locale:  python -m http.server 8000 --directory _site`);
    console.log(`   Poi apri:         http://localhost:8000\n`);
}

main().catch((err) => {
    console.error('\n❌ Build fallita:', err.message, '\n');
    process.exit(1);
});
