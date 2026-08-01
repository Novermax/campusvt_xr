# Campus Virtual Training — WebXR

Accesso WebXR separato a Campus Virtual Training, destinato al **Meta Quest 3**.

| | |
|---|---|
| Versione standard | <https://novermax.github.io/campusvt/> — **non modificata da questo repo** |
| Versione WebXR | <https://novermax.github.io/campusvt_xr/> |

> **Regola non negoziabile: questo repo non modifica mai `Novermax/campusvt`.**
> `core/` è un submodule in sola lettura, pinnato a un commit preciso. Tutto il
> codice XR vive in `xr/` e avvolge dall'esterno i singleton `window.*` di CVT.

---

## Come funziona

CVT è ~51.500 righe di JavaScript in cui **ogni modulo è un singleton su `window`**
(`Scene3D`, `UI`, `InteractiveObject3D`, `StepController`, …). Uno script caricato
*dopo* può quindi sostituire o avvolgere qualunque metodo senza toccare il codice a
monte. È esattamente la strategia che `core/js/touch/` usa già per affiancare
l'input touch a quello mouse.

Il layer `xr/` è l'analogo diretto: cambia solo **da dove nasce il ray** (controller
invece che mouse+camera) e ridispatcha nella stessa API basata su mesh:

```js
window.InteractiveObject3D.handleClick(mesh, opts);
window.Scene3D.handleModelAction(rootModel, opts);
window.StepController.triggerStep('physical', triggerId);
window.UI.nextStep();
```

Il codice di `core/` usa path relativi alla root (`./js/…`, `css/…`, `scenes/…`),
quindi non può essere servito da una sottocartella. `scripts/build.mjs` **appiattisce**
`core/` nella root di `_site/` e ci sovrappone `xr/`.

`core/index.html` **non è duplicato**: il build lo trasforma applicando patch
dichiarative (rimuove editor e SCORM, inietta CSS/JS XR). Le modifiche fatte a monte
su campusvt continuano così ad arrivare da sole.

---

## Struttura

```
campusvt_xr/
├── core/                      submodule → Novermax/campusvt (READ-ONLY, shallow)
├── xr/                        layer WebXR — l'unico codice applicativo di questo repo
│   ├── XRSession.js           bootstrap + sonda capability
│   └── xr.css
├── libs-xr/                   (Milestone 2) KTX2Loader, MeshoptDecoder
├── assets-xr/pipeline/        (Milestone 2) gltf-transform → models-xr/
├── scripts/build.mjs          appiattisce core/ + overlay xr/ → _site/
├── .github/workflows/pages.yml
└── _site/                     output del build (git-ignored)
```

---

## Sviluppo locale

```bash
git clone --recurse-submodules https://github.com/Novermax/campusvt_xr.git
cd campusvt_xr

# se hai già clonato senza submodule:
git submodule update --init --depth 1

node scripts/build.mjs --lite     # ~6 MB, salta media/screens/menuimages
python -m http.server 8000 --directory _site
```

> Usa `--directory` invece di `cd _site`: se la cwd del server sta dentro `_site`,
> su Windows il rebuild successivo fallisce con `EBUSY`.

Poi <http://localhost:8000>. `--lite` velocizza il ciclo di sviluppo; ometti il flag
per una build identica a quella pubblicata (~180 MB).

WebXR richiede un **contesto sicuro**: `localhost` va bene, un IP di rete locale in
HTTP no. Per provare dal visore usa la GitHub Pages (HTTPS) oppure il port forwarding
ADB (`adb reverse tcp:8000 tcp:8000`), che fa vedere al Quest il tuo `localhost`.

### Test senza visore

Estensione Chrome **WebXR API Emulator** → emula Quest 3 e i controller.

### Test sul Quest 3

1. Modalità sviluppatore attiva sul visore, collegato via USB.
2. `adb devices` per confermare la connessione.
3. Meta Quest Browser → URL del sito.
4. Console e log: `chrome://inspect` dal PC.
5. FPS e draw call: **Performance HUD** di Meta Quest Developer Hub.

---

## Aggiornare `core/`

Il pin è deliberato: un refactor a monte non deve rompere la XR a sorpresa.

```bash
git submodule update --remote --depth 1 core
node scripts/build.mjs --lite      # verifica che il build regga
git add core && git commit -m "chore: aggiorna pin core/ a <sha>"
```

Se il fetch shallow fallisce perché il SHA pinnato non è più il tip del branch,
aumenta la profondità: `git -C core fetch --depth 50`.

---

## Asset 3D

I `.glb` **non sono in nessuno dei due repository**: `core/js/fetchFile.js` li
instrada a un Cloudflare Worker autenticato. Poiché `campusvt` e `campusvt_xr`
sono **same-origin** (`novermax.github.io`), il Worker funziona già per questo
sito senza modifiche alla sua configurazione CORS.

Dalla Milestone 2 la versione XR userà un set separato di modelli ottimizzati
(`models-xr/`), lasciando `models/` invariato per la versione standard. Il routing
si ottiene sovrascrivendo `window.MODELS_WORKER_BASE` **prima** che venga caricato
`core/js/fetchFile.js` — nessuna modifica al file a monte.

### Perché serve la pipeline asset

Misurato sui GLB dichiarati in `core/scenes/homeconfig.ini`:

| Scenario | Modelli | Triangoli | Draw call | GLB |
|---|---|---|---|---|
| Manutenzione Elettromandrino | 4 | 892.238 | 110 | 25,4 MB |
| Manutenzione pompa del vuoto | 34 | 2.096.642 | 188 | 137,2 MB |

Budget realistico WebXR su Quest 3: ~300–500k triangoli/frame (rendering stereo),
~100–200 draw call, 72 Hz. Il secondo scenario è ~4-5× oltre budget e oggi non parte
sul visore — `core/js/modelloader.js:270` ha già un messaggio d'errore dedicato
all'esaurimento memoria in VR.

---

## Stato

| # | Milestone | Stato |
|---|---|---|
| 0 | Setup: repo, submodule, build, deploy Pages | ✅ fatto |
| 1 | Sessione XR: `renderer.xr`, `setAnimationLoop`, XRRig | ⏳ prossima |
| 2 | Pipeline asset → 72 Hz sullo scenario pilota | ⏳ **gate** |
| 3 | Input: ray dai controller, highlight | ⏳ |
| 4 | UI in-world (il DOM è invisibile in `immersive-vr`) | ⏳ |
| 5 | Utensili agganciati al controller + particelle | ⏳ |
| 6 | Grab & snap col grip | ⏳ |
| 7 | Locomozione: teleport alle postazioni da `CameraPos` | ⏳ |
| 8 | Secondo scenario (Pompa Becker) | ⏳ |

Scenario pilota: **Manutenzione Elettromandrino**.
Analisi e architettura complete: vedi il piano allegato alla issue di setup.
