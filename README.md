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
window.ToolsManager.toggleTool(id);
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
│   ├── XRUI.js                fumetto e pulsante del tutorial, in-world
│   ├── XRHall.js              la home come luogo: scelta scenari in-world
│   ├── XRCover.js             copertina d'ingresso (il gesto per la user activation)
│   ├── XRLocomotion.js        teleport e rotazione a scatti
│   ├── XRButton.js            pulsante entra/esci VR, scala, altezza
│   └── xr.css
├── libs-xr/hands/             modelli di mano W3C, vendorizzati (vedi NOTICE.md)
├── assets-xr/pipeline/        (Milestone 2) gltf-transform → models-xr/
├── tests/                     prove deterministiche, senza visore
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

```bash
node tests/run.mjs
```

Le prove caricano i moduli veri di `xr/` dentro stub di `window`, `document` e
Three, e verificano la logica con pose simulate. Si controllano soglie e distanze
di attivazione, continuità dell'attrazione, isteresi, dispatch verso `core/`,
posizionamento dei pannelli, disambiguazione fra teleport e interfaccia, vincoli
dell'impugnatura.

Quello che **non** si può controllare così: fluidità, resa, comfort. Dentro una
sessione immersiva la tab resta `hidden`, rAF è congelato e nessun frame gira,
quindi il comportamento vero va comunque provato sul Quest — un incremento alla
volta, leggendo il riepilogo di `📋 Log XR`.

Estensione Chrome **WebXR API Emulator** → emula Quest 3 e i controller.

### Entrare in VR

Il flusso è **una schermata sola e poi il mondo**:

```
apertura sito → copertina con utente/password/ENTRA
              → autenticazione (users.txt) + lingua del profilo
              → sessione immersiva
              → Home VR → scelta scenario → scenario
```

Non c'è una pagina "Home" 2D con dentro un pulsante per la VR: dopo ENTRA si è
già in VR, e la Home *è* una scena. Il pulsante **🥽 Entra in VR** resta in basso
al centro come ripiego, per il desktop e per il caso in cui l'ingresso automatico
non riesca.

**Il gesto è uno solo, e serve.** `requestSession` pretende una *user
activation*: un tocco vero e recente, altrimenti viene rifiutata — regola dei
browser, non scelta nostra. Il tocco qui è la pressione di ENTRA, e in mezzo
`core/` fa una cosa sola, leggere `users.txt` e confrontare le credenziali, che
su file locale dura millisecondi. È anche il motivo per cui il login sta *dentro*
la copertina invece che dopo: con due schermate, il gesto che conclude il login
sarebbe l'ultimo della pagina e da lì bisognerebbe chiederne un altro.

**La scena esiste prima del login.** `core/` chiama `Scene3D.init()` solo
all'apertura della pagina scenario; il layer lo anticipa (`XRSession._initScene`)
mentre l'utente digita le credenziali — tempo morto, ed è esattamente quanto
serve. Costruire un renderer *dopo* il click brucerebbe la finestra di
attivazione. Non serve che la pagina scenario sia visibile: `Scene3D.init()` legge
`#canvas3d` dal DOM — che esiste anche dentro un contenitore `hidden` — e
dimensiona il renderer su `window.innerWidth`, non sul canvas. `core/` non è
toccato: `PageManager.onScenarioPageShown` inizializza solo `if (!Scene3D.scene)`,
e trovandola già pronta la lascia stare.

**Se l'ingresso automatico non riesce non è un errore**: fuori dal visore è il
caso normale. Si resta sulla home 2D col pulsante 🥽, cioè il comportamento di
prima. Nessuna strada viene chiusa.

### La lingua non si sceglie due volte

Sta nel profilo — `users.txt`, campo 4: `utente;password;scadenza;lingua;ruolo` —
e `core/` la mette in `currentUser.language` al login, poi ricarica
`homeconfig_<lingua>.ini`. Nomi e descrizioni degli scenari arrivano quindi già
tradotti anche alla hall, che legge la stessa configurazione. Le uniche due frasi
sue («Scegli uno scenario», «Caricamento scenari…») sono tradotte in `XRHall.js`
per `it`, `eng`, `fra`, `deu`; una lingua sconosciuta ricade sull'italiano, che è
la lingua della configurazione di default.

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

##### Il segno di contatto, e perché non si può togliere del tutto

Tre modi, dal selettore *Segno di contatto* sulla barra 2D o con
`XRInput.setCursorMode('sfera' | 'punto' | 'niente')`; la scelta è ricordata.

Togliendolo del tutto **non si riesce più a premere** — provato sul visore. Non
perché manchi qualcosa alla logica: il contatto continua a essere calcolato
identico, e le prove lo confermano in tutti e tre i modi. Il motivo è che la
pallina è **l'unica cosa disegnata con `depthTest: false`**.

