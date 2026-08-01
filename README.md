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
│   ├── XRSession.js           sonda capability, sessione immersiva, XRRig, loop
│   ├── XRInput.js             pressione a contatto col dito
│   ├── XRLocomotion.js        teleport e rotazione a scatti
│   ├── XRButton.js            pulsante entra/esci VR, scala, altezza
│   └── xr.css
├── libs-xr/hands/             modelli di mano W3C, vendorizzati (vedi NOTICE.md)
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

### Entrare in VR

Il pulsante **🥽 Entra in VR** compare in basso al centro, ma solo dentro uno
scenario: prima non esiste ancora una scena 3D da mostrare. Sul desktop appare
disabilitato, con il motivo nel tooltip.

Entrando, il rig viene posizionato dove stava la camera desktop, proiettata a
terra e con lo stesso orientamento orizzontale — quindi si entra esattamente
nell'inquadratura dello step corrente. Uscendo, la camera desktop è ripristinata
identica.

Stato in qualunque momento: `XRSession.debugInfo()` dalla console.

#### Premere: contatto col dito

**I comandi si premono toccandoli**, non puntandoli. Il polpastrello dell'indice
entra nel volume del pulsante e il pulsante scatta: nessun pinch, nessun trigger
— premere è un gesto, non un comando. Con i controller, al posto del dito vale
la punta del controller.

Il raggio **non preme nulla**: serve solo a mirare il pavimento per il teleport.

**Le mani le disegna l'applicazione**, non il visore: in `immersive-vr` il
compositore non mostra nulla, il rendering è tutto a carico della pagina.

Sono mesh skinnate vere, dal profilo `generic-hand` di WebXR Input Profiles,
**vendorizzate in `libs-xr/hands/`** invece di essere scaricate da un CDN come
farebbe `XRHandModelFactory` — vedi `libs-xr/hands/NOTICE.md` per fonte e
licenza. Le 25 ossa portano esattamente i nomi dei giunti WebXR e sono tutte
figlie dirette di `Armature`, che è a identità: la posa di ogni giunto si copia
sull'osso omonimo, senza composizioni.

Se il modello non è ancora arrivato, o se il caricamento fallisce, restano delle
sferette sui giunti in una `InstancedMesh` — una sola draw call, tutto
procedurale. Meglio una mano approssimativa che nessuna mano.

In entrambi i casi la mano vive dentro il rig, quindi scala col mondo
esattamente come la testa.

Una sfera più piccola appare sulla punta del dito quando c'è un bersaglio
a portata, e cresce avvicinandosi; lampeggia bianca al contatto. Compare solo
entro 12 cm: più larga, con i molti comandi ravvicinati del pulpito, resterebbe
accesa di continuo. Il lampo non è ridondante rispetto alla vibrazione — con le
mani l'aptica non esiste.

Tolleranza di contatto 2,2 cm, con uscita a 4 cm: senza isteresi un dito che
trema a filo del bordo farebbe scattare il pulsante decine di volte al secondo.
Tarabile a caldo con `XRInput.setPokeRadius(0.03)`.

`XRInput.debugInfo()` riporta, per ciascuna sorgente, se è una mano o un
controller, cosa ha vicino e cosa sta premendo.

#### Spostarsi: teleport

Serve perché l'interazione è a contatto: se non si punta più da lontano, bisogna
potersi avvicinare. Misurato sul tutorial Elettromandrino, **6 elementi su 21**
stanno a ~1,20 m dalla spalla, fuori dalla portata del braccio.

| Comando | Controller | Mani |
|---|---|---|
| Teleport | mira a terra, poi trigger | mira a terra, poi pinch |
| Rotazione a scatti (30°) | thumbstick destro, orizzontale | — girati fisicamente |
| Scala del mondo | thumbstick destro, verticale | slider 2D |

Il raggio diventa **verde** e appare un anello quando la destinazione è valida.
Una mano vicina a un comando smette di mirare, così non ci si teleporta mentre
si preme. Il teleport cambia solo X e Z: la Y porta la calibrazione dell'altezza
occhi e resta intatta.

Il bersaglio è il **piano y=0**, non la geometria: `pavimento.glb` è una cupola
da 519 × 220 × 220 m, e intersecarla darebbe punti ovunque tranne che a terra.

Stato: `XRLocomotion.debugInfo()`.

L'ordine di priorità replica quello del desktop (`handleModelClick`): figlio
interattivo, poi ripiego sui pulsanti evidenziati, poi azione sul modello radice.
Il ripiego conta: con un puntatore laser i bersagli piccoli come
`pulpito.Pulsante_mdi` sarebbero altrimenti quasi impossibili da colpire.

Stato: `XRInput.debugInfo()`.

#### Scala del mondo