La mano è una mesh normale. Quando il polpastrello arriva a un centimetro da un
pulsante — e a maggior ragione quando lo attraversa — viene coperto dalla lamiera
della macchina: proprio nell'istante in cui serve mirare, il dito sparisce dietro
l'oggetto. Senza aptica, senza ombra di contatto e con la stereopsi che a un
centimetro non aiuta, non resta modo di capire dove si è.

Da qui il modo **`punto`**: niente pallina sulla mano, ma un disco piatto sul
bersaglio, nel punto esatto in cui il tocco scatterà — sopra la geometria, quindi
sempre visibile, con l'opacità che cresce avvicinandosi. È rivolto a chi guarda e
non alla superficie: dal `Box3` non si ricava una normale attendibile, e un disco
di taglio sarebbe invisibile proprio da certe angolazioni.

`niente` resta disponibile, ma è etichettato per quello che è: sconsigliato.

Il selettore sta sulla pagina 2D e non solo in console per un motivo pratico:
**dentro il visore la console non esiste**. Una regolazione senza comando sulla
2D, di fatto, non è regolabile da chi sta provando.

Distanza di attivazione **1 cm**, con uscita a 2,2: senza isteresi un dito che
trema a filo del bordo farebbe scattare il pulsante decine di volte al secondo.
È la distanza vera fra dito e bersaglio, e vale identica sui bersagli guidati e
su quelli no — il magnete rende l'ultimo tratto più facile da percorrere, non
l'area di attivazione più larga. Tarabile a caldo con
`XRInput.setPokeRadius(0.02)`.

##### Dove toccare: un anello piccolo, dello stesso giallo del dito

Sul desktop il bersaglio dello step è cerchiato da `HighlightCircleManager`, che
è DOM posizionato in pixel: in `immersive-vr` semplicemente non esiste. Al suo
posto c'è un anello 3D, sempre rivolto verso chi guarda, sul **punto del
bersaglio più vicino alla mano** — cioè esattamente il punto che fa scattare
l'azione. Sul baricentro sarebbe a mezz'aria in mezzo all'anta di una porta.

È volutamente piccolo (1,8–4,5 cm di raggio), sottile e dello stesso giallo della
sfera sul dito: anello e cursore devono leggersi come la stessa cosa. Cosa
toccare lo dice già la velatura gialla che il core mette sull'elemento
(`InteractiveObject3D.applyButtonHighlight`); all'anello resta da dire **dove**,
e per quello basta un segno. Quando una mano entra nel campo magnetico l'anello
si accende e cresce di poco: è il segnale che il bersaglio è ormai raggiungibile.

##### Il magnete: l'elemento dello step attira il dito

Il contatto secco chiede una precisione che senza aptica non si ha: il dito
arriva a un centimetro dal pulsante e non succede niente, perché nulla dice dove
finisce l'aria. Da qui l'assistenza magnetica.

Entro **2,5 cm** dall'`element` che lo step sta chiedendo, il bersaglio comincia
a tirare a sé la sfera gialla verso il proprio punto di interazione — lo stesso
punto che l'anello indica. L'attrazione cresce con continuità (curva smoothstep)
fino al **95%**: è un accompagnamento, mai un teletrasporto, ma alla fine la
sfera è addosso al punto, non nei pressi.

Il campo è corto di proposito. Dev'essere guidato l'ultimo tratto
dell'avvicinamento, non tutto il gesto: con 9 cm il cursore partiva verso il
bersaglio mentre la mano era ancora per aria, e l'aggancio arrivava troppo presto
per somigliare a un contatto.

**La mano va dove va la sfera.** La sfera è la punta del dito, non un puntatore a
sé: tirarla verso il bersaglio lasciando indietro la mano spezza proprio
l'illusione che il magnete deve creare — si vede un pallino che va da una parte e
una mano che resta dall'altra. Lo stesso scostamento vale quindi per entrambi,
sempre, in attrazione come in aggancio, e senza inerzia: qualunque
ammorbidimento diventerebbe una mano che insegue la sfera in ritardo. Solo in
uscita dalla guida si rientra dolcemente, in una settantina di millisecondi.

La regola che tiene insieme vista e logica: **il contatto si misura sul cursore,
non sul polpastrello**. Quel che si vede è quel che vale — la sfera arriva sul
punto e lì il tocco scatta, come un tocco normale.

La soglia però si esprime in **distanza vera**: il bersaglio scatta quando il
dito è a 1 cm da esso, guidato o no. Su un bersaglio guidato, a quella distanza
il cursore ha già percorso quasi tutto il tratto, e la soglia da usare è ciò che
gli resta — `_radiusFor` la ricava dalla curva del magnete invece di scriverla a
mano, così cambiare raggio o forza non sposta di un millimetro il punto in cui
il comando scatta.

Vale **solo per i bersagli `evidenziato`**, cioè per l'element chiesto dallo step
e per gli oggetti impugnabili già facilitati dalla loro soglia larga. Tutto il
resto resta alla soglia secca: nessuna scorciatoia inattesa su ciò che il
tutorial non ha chiesto.

Taratura a caldo: `XRInput.setSnap(0.04, 0.9)` — raggio e forza.
`XRInput.setSnap(undefined, 0)` disattiva il magnete e riporta il comportamento
al contatto secco.

##### L'aggancio: il bersaglio trattiene il dito

Nella realtà un pulsante trattiene il polpastrello — c'è l'attrito, c'è la
superficie che resiste, e la mano non scivola via mentre si preme. In VR non c'è
niente di tutto questo: il dito attraversa il comando come aria, e il tocco non
si sente mai arrivato. L'attrazione da sola non basta, perché è solo un
indicatore: guida il cursore e poi lo lascia andare.

Al contatto, quindi, **la mano disegnata si ferma**. Resta posata sul punto, e i
piccoli movimenti del dito vero non la spostano più: entro **2 cm** di tolleranza
il bersaglio la tiene. Superata quella distanza la mano
torna libera, rientrando sulla posizione vera in circa un decimo di secondo —
non di scatto.

Solo la resa cambia. La logica continua a seguire il dito vero, ed è lui a
decidere quando l'aggancio finisce: nessun comando parte o manca per via di dove
la mano è disegnata. Lo scostamento si applica alla **radice** della mano, non
alle ossa, così le dita continuano ad articolarsi — bloccare anche quelle darebbe
una mano di gesso.

L'aggancio si arma sul contatto e non si riarma da solo: se il dito esce dalla
tolleranza restando dentro il bersaglio, la mano resta libera finché non ci si
stacca e si torna a premere. Riagganciare a metà di un movimento volontario
sarebbe una mano che si incolla addosso alle cose. Non vale per gli oggetti
impugnabili: afferrare è trasporto, non pressione, e una mano bloccata mentre
prende qualcosa sembra rotta.

Taratura: `XRInput.setLatch(0.03)`; `setLatch(0)` lo disattiva.

##### Lo strumento dello step si equipaggia da solo

Sul desktop lo strumento (mano, brugola, spray…) si sceglie dalla legenda in
basso: è DOM, quindi in `immersive-vr` non esiste e nessuno può cliccarla.
`Scene3D.handleModelAction` però esce subito quando lo strumento attivo non è
quello richiesto — ed era per questo che **la porta non si apriva**: il contatto
veniva rilevato e l'azione scartata un istante dopo, in silenzio. Stessa sorte
per ogni step con `do :`.

In VR la mano è la mano: alla pressione, `XRInput` equipaggia da sé lo strumento
che lo step dichiara. Quando ci sarà la scelta degli strumenti in-world
(Milestone 4) questo resterà come ripiego per gli step che non la offrono.

`XRInput.debugInfo()` riporta, per ciascuna sorgente, se è una mano o un
controller, cosa ha vicino, cosa sta premendo, quanta attrazione sta subendo e
com'è finito l'ultimo tocco. Lo stesso esito compare nel riepilogo di
`📋 Log XR`, che è l'unico canale leggibile dal visore: se un elemento non
reagisce, dice se è stato toccato e se il tocco è servito a qualcosa.

#### Fluidità: cosa gira davvero a ogni frame

In `immersive-vr` il budget è **13,9 ms** a frame (72 Hz). Sforarlo non produce
solo un calo di fps: il compositore riproietta l'ultimo fotogramma e il mondo
"scivola" rispetto alla testa — è quello che si percepisce come perdita di
sincronia.

Due interventi, in ordine di peso.

**I cerchi DOM vengono spenti in VR.** `HighlightCircleManager` tiene un
`setInterval` a 60 Hz che, per ogni cerchio attivo, fa `updateMatrixWorld`,
costruisce un `Box3` nuovo, proietta in 2D, legge `canvas.clientWidth` — che
**forza un reflow** — e riscrive `style.left/top`. In sessione immersiva quei
cerchi non si vedono nemmeno. Peggio: girando su un timer indipendente dal frame
XR, quel lavoro cade a metà frame. Layout forzato e scritture di stile a 60 Hz
sono esattamente ciò che fa sforare la scadenza. In VR il loro compito lo fanno
gli anelli 3D, quindi il loop viene fermato all'ingresso e ripreso all'uscita.

**L'elenco dei bersagli si ricostruisce solo quando cambia.** Scoprire *quali*
mesh sono premibili costa un `traverse` di tutta la scena; rifarlo ogni 400 ms
su una macchina da 892k triangoli è uno spreco a intervalli regolari — cioè il
modo migliore per produrre micro-scatti periodici. Ora si rifà solo quando
cambia una firma economica (modelli caricati, pulsanti evidenziati, oggetti in
mano, indice dello step). I `Box3` invece si rileggono ogni 400 ms, perché le
porte si aprono e gli oggetti si muovono — ma sugli stessi oggetti di prima,
riusati e non riallocati: un ciclo di GC dentro un frame XR si vede. Per lo
stesso motivo sono spariti `filter` e `forEach` dal percorso per-frame.