I modelli sono in scala reale — `a500.glb` è alto 2,80 m, `pulpito.glb` 1,27 m —
e nessuno viene riscalato al caricamento. Se però la macchina appare
miniaturizzata rispetto a come la si percepisce dal vero, il rapporto fra
operatore e macchina va corretto.

La correzione si applica al **rig**, non ai modelli: scalare i modelli
romperebbe le posizioni e le animazioni scritte nei tutorial e cambierebbe anche
la vista desktop. Scalando il rig si tocca solo l'osservatore — posa della testa
e distanza interpupillare — e il mondo appare più grande in proporzione.

`rig.scale = 1 / scalaMondo`. Il **default è 1,25**, tarato sul Quest 3 con lo
scenario Elettromandrino: gli occhi stanno a 1,75 / 1,25 = 1,40 unità contro una
macchina di 2,80, come davanti a una macchina reale di 3,50 m.

> Se 3,50 m è la quota reale della a500, la correzione andrebbe prima o poi fatta
> a monte sui modelli invece di compensarla qui sull'osservatore.

Si regola con lo slider accanto al pulsante VR, oppure **dal vivo dentro la
sessione col thumbstick destro su/giù** — che è il modo pratico per trovare il
valore giusto, senza uscire e rientrare a ogni tentativo. Una tacca aptica ogni
0,1 dà il senso della granularità. Il valore raggiunto è persistito e lo slider
lo rispecchia all'uscita.

Da console: `XRSession.setWorldScale(1.3)`.

> La lettura del thumbstick **non** è il layer di input della milestone 3: legge
> un solo asse, per la taratura.

#### Altezza dell'operatore

I modelli sono in scala reale — `a500.glb` è alto 2,80 m, `pulpito.glb` 1,27 m —
quindi con `local-floor` l'altezza di default è già corretta. Il selettore
**Altezza occhi** accanto al pulsante serve comunque per due casi concreti:

- la calibrazione del pavimento del Guardian è imprecisa (fatta da seduti o su
  una superficie rialzata: y=0 finisce troppo in alto e ci si sente giganti);
- in un training si vuole che tutti vedano la macchina dalla stessa altezza,
  a prescindere dalla statura.

L'altezza non è imponibile a priori: quella reale la dà solo la posa del visore.
Il layer campiona quindi i primi 20 frame, ne prende la **mediana** (così uno
scatto anomalo non falsa la misura) e sposta il rig una volta sola. La scelta è
persistita in `localStorage`, quindi si imposta una volta e resta.

Da console: `XRSession.setEyeHeight(1.70)` oppure `XRSession.setEyeHeight(null)`
per tornare alla statura reale.

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

### Pipeline asset: rimandata, non annullata

Misurato sui GLB dichiarati in `core/scenes/homeconfig.ini`:

| Scenario | Modelli | Triangoli | Draw call | GLB |
|---|---|---|---|---|
| Manutenzione Elettromandrino | 4 | 892.238 | 110 | 25,4 MB |
| Manutenzione pompa del vuoto | 34 | 2.096.642 | 188 | 137,2 MB |

La pipeline era pianificata come **gate** prima di scrivere input e UI, sul
presupposto di un budget di ~300–500k triangoli per frame. **Provato sul Quest 3,
Elettromandrino gira fluido con 892k senza alcuna ottimizzazione**: quella soglia
era tarata su linee guida più vecchie, e l'XR2 Gen 2 regge molto meglio.

Il gate è quindi passato senza fare il lavoro, e ottimizzare adesso significherebbe
sistemare qualcosa che non è rotto. La pipeline resta necessaria per **Pompa
Becker** — 2,1M triangoli e 137 MB, con un errore per esaurimento memoria in VR già
previsto in `core/js/modelloader.js:270` — e va affrontata prima di quello
scenario, o al primo calo di frame rate misurato.

---

## Stato

| # | Milestone | Stato |
|---|---|---|
| 0 | Setup: repo, submodule, build, deploy Pages | ✅ fatto |
| 1 | Sessione XR: `renderer.xr`, `setAnimationLoop`, XRRig | ✅ fatto |
| 3 | Input: pressione a contatto col dito | ✅ fatto |
| 7 | Locomozione: teleport, rotazione a scatti | ✅ fatto (anticipata: il poke la richiede) |
| 4 | UI in-world — in `immersive-vr` il DOM è invisibile | ⏳ prossima |
| 2 | Pipeline asset | ⏸️ **rimandata** — vedi sotto |
| 4 | UI in-world (il DOM è invisibile in `immersive-vr`) | ⏳ |
| 5 | Utensili agganciati al controller + particelle | ⏳ |
| 6 | Grab & snap col grip | ⏳ |
| 7 | Locomozione: teleport alle postazioni da `CameraPos` | ⏳ |
| 8 | Secondo scenario (Pompa Becker) | ⏳ |

Scenario pilota: **Manutenzione Elettromandrino**.
Analisi e architettura complete: vedi il piano allegato alla issue di setup.