**Un'eccezione non deve poter uccidere la sessione.** In Three r155 il loop è

```js
function onAnimationFrame(time, frame) {
    animationLoop(time, frame);
    requestId = context.requestAnimationFrame(onAnimationFrame);
}
```

— il frame successivo si chiede **dopo** aver eseguito la callback. Se la
callback lancia, quella riga non viene mai raggiunta: il loop muore per sempre,
l'applicazione smette di consegnare fotogrammi e il visore resta congelato
sull'ultimo, immobile anche girando la testa. Un solo errore dentro `core/`,
raggiunto dal dispatch di un tocco, basta a far sembrare rotta tutta la sessione.
Ora le due metà del frame hanno ciascuna il proprio `try`, e il dispatch del
tocco ne ha uno suo: un errore diventa un frame storto e una riga nel log.

**Le due cause che non sono eccezioni** hanno un sensore ciascuna, perché nessun
`try` le vedrebbe. *Contesto WebGL perso*: la GPU molla, ogni disegno diventa un
no-op silenzioso, il visore resta sull'ultimo fotogramma. *Sessione non
visibile*: il menu di sistema mette la sessione in `hidden` e i frame smettono
legittimamente di arrivare — sembra un blocco e non lo è. Il riepilogo dice
quale delle due.

Infine, `Ultimo frame` riporta quanto tempo era passato dall'ultimo frame quando
la sessione è finita: se sono decine di secondi, non era lentezza, era un blocco.

**Misurare invece di indovinare.** Dentro il Quest non si apre un profiler, e
"perde la sincronia" ha molte cause possibili. Il loop misura durata del frame,
quota di frame lunghi e quanto ne consuma il layer XR; il riepilogo di
`📋 Log XR` li mostra in chiaro. Se i frame sforano ma il layer XR costa una
frazione trascurabile, il collo di bottiglia non è nell'interazione: è nel
rendering della scena o fuori dalla pagina. `XRSession.frameReport()` dà gli
stessi numeri dalla console.

#### La hall: la home come luogo, non come pagina

Finché la scelta dello scenario è rimasta sul monitor, la VR è stata una modalità
di visualizzazione: si sceglieva col mouse, si indossava il visore, e a tutorial
finito lo si toglieva per scegliere di nuovo. Il pannello del tutorial lo diceva
in chiaro — «Esci dalla VR e scegli un tutorial dalla pagina, poi rientra.»

`xr/XRHall.js` chiude il giro. Si entra una volta e si resta dentro: la hall
mostra gli stessi scenari della home 2D come pannelli premibili col dito, si
entra in uno scenario, e a tutorial finito si torna qui.

**Rispecchiare, non reimplementare**, come per il pannello: l'elenco si legge
dalla stessa configurazione che ha popolato le card della home, e premere una
card chiama la stessa `loadScenario()` del click del mouse. Caricamento modelli,
camera, luci e scelta del tutorial localizzato restano di `core/`.

##### Di `UI` ce ne sono due, e comanda quella vecchia

`core/js/ui/ui-coordinator.js` definisce una `UI` modulare con `scenarioManager`,
`tutorialManager` e compagnia. Subito dopo viene caricato `core/js/ui.js`, il
monolite, che si fa da parte **solo se** trova la modulare già avviata — e la
riconosce da `_tutorialManager`, che a quel punto è ancora `null` perché
`UI.init()` non è stato chiamato. In pratica comanda sempre il monolite, dove:

- `scenariosConfig` è **direttamente un array**, non `{scenarios: […]}`;
- `loadScenario` sta su `UI`, non su `UI.scenarioManager`.

Leggere solo la forma modulare — com'era nella prima versione della hall —
significava non trovare mai nulla: la hall restava su «Caricamento scenari…» per
sempre e nessuna card veniva costruita, mentre sul desktop la home 2D mostrava
regolarmente i dieci scenari. `XRHall` accetta quindi entrambe le forme, e le
prove le esercitano tutte e due: provarne una sola è precisamente l'errore che
aveva lasciato passare il guasto.

Un'attesa che non finisce, poi, viene detta: dopo 12 secondi senza scenari il
pannello smette di dire «Caricamento» e dichiara che non ce ne sono. Dentro il
visore non c'è console, e un'attesa infinita è indistinguibile da un blocco.

##### Dieci scenari, non due

`homeconfig.ini` ne dichiara dieci. In colonna unica sarebbero 1,28 m di
pannelli: il primo sopra la testa, l'ultimo sotto le ginocchia, quasi nessuno a
distanza di dito. Si dispongono quindi in griglia, cinque per colonna, riempita
**per colonne** — si scorre una colonna dall'alto in basso come un elenco, mentre
riempiendo per righe due voci consecutive finirebbero affiancate e l'ordine si
perderebbe. Con i dieci veri: due colonne, 48 × 36 cm, a 61 cm dalla testa.

Sta al centro e non di lato come il fumetto del tutorial: lì il centro serve alla
macchina, qui dietro i pannelli non c'è nulla da guardare.

##### Perché cambiare scenario non spegne la sessione

Era il rischio vero, e la risposta sta in `Scene3D.clearAllModels`: rimuove *solo*
gli oggetti in `loadedModels`. Né `scene` né `renderer` vengono ricreati — nascono
una volta sola in `Scene3D.init()` — e la sessione WebXR vive appesa a
`renderer.xr`. L'`XRRig` è figlio di `scene` e non sta fra i modelli caricati,
quindi sopravvive alla pulizia. Vale anche per il ritorno: `UICore.goHome()` fa
`clearAllModels` e `showPage('home')`, e rimette `interactionsBlocked` a false.

Il pavimento della hall è **procedurale** — un disco e una griglia generati a
runtime — e non `pavimento.glb`: la hall è la prima cosa che si vede entrando e
deve esserci subito, senza aspettare il Worker. Senza nulla sotto i piedi si
galleggia nel vuoto, che è il modo più rapido di stare male in VR.

Nella hall il pannello del tutorial si fa da parte: parlerebbe di uno step non
ancora scelto, nello stesso posto in cui sta l'elenco. `XRUI` lo nasconde da sé
finché `XRHall.isVisible()`.

Stato: `XRHall.debugInfo()`.

##### La copertina è anche la schermata di accesso

Un quadro a tutta pagina con dentro i campi di sempre e il pulsante **ENTRA**.
Una schermata sola per fare una cosa sola: sul visore la pagina si apre in un
browser che galleggia in aria, spesso mentre ci si sta ancora sistemando le
cinghie, e ogni passaggio in più è un bersaglio in più da centrare col raggio.
Il motivo tecnico — la *user activation* da spendere subito per aprire la
sessione — è spiegato sopra, in «Entrare in VR».

**Il form è quello di `core/`, spostato.** `xr/XRCover.js` prende `#loginPage` e
lo sposta dentro la copertina, con i suoi campi, il suo submit e la sua logica:
`core/` legge `users.txt`, verifica le credenziali, ricava la lingua e ricarica la
configurazione tradotta. Un secondo modulo di accesso vorrebbe dire due
autenticazioni che divergono al primo cambiamento a monte, e la nostra sarebbe
quella senza scadenze account né ruoli. Si sposta un nodo nel DOM e si cambia
l'etichetta di un pulsante, tutto da JavaScript.

Il velo si toglie quando `core/` scopre `#container`, cioè a credenziali
accettate — osservare quello invece di agganciarsi al submit evita di indovinare
l'esito: il login può fallire, e in quel caso si deve restare lì a leggere il
messaggio d'errore.

Le uniche righe di `xr.css` che sovrascrivono CSS di `core/` stanno qui, e sono
vincolate a `#xrCover`: `#loginPage` è pensato per stare da solo a tutta pagina e
porta con sé un fondo pieno che coprirebbe il quadro. La pagina di login normale
— quella del ri-login dopo «Cambia utente» — resta esattamente com'era.

#### L'interfaccia del tutorial, dentro il mondo

In `immersive-vr` il DOM non esiste: il compositore mostra solo ciò che la pagina
disegna in WebGL. Tutta l'interfaccia di CVT — fumetto con la descrizione dello
step, contatore, modali informativi — è HTML, quindi in VR spariva. Era il buco
più grosso del porting: si entrava nella scena senza sapere cosa fare, e uno step
con `message` **bloccava il tutorial per sempre**, perché il pulsante OK che lo
sblocca era invisibile.

`xr/XRUI.js` la rifà come geometria: un pannello di testo, il media del modale,
la legenda degli strumenti e un pulsante,
premibile col dito come qualunque comando della macchina — stessi bersagli,
stesso magnete, stessa distanza di attivazione, perché passa per lo stesso
`XRInput`.

**Rispecchiare, non reimplementare.** Il pannello *legge* il DOM
(`#stepDescription`, `#stepCurrentNumber`, `#infoModalMessage`, …) e per il
modale fa un **click vero** sul vero `#infoModalOkBtn` — è quel click che risolve
la promise su cui `core/` è fermo. Non è pigrizia: è l'unico modo per non avere
due verità. La logica del tutorial — quando si può avanzare, cosa succede alla
chiusura di un modale, quali step sono automatici — vive in `core/` ed è
intricata; duplicarla qui significherebbe vederla divergere al primo cambiamento
a monte. Rispecchiando il DOM, invece, ogni modifica futura arriva da sola.

Il testo è un canvas 2D su un quad `MeshBasicMaterial` — la stessa tecnica delle
schermate PNG, e per lo stesso motivo: il testo non deve essere spento dalle luci
di scena. Il canvas viene ridisegnato **solo quando il contenuto cambia**:
rifarlo a ogni frame costerebbe più di tutto il resto del layer. La densità è
scelta perché il corpo del testo sottenda ~1,6° a un metro, sotto i quali nei
visori attuali si sgrana.

Il pannello sta **a portata di braccio** — 60 cm davanti, 19 sotto la linea dello
sguardo — e insegue la testa **con calma e solo in imbardata**. La prima versione
stava a un metro: si leggeva benissimo e non si poteva premere, perché il braccio
arriva a una sessantina di centimetri. Un pannello che si tocca col dito deve
stare dove il dito arriva. Le misure sono scritte per un metro e poi scalate con
la distanza, così spostarlo non ne cambia la dimensione apparente né la
leggibilità: `XRUI.setPlacement(0.7)` non richiede di ritarare nulla. Incollato allo sguardo sarebbe
illeggibile mentre ci si muove; seguendo anche il beccheggio finirebbe in mezzo
anche guardando in basso verso una vite. Con il solo yaw resta un oggetto
appoggiato nello spazio, che si ritrova dove ci si aspetta.
`XRUI.setPlacement(distanza, quantoSotto)` per tararlo, `XRUI.setVisible(false)`
per toglierlo di mezzo.

##### Niente "Avanti" e "Indietro": in VR si avanza facendo lo step

Il pannello aveva due frecce che chiamavano `UI.nextStep()` e `UI.prevStep()`.
Sono state tolte. Sul desktop saltare uno step è una scorciatoia innocua, perché
il mouse ha comunque la scena davanti; in VR è il modo più rapido per portarsi
via l'azione che lo step chiedeva — si preme "Avanti" e la spruzzata di spray non
è mai avvenuta, ma il tutorial è andato oltre. L'unico modo di avanzare è quello
vero: fare quello che lo step chiede.

Resta il solo **OK**, e solo con un modale aperto: è il click che sblocca `core/`,
fermo ad aspettarne la chiusura.

##### Fine tutorial: il secondo modale, quello che non era `#infoModal`

All'ultimo step `core/` non apre `#infoModal`: costruisce al volo
`#congratulationsModal` (`Scene3D.displayCongratulationsModal`) e insieme mette
`tutorialTracker.interactionsBlocked = true`.

In VR questo produceva un vicolo cieco perfetto: il messaggio è DOM, quindi
invisibile; la scena è congelata, quindi non c'è nulla da toccare; e il pannello
mostrava ancora lo stato dello step come se niente fosse. Si finiva il tutorial e
il mondo semplicemente smetteva di rispondere.

Ora quel modale è rispecchiato come tutti gli altri — stesso pannello, stesso
posto al centro, pulsante che dice **Continua** e che preme il vero
`#congratulationsCloseBtn`, così la navigazione al tutorial successivo resta di
`core/`.

E `interactionsBlocked` **non spegne più il pannello**. Blocca la macchina, come
deve: sul desktop il modale resta cliccabile mentre tutto ciò che sta dietro è
inerte, e in VR vale lo stesso. `XRInput` restringe i bersagli ai soli `kind:
'ui'` invece di azzerare ogni sorgente — bloccare anche l'unico pulsante che fa
uscire dallo stato di blocco è ciò che rendeva il finale una trappola.

##### Ai lati mentre si lavora, al centro quando è lui il compito

Durante uno step il centro dello sguardo serve alla macchina: è lì che si deve
guardare per premere un pulsante o infilare il dito in una feritoia. Quindi
**fumetto in alto a sinistra, al limite del cono visivo, strumenti in basso a
destra**, e il mezzo resta libero — entrambi dove l'occhio li ritrova senza cercarli.

Spostarli solo di lato non bastava: alla stessa altezza continuavano a leggersi
come un blocco unico che occupa tutta la fascia bassa. Separati anche in
verticale diventano due cose distinte.

Spinto al bordo, il fumetto va anche **girato verso l'operatore**: un rettangolo
di testo visto di taglio è testo che non si legge. Costa nulla e restituisce la
pagina piatta davanti agli occhi.

Il modale è l'eccezione, e giustamente: quando `core/` si ferma ad aspettare
quella chiusura, il messaggio *è* il compito. Fumetto, video e OK tornano al
centro, davanti.

##### Media: il video del modale e la finestra animata

Immagini e video dei modali compaiono sopra il fumetto, con le proporzioni vere.
La texture arriva **dall'elemento che `core/` ha già creato** dentro
`#infoModalMedia`: il video lo carica e lo riproduce lui, qui se ne mostrano i
fotogrammi (`THREE.VideoTexture`). Ricaricarlo per conto nostro significherebbe
due decodifiche dello stesso file e due punti dove può fallire.

Stessa strada per la **finestra animata a fotogrammi** (`AnimatedWindowSystem`):
è il filmato che accompagna certi passi — l'apertura e chiusura della pinza
comandata dal tecpad, per dire, dove si preme il pulsante e i fotogrammi
avanzano. Sul desktop è una finestra HTML sopra la scena; in VR non esisteva,
quindi si premeva il pulsante e non succedeva niente di visibile.

Va al **centro**, non sopra il fumetto: durante uno step il centro è libero
apposta, ed è lì che si sta già guardando mentre si preme.

**Qui, e solo qui, non si rispecchia il DOM.** Con l'`<img>` non ha funzionato
due volte: la texture va caricata quando l'immagine è decodificata, e indovinare
quell'istante dall'esterno è fragile — un tentativo troppo presto e il riquadro
resta vuoto senza che nessuno se ne accorga. Si legge invece lo **stato**:
`state.images` e `state.currentIndex` dicono quale fotogramma mostrare, e la
texture la si carica per conto proprio, una volta per fotogramma e tenuta in
cache. Sono PNG piccoli e già nella cache del browser, quindi il doppio
caricamento non costa nulla; in cambio non c'è più alcun istante da indovinare.
Sequenza, direzione, conteggio dei trigger e chiusura restano di `core/`: si
rispecchia il *cosa*, non il *quando*.

Il riepilogo di `📋 Log XR` distingue i tre anelli della catena — finestra non
aperta da `core/`, aperta ma senza immagini trovate, aperta e rispecchiata.

##### La legenda degli strumenti

Sul desktop lo strumento si sceglie dalla legenda in basso a destra; in VR è DOM,
quindi invisibile. Finora l'unico modo di avere lo strumento giusto era che
`XRInput` lo equipaggiasse da sé alla pressione — funziona, ma toglie di mezzo un
pezzo del tutorial: scegliere l'utensile corretto è parte dell'esercizio.

Ora la legenda torna, come colonna di pulsanti al fianco dell'operatore: icona
vera dello strumento, bordo acceso su quello attivo, cornice gialla su quello che
lo step sta chiedendo. Premerne uno chiama lo stesso `ToolsManager.toggleTool()`
della legenda 2D.

Non è un cartello da leggere, è una tastiera da premere: il riferimento giusto
non è un pannello a parete ma il **bracciolo di una sedia** — vicino, in basso,
inclinato di 45° verso l'alto, dove la mano cade da sola senza alzare il braccio.
Verticale come una vetrina costringeva a portare la mano davanti al viso; del
tutto orizzontale sarebbe scomparsa di taglio. È anche girata verso l'operatore,
che stando di lato altrimenti la guarderebbe di sbieco.
`XRUI.setTools({ side, x, y, z, tilt, yaw })` per tararla — `side: 'left'` la
sposta dall'altra parte.

Gli strumenti si scelgono **solo mentre si sta facendo uno step**: col modale
aperto il desktop blocca tutto ciò che sta dietro, e prima dell'avvio del
tutorial `StepGatingManager` blocca ogni interazione. In VR vale lo stesso,
altrimenti si permetterebbe ciò che il resto del sistema vieta.

Con la legenda a disposizione, **l'equipaggiamento automatico è spento**:
scegliere l'utensile è tornato a essere parte dell'esercizio, e un tocco con lo
strumento sbagliato non fa nulla, esattamente come sul desktop.
`XRInput.setAutoTool(true)` lo riaccende, se servisse una modalità dimostrativa.

#### Oggetti impugnati

Sul desktop `HoldableSystem` ancora l'oggetto impugnato alla **camera**: giusto
lì, dove non ci sono mani e l'oggetto deve stare in un angolo fisso
dell'inquadratura. In VR è sbagliato due volte.

Il calcolo non torna più: `updateHeldObjectPosition`
(`core/js/core/HoldableSystem.js:454`) somma `camera.position` trattandolo come
coordinata mondo. Lo era finché la camera era figlia di `Scene`; da quando è
figlia dell'`XRRig` è **locale**, e l'oggetto finiva a quasi 4 unità dalla testa.
Ed è comunque innaturale: in VR l'oggetto lo si prende in mano.

`xr/XRHold.js` avvolge quel metodo e aggancia l'oggetto al **palmo** della mano
sinistra — la destra resta libera di premere — con ripiego sul polso e poi sul
controller se il palmo non è tracciato. Presa, rilascio e stato degli step
restano di `HoldableSystem`: `core/` non è toccato.

**La sinistra è un vincolo, non una preferenza.** Le sorgenti XR sono indicizzate
per ordine di connessione, non per lateralità: sparendo entrambe le mani e
tornando solo la destra, questa si riconnette sull'indice che era della sinistra.
Legarsi alla "prima mano disponibile" faceva ricomparire il telecomando nella
destra; e non bastava correggere la scelta della sorgente, perché **l'ancora
resta appesa a un giunto** di quell'indice — che nel frattempo riceve le pose
dell'altra mano. Il telecomando la seguiva, per giunta con la posa sbagliata: si
vedeva il retro.

Ora la lateralità si legge solo da `handedness`, l'ancora è **una sola**, e
quando la mano vincolata non è tracciata l'ancora viene staccata dal giunto e
appesa al rig **conservando la posa mondo** (`attach`, non `add`): l'oggetto resta
immobile dove la mano l'ha lasciato, non passa a nessuno, e quando la sinistra
torna se lo riprende dal palmo. Il ripiego davanti alla testa vale solo per un
oggetto che in mano non c'è mai stato.

Per il mancino: `XRHold.setHand('right')`. Nessuna logica di runtime deve
chiamarlo per "seguire" la mano che tocca l'oggetto — è esattamente ciò che
mandava il telecomando dalla parte sbagliata.

L'ancora vive sotto il rig, quindi la scala va compensata (`1/scalaMondo`),
altrimenti l'oggetto rimpicciolirebbe rispetto alla macchina invece di
conservare la sua dimensione in unità scena.

Taratura a caldo: `XRHold.setGrip(x, y, z, rx, ry, rz)` — posizione in metri
rispetto al polso, rotazione in gradi. La posa giusta si giudica solo indossando
il visore.

##### Puntare invece di toccare: decide la direzione, non una modalità

La colonna degli strumenti e il pulsante OK possono restare al limite del
braccio, e col dito impegnato a mirare il teleport sembra di dover scegliere fra
le due cose. La tentazione è un interruttore "adesso punto l'interfaccia": cioè
uno stato in più da ricordare e da sbagliare.

Non serve. **È la direzione a dirlo**: verso il pannello si stanno scegliendo
comandi, verso il pavimento una destinazione. Sono due bersagli che non si
sovrappongono mai, quindi la disambiguazione è gratis e non c'è nulla da
imparare — lo stesso principio per cui una mano vicina a un pulsante smette di
mirare.

Puntando un comando il raggio diventa **giallo** e si ferma sul pulsante, così si
vede cosa si sta per premere; il pinch preme, invece di teleportare. Nessuna
destinazione viene proposta finché si punta il pannello.

**Ma non si preme di passaggio.** Il raggio spazza la scena a ogni movimento del
braccio, e un pinch fatto per teleportarsi premerebbe qualunque comando gli
capiti sotto in quell'istante: basta che lo strumento sbagliato attraversi il
raggio e ci si ritrova la brugola in mano davanti a un passo da spray. Un comando
che si attiva di passaggio è peggio di un comando irraggiungibile. Serve un terzo
di secondo fermi sullo stesso bersaglio, che è un gesto che non si fa per caso;
finché non è armato il raggio resta pallido.

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

**La mano che regge un oggetto non ne preme i pulsanti.** Prendendo il
telecomando, il palmo e il pollice della mano che lo tiene finiscono *dentro* la
sua geometria, a un centimetro dai suoi stessi tasti: la presa faceva scattare
subito l'avvio ciclo, e il cambio utensile partiva da solo senza che nessuno lo
avesse chiesto. I bersagli che vivono sotto l'ancora di `XRHold` sono quindi
marcati, e la mano che regge li salta. Li preme l'altra — che è esattamente il
gesto vero: telecomando in una mano, dito nell'altra.

Fra i bersagli premibili c'è anche l'**`element` dello step**, che pulsante non
è. Serve per una categoria intera di passi che senza di esso erano *impossibili*
in VR: quelli con un utensile. Nella grammatica v3 `element` + `tool` + `do :` è
il flusso utensile — si clicca l'oggetto con lo strumento in mano — e il
pre-processore, giustamente, non emette alcun `AcceptTrigger_Physical`. Niente
trigger significa niente evidenziazione, quindi niente `highlightedButtons`: il
naso dell'elettromandrino non compariva fra i bersagli e il tutorial si fermava
lì, senza nulla da toccare. Gli step automatici restano invece esclusi: renderli
premibili vorrebbe dire poter far partire in anticipo un movimento macchina.

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
| 4 | UI del tutorial in-world | ✅ fatto |
| 4c | Hall immersiva: copertina, scelta scenari in-world, ritorno a fine tutorial | 🧪 da provare sul Quest |
| 7 | Locomozione: teleport, rotazione a scatti | ✅ fatto (anticipata: il poke la richiede) |
| 2 | Pipeline asset | ⏸️ **rimandata** — vedi sotto |
| 4b | Modali con immagine e video dentro il pannello | ⏳ prossima |
| 5 | Utensili agganciati al controller + particelle | ⏳ |
| 6 | Grab & snap col grip | ⏳ |
| 7 | Locomozione: teleport alle postazioni da `CameraPos` | ⏳ |
| 8 | Secondo scenario (Pompa Becker) | ⏳ |

Scenario pilota: **Manutenzione Elettromandrino**.
Analisi e architettura complete: vedi il piano allegato alla issue di setup.
