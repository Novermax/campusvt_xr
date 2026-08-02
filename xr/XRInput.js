/**
 * XRInput.js — interazione per contatto (poke) col dito.
 *
 * MILESTONE 3, seconda versione. La prima usava un raggio laser e l'evento
 * `select`: si premeva puntando. Su richiesta è stata sostituita dal **contatto
 * fisico**: il polpastrello entra nel volume del pulsante e il pulsante scatta.
 * Nessun pinch, nessun trigger — premere è un gesto, non un comando.
 *
 * Conseguenza: il raggio non serve più per interagire e resta solo alla
 * locomozione (vedi XRLocomotion.js). I bersagli fuori dalla portata del braccio
 * si raggiungono spostandosi, non puntando.
 *
 * TERZA VERSIONE: il contatto secco chiedeva una precisione che senza aptica non
 * si ha — il dito arriva a un centimetro dal pulsante e non succede niente,
 * perché nulla dice dove finisce l'aria. Ora il bersaglio chiesto dallo step
 * **attira** il cursore verso il proprio punto di interazione, con forza
 * crescente e progressiva (vedi SNAP_RANGE / SNAP_STRENGTH). Il contatto si
 * misura sul cursore: quel che si vede è quel che vale.
 *
 * Cosa NON cambia: il dispatch. Come per il layer touch e per il mouse, si passa
 * sempre per la stessa API basata su mesh:
 *
 *   window.InteractiveObject3D.handleClick(mesh, opts)
 *   window.Scene3D.handleModelAction(rootModel)
 *
 * Non tocca `core/`.
 */

(function () {
    'use strict';

    /**
     * Raggio di contatto, in unità scena. Il dito è un punto, i pulsanti sono
     * piccoli: senza tolleranza servirebbe una precisione irreale.
     * L'uscita è più larga dell'ingresso — isteresi, altrimenti un dito che
     * trema a filo del bordo fa scattare il pulsante decine di volte.
     *
     * Stretto di proposito: il bersaglio deve risultare attivabile solo quando
     * il dito ci è davvero sopra. Con 2,2 cm più l'assistenza magnetica larga
     * l'area di attivazione arrivava a quasi 5 cm e i comandi scattavano da
     * lontano — sensazione di approssimazione, non di contatto.
     *
     * È la distanza VERA fra dito e bersaglio, non un valore che l'assistenza
     * poi allarga: `_radiusFor` ricava da qui la soglia sui bersagli guidati,
     * così l'attivazione resta a 1 cm qualunque cosa faccia il magnete.
     */
    let POKE_ENTER = 0.010;
    /** Quanto più larga è l'uscita rispetto all'ingresso. */
    const EXIT_RATIO = 2.2;
    let POKE_EXIT = POKE_ENTER * EXIT_RATIO;

    /**
     * Afferrare è un gesto molto più grossolano che premere: la soglia per gli
     * oggetti impugnabili è perciò larga. Con 2,2 cm e il solo polpastrello
     * prendere il telecomando risultava difficile, come segnalato dal visore.
     */
    let GRAB_ENTER = 0.075;

    /**
     * Punti della mano che contano come contatto. Per premere basta l'indice,
     * ma per afferrare deve valere qualunque parte della mano: si prende un
     * oggetto col palmo e col pollice, non puntandolo col dito.
     */
    const TIP_JOINTS = [
        'index-finger-tip',
        'thumb-tip',
        'middle-finger-tip',
        'middle-finger-metacarpal',   // centro del palmo
    ];

    /**
     * Distanza entro cui un bersaglio è "vicino" e il cursore compare.
     * Tenuta stretta: a 35 cm il cursore restava acceso di continuo, perché il
     * pulpito ha molti figli interattivi ravvicinati.
     */
    const NEAR_RANGE = 0.12;

    /**
     * Attrazione magnetica verso il bersaglio dello step.
     *
     * Senza aptica il dito non sa dove finisce l'aria e comincia il pulsante:
     * mirare a mezzo centimetro in aria, senza attrito né contraccolpo, è una
     * precisione che non si ha. Da qui l'assistenza: entro {@link SNAP_RANGE} il
     * bersaglio tira a sé il cursore (la sfera gialla) verso il punto che fa
     * scattare l'azione, con forza crescente fino a {@link SNAP_STRENGTH}.
     *
     * La regola che tiene insieme vista e logica: **il contatto si misura sul
     * cursore, non sul polpastrello**. Quel che si vede è quel che vale — la
     * sfera arriva sul punto e lì il tocco scatta, come un tocco normale.
     * L'attrazione è progressiva (smoothstep), mai un teletrasporto.
     *
     * Vale SOLO per i bersagli `evidenziato`, cioè per l'`element` che lo step
     * sta chiedendo. Gli altri restano alla soglia secca: nessuna scorciatoia
     * inattesa su ciò che il tutorial non ha chiesto.
     *
     * Il campo è corto — due centimetri e mezzo — perché deve essere l'ultimo
     * tratto dell'avvicinamento a essere guidato, non tutto il gesto. Con 9 cm
     * il cursore partiva verso il bersaglio quando la mano era ancora per aria.
     *
     * La forza è quasi piena: il cursore deve finire ADDOSSO al punto, non nei
     * pressi. A 0,80 restava a un paio di millimetri e si vedeva.
     */
    let SNAP_RANGE = 0.025;
    let SNAP_STRENGTH = 0.95;

    /**
     * Aggancio: quanto può vagare il dito prima che la mano torni libera.
     *
     * Quando il contatto scatta, la mano DISEGNATA si ferma: resta dov'era nel
     * momento dell'aggancio e i piccoli movimenti del dito vero non la spostano.
     * È il sostituto dell'attrito che nella realtà tiene il polpastrello sul
     * pulsante — senza, la mano scivola via da un bersaglio che dovrebbe
     * trattenerla, e il tocco non si sente mai "arrivato".
     *
     * Solo la resa cambia: il dito vero continua a essere seguito dalla logica,
     * ed è lui a decidere quando l'aggancio finisce. Superata questa distanza
     * dal punto di aggancio, la mano riprende a seguire la vera posizione —
     * non di scatto, ma rientrando in una frazione di secondo.
     */
    let LATCH_TOLERANCE = 0.020;

    /**
     * Quanto in fretta la mano rientra sulla posizione vera quando smette di
     * essere guidata. Frazione di scarto recuperata a ogni frame: a 72 Hz si
     * arriva in una settantina di millisecondi.
     *
     * Vale SOLO in uscita. Finché il magnete o l'aggancio stanno guidando, lo
     * scostamento è esatto e senza inerzia: qualunque ammorbidimento si
     * tradurrebbe in una mano che insegue la sfera con un ritardo visibile —
     * il difetto che questo codice esiste per togliere.
     */
    const GUIDE_RELEASE = 0.45;

    /** Giunti di una XRHand. Serve a dimensionare la mesh istanziata di ripiego. */
    const HAND_JOINT_COUNT = 25;

    /**
     * Modelli di mano, vendorizzati in locale da immersive-web/webxr-input-profiles
     * (licenza W3C Software and Document — vedi libs-xr/hands/NOTICE.md). Sono gli
     * stessi asset che `XRHandModelFactory` di Three scaricherebbe da un CDN.
     * Serviti dalla nostra origin: nessuna dipendenza esterna a runtime.
     */
    const HAND_MODEL_PATH = 'libs-xr/hands/';

    /** Ogni quanto ricostruire l'elenco dei bersagli, in ms. Gli step cambiano. */
    const CANDIDATE_REFRESH_MS = 400;

    const CURSOR_NEAR = 0xffd21e;   // giallo: stai per toccare
    const CURSOR_SNAP = 0xfff3b0;   // giallo chiaro: il magnete ha agganciato
    const CURSOR_HIT = 0xffffff;    // bianco: contatto avvenuto
    const FLASH_MS = 160;

    /** Colore degli anelli e del lampo di pressione. Lo stesso della sfera del
     *  dito: cerchio e cursore devono leggersi come la stessa cosa. */
    const HL_COLOR = 0xffd21e;

    /**
     * Misure dell'anello indicatore. Piccolo e sottile: segna il punto da
     * toccare, non circonda l'oggetto. La versione precedente, legata
     * all'ingombro del bersaglio, dominava la scena su elementi grandi.
     */
    const RING_MIN = 0.018;
    const RING_MAX = 0.045;

    /** Durata del lampo emissivo sull'oggetto premuto. */
    const PRESS_FLASH_MS = 220;

    const XRInput = {
        enabled: false,
        xr: null,
        sources: [],
        candidates: [],

        _raycaster: null,
        _rings: [],
        _lastRebuild: 0,
        _tmpA: null,
        _tmpB: null,
        _tmpC: null,
        _tmpD: null,

        /**
         * Ultimo tocco andato a buon fine o a vuoto, in italiano leggibile.
         * Finisce nel riepilogo di XRLog: dentro il visore è l'unico modo per
         * sapere se un elemento non reagisce perché non è stato toccato o
         * perché il tocco è stato scartato a valle.
         */
        lastTouch: null,

        // =====================================================================
        // Ciclo di vita
        // =====================================================================

        init: function (xrSession) {
            if (this.enabled) return;
            const S = window.Scene3D;
            const THREE = window.THREE;
            if (!S || !S.renderer || !xrSession.rig) return;

            this.xr = xrSession;
            this._raycaster = new THREE.Raycaster();
            this._tmpA = new THREE.Vector3();
            this._tmpB = new THREE.Vector3();
            this._tmpC = new THREE.Vector3();
            this._tmpD = new THREE.Vector3();

            for (let i = 0; i < 2; i++) this.sources.push(this._buildSource(i));
            this.candidates = [];
            this._lastRebuild = 0;

            if (window.XRLocomotion) window.XRLocomotion.init(xrSession, this);
            if (window.XRHold) window.XRHold.attach(xrSession, this);

            this.enabled = true;
            console.log('[XRInput] Interazione a contatto attiva. Tocca i comandi col dito.');
        },

        dispose: function () {
            // Prima XRHold: deve restituire gli oggetti impugnati al grafo
            // originale finché le ancore esistono ancora.
            if (window.XRHold) window.XRHold.detach();
            if (window.XRLocomotion) window.XRLocomotion.dispose();
            this.sources.forEach((s) => {
                if (s.controller.parent) s.controller.parent.remove(s.controller);
                if (s.handObj && s.handObj.parent) s.handObj.parent.remove(s.handObj);
                if (s.cursor.parent) s.cursor.parent.remove(s.cursor);
                s.cursor.geometry.dispose();
                s.cursor.material.dispose();
                if (s.handMesh.parent) s.handMesh.parent.remove(s.handMesh);
                s.handMesh.geometry.dispose();
                s.handMesh.material.dispose();
                s.handMesh.dispose();
                if (s.handModel) {
                    if (s.handModel.root.parent) s.handModel.root.parent.remove(s.handModel.root);
                    s.handModel.root.traverse((o) => {
                        if (o.geometry) o.geometry.dispose();
                        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
                    });
                    s.handModel = null;
                }
                s.controller.removeEventListener('connected', s.onConnected);
                s.controller.removeEventListener('disconnected', s.onDisconnected);
            });
            this._clearHighlights();
            this.sources = [];
            this.candidates = [];
            this.enabled = false;
            if (window.InteractiveObject3D) window.InteractiveObject3D.handleHover(null);
        },

        _buildSource: function (index) {
            const S = window.Scene3D;
            const THREE = window.THREE;
            const rig = this.xr.rig;

            const controller = S.renderer.xr.getController(index);
            // getHand va chiamato perché Three popoli i giunti: senza, `joints`
            // resta vuoto e non esiste alcun polpastrello da seguire. Non aggiunge
            // nulla di visibile — i modelli delle mani li disegna il visore.
            const handObj = S.renderer.xr.getHand(index);

            // Cursore di contatto: una sfera minuscola sulla punta del dito, visibile
            // solo in prossimità di un bersaglio. Con le mani non c'è aptica, e senza
            // un segnale visivo non si saprebbe quando si sta per toccare.
            const cursor = new THREE.Mesh(
                new THREE.SphereGeometry(0.006, 12, 8),
                new THREE.MeshBasicMaterial({ color: CURSOR_NEAR, transparent: true, opacity: 0.9, depthTest: false })
            );
            cursor.renderOrder = 999;
            cursor.visible = false;
            rig.add(cursor);

            // Mano visibile: in immersive-vr il visore NON disegna nulla, deve
            // farlo l'applicazione. Una InstancedMesh di sferette sui 25 giunti
            // costa una sola draw call per mano ed è procedurale — niente asset
            // da CDN, come XRHandModelFactory con profilo 'mesh' richiederebbe.
            const handMesh = new THREE.InstancedMesh(
                new THREE.SphereGeometry(1, 8, 6),
                new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.75, metalness: 0.0 }),
                HAND_JOINT_COUNT
            );
            handMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            handMesh.frustumCulled = false;
            handMesh.count = 0;              // nessun giunto ancora tracciato
            rig.add(handMesh);

            const s = {
                index, controller, handObj, cursor, handMesh,
                hand: null, isHand: false, inputSource: null,
                tip: new THREE.Vector3(),
                tips: [],
                _tipVecs: [],
                hasTip: false,
                engaged: null,      // mesh attualmente "premuta", per l'isteresi
                near: null,
                snapW: 0,           // forza dell'attrazione in corso, 0..1
                latch: null,        // { cand, live, at, point } se la mano è agganciata
                guided: new THREE.Vector3(),      // dove va mostrato il polpastrello, in mondo
                holdOffset: new THREE.Vector3(),  // scostamento fra dito vero e dito mostrato
                _holdTarget: new THREE.Vector3(), // scostamento a cui tendere
                flashUntil: 0,
            };

            s.onConnected = (e) => {
                s.inputSource = e.data;
                s.hand = e.data.handedness;
                s.isHand = !!e.data.hand;
                console.log(`[XRInput] ${s.hand || '?'}: ${s.isHand ? 'mano tracciata' : 'controller'}`);
                // La lateralità si conosce solo ora: prima non si saprebbe quale
                // dei due modelli caricare.
                this._loadHandModel(s);
            };
            s.onDisconnected = () => { s.inputSource = null; s.hand = null; s.isHand = false; s.hasTip = false; };
            controller.addEventListener('connected', s.onConnected);
            controller.addEventListener('disconnected', s.onDisconnected);

            rig.add(controller);
            rig.add(handObj);
            return s;
        },

        // =====================================================================
        // Mano visibile
        // =====================================================================

        /**
         * Carica la mesh skinnata della mano. Le ossa del modello portano
         * esattamente i nomi dei giunti WebXR e sono tutte figlie dirette
         * dell'Armature, che è a identità: la posa di ogni giunto si copia
         * sull'osso corrispondente senza composizioni.
         *
         * Finché non è caricata — o se il caricamento fallisce — restano le
         * sferette: meglio una mano approssimativa che nessuna mano.
         */
        _loadHandModel: function (s) {
            if (s.handModel || s.handModelPending || !s.hand || !s.isHand) return;
            const GLTFLoader = window.GLTFLoader;
            if (!GLTFLoader) return;

            s.handModelPending = true;
            new GLTFLoader().load(
                `${HAND_MODEL_PATH}${s.hand}.glb`,
                (gltf) => {
                    const bones = {};
                    gltf.scene.traverse((o) => {
                        if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; // le ossa si muovono molto
                        if (o.isBone || o.type === 'Bone') bones[o.name] = o;
                    });
                    s.handObj.add(gltf.scene);
                    // La posa di riposo del root va ricordata: l'aggancio ci
                    // somma sopra uno scostamento, e senza base a cui tornare
                    // ogni aggancio sposterebbe la mano un po' più in là.
                    s.handModel = { root: gltf.scene, bones, base: gltf.scene.position.clone() };
                    s.handMesh.visible = false;
                    s.handMesh.count = 0;
                    console.log(`[XRInput] Mano ${s.hand}: mesh caricata, ${Object.keys(bones).length} ossa.`);
                },
                undefined,
                (err) => {
                    s.handModelPending = false;
                    console.warn(`[XRInput] Mano ${s.hand} non caricata, resto con le sferette:`, err && err.message ? err.message : err);
                }
            );
        },

        /**
         * Ridisegna la mano. Con la mesh caricata copia le pose sulle ossa;
         * altrimenti disegna i giunti come sferette.
         *
         * In entrambi i casi la mano vive dentro il rig, quindi subisce la stessa
         * scala del mondo della testa e resta proporzionata a ciò che si guarda.
         */
        _updateHandVisual: function (s) {
            if (s.handModel) return this._updateHandBones(s);
            return this._updateHandSpheres(s);
        },

        /**
         * Copia la posa di ogni giunto sull'osso omonimo.
         *
         * Lo scostamento di aggancio si applica alla RADICE, non alle ossa: le
         * dita continuano ad articolarsi come nella realtà, è la mano intera a
         * restare ferma sul punto. Bloccare anche le ossa darebbe una mano di
         * gesso.
         */
        _updateHandBones: function (s) {
            const joints = s.handObj && s.handObj.joints;
            const bones = s.handModel.bones;
            if (!joints) { s.handModel.root.visible = false; return; }

            let tracked = 0;
            for (const name in bones) {
                const j = joints[name];
                if (!j || !j.visible) continue;
                bones[name].position.copy(j.position);
                bones[name].quaternion.copy(j.quaternion);
                tracked++;
            }

            this._offsetIn(s.handObj, s.holdOffset, this._tmpC);
            s.handModel.root.position.copy(s.handModel.base).add(this._tmpC);
            s.handModel.root.visible = tracked > 0;
        },

        /**
         * Ripiego: una sferetta per giunto, in una sola InstancedMesh.
         * `jointRadius` arriva dalla posa ed è in metri fisici; la geometria ha
         * raggio 1, quindi la scala dell'istanza è direttamente il raggio.
         */
        _updateHandSpheres: function (s) {
            const THREE = window.THREE;
            const joints = s.handObj && s.handObj.joints;
            if (!joints) { s.handMesh.count = 0; return; }

            this._mat = this._mat || new THREE.Matrix4();
            this._rigInv = this._rigInv || new THREE.Matrix4();
            this._offsetMat = this._offsetMat || new THREE.Matrix4();
            this._rigInv.copy(this.xr.rig.matrixWorld).invert();

            // Lo scostamento di aggancio, portato nello spazio del rig e
            // applicato a tutte le sferette insieme: la mano si ferma intera.
            const off = this._offsetIn(this.xr.rig, s.holdOffset, this._tmpC);
            this._offsetMat.makeTranslation(off.x, off.y, off.z);

            let n = 0;
            for (const name in joints) {
                if (n >= HAND_JOINT_COUNT) break;
                const j = joints[name];
                if (!j || !j.visible) continue;

                const r = j.jointRadius || 0.008;
                this._mat.copy(j.matrixWorld);
                this._mat.premultiply(this._rigInv);          // in coordinate del rig
                this._mat.premultiply(this._offsetMat);       // fermo, se agganciato
                this._mat.scale(this._tmpB.set(r, r, r));
                s.handMesh.setMatrixAt(n++, this._mat);
            }

            s.handMesh.count = n;
            if (n) s.handMesh.instanceMatrix.needsUpdate = true;
        },

        // =====================================================================
        // Punta che preme
        // =====================================================================

        /**
         * Posizione del punto che preme, in coordinate mondo.
         *  - mano tracciata: polpastrello dell'indice;
         *  - controller: origine del target ray, che sta sulla punta.
         * Il ripiego non è teorico: i giunti compaiono solo se il visore concede
         * `hand-tracking`, che è opzionale e può essere negato.
         */
        _updateTip: function (s) {
            // Three marca `visible` sui giunti e sul target ray solo quando arriva
            // una posa valida: è il modo giusto per sapere se il dato è utilizzabile.
            const THREE = window.THREE;
            const joints = s.handObj && s.handObj.joints;
            s.tips.length = 0;

            if (joints) {
                TIP_JOINTS.forEach((name, i) => {
                    const j = joints[name];
                    if (!j || !j.visible) return;
                    if (!s._tipVecs[i]) s._tipVecs[i] = new THREE.Vector3();
                    s._tipVecs[i].setFromMatrixPosition(j.matrixWorld);
                    s.tips.push(s._tipVecs[i]);
                });
            }

            if (s.tips.length) {
                // Il primo è l'indice quando c'è: è quello che preme, e su cui
                // va disegnato il cursore.
                s.tip.copy(s.tips[0]);
                s.hasTip = true;
                s.tipIsFinger = true;
                return true;
            }
            if (s.inputSource && s.controller.visible) {
                s.tip.setFromMatrixPosition(s.controller.matrixWorld);
                s.tips.push(s.tip);
                s.hasTip = true;
                s.tipIsFinger = false;
                return true;
            }
            s.hasTip = false;
            return false;
        },

        // =====================================================================
        // Bersagli
        // =====================================================================

        /**
         * Elenco di ciò che si può premere, con il proprio bounding box in
         * coordinate mondo. Ricostruito a intervalli e non a ogni frame:
         * `Box3.setFromObject` non è gratis, e i bersagli cambiano solo al
         * cambio di step o di evidenziazione.
         */
        _rebuildCandidates: function () {
            const S = window.Scene3D;
            const THREE = window.THREE;
            const IO = window.InteractiveObject3D;
            const list = [];
            const seen = new Set();

            const add = (mesh, kind) => {
                if (!mesh || seen.has(mesh)) return;
                seen.add(mesh);
                list.push({ mesh, kind, box: new THREE.Box3().setFromObject(mesh) });
            };

            // I pulsanti evidenziati dallo step sono ciò che il tutorial chiede
            // davvero: hanno la precedenza.
            if (IO && IO.highlightedButtons) for (const [, mesh] of IO.highlightedButtons) add(mesh, 'evidenziato');

            // Gli oggetti impugnabili sono bersagli a sé: hanno soglia larga e non
            // dipendono dall'essere figli interattivi. Senza questo, prendere il
            // telecomando dipendeva dal caso.
            const HS = window.HoldableSystem;
            if (HS && HS.holdableConfigs) {
                for (const name of HS.holdableConfigs.keys()) {
                    const model = (S.loadedModels || []).find((m) => {
                        const f = (m.userData && m.userData.originalFilename) || m.name || '';
                        return f.split('/').pop().replace(/\.(glb|gltf|obj|stl)$/i, '') === name;
                    });
                    if (model && !HS.isHeld?.(name)) add(model, 'impugnabile');
                }
            }

            // Poi tutti i figli interattivi dei modelli caricati.
            (S.loadedModels || []).forEach((m) => {
                m.traverse((o) => { if (o.isMesh && o.userData && o.userData.interactive) add(o, 'interattivo'); });
            });

            this.candidates = list;
        },

        /**
         * Soglia di contatto, nello spazio in cui la distanza viene misurata.
         *
         * Il contatto si misura sul cursore, non sul polpastrello — ma la
         * soglia si vuole esprimere in distanza VERA: il bersaglio scatta
         * quando il dito è a {@link POKE_ENTER} da esso, punto. Su un bersaglio
         * guidato, a quella distanza il cursore ha già percorso quasi tutto il
         * tratto, e ciò che gli resta è la soglia da usare.
         *
         * Derivarla invece di scriverla a mano tiene insieme le due cose: se si
         * cambia raggio o forza del magnete, la distanza di attivazione resta
         * esattamente {@link POKE_ENTER} senza ritarature.
         */
        _radiusFor: function (c) {
            if (c.kind === 'impugnabile') return GRAB_ENTER;
            if (c.kind === 'evidenziato') return POKE_ENTER * (1 - this._assistFor(c, POKE_ENTER));
            return POKE_ENTER;
        },

        /**
         * Forza dell'attrazione magnetica su un bersaglio, data la distanza
         * grezza del dito.
         *
         * @returns {number} 0 = nessuna attrazione, 1 = cursore esattamente sul
         *          punto di interazione. Curva smoothstep: parte da zero al
         *          bordo del campo e cresce dolcemente, così l'aggancio si
         *          sente come un'attrazione e non come uno scatto.
         */
        _assistFor: function (c, dist) {
            if (!c || c.kind !== 'evidenziato') return 0;
            if (SNAP_STRENGTH <= 0 || dist >= SNAP_RANGE) return 0;
            const u = 1 - dist / SNAP_RANGE;
            return u * u * (3 - 2 * u) * SNAP_STRENGTH;
        },

        // =====================================================================
        // Aggancio
        // =====================================================================

        /*
         * Nella realtà un pulsante trattiene il polpastrello: c'è l'attrito, c'è
         * la superficie che oppone resistenza, e la mano non scivola via mentre
         * si preme. In VR non c'è niente di tutto questo — il dito attraversa il
         * comando come aria, e il tocco non si sente mai "arrivato".
         *
         * L'aggancio restituisce quella sensazione con l'unico canale che resta:
         * la vista. Al contatto la mano DISEGNATA si ferma sul punto e i piccoli
         * movimenti non la spostano più. Il dito vero continua a essere seguito
         * dalla logica — è lui a dire quando l'aggancio finisce — ma sullo
         * schermo la mano è tenuta. Solo uscendo dalla tolleranza torna libera,
         * rientrando sulla posizione vera in una frazione di secondo.
         *
         * L'aggancio si arma sul contatto e non si riarma da solo: se il dito
         * esce dalla tolleranza restando dentro il bersaglio, la mano resta
         * libera finché non si stacca e si torna a premere. Riagganciare a metà
         * di un movimento volontario sarebbe una mano che si incolla da sola.
         */

        /**
         * @param {object} cand candidato appena toccato.
         * @param {THREE.Vector3} [ref] punto della mano che ha toccato. È il
         *        vettore vivo, riusato di frame in frame da `_updateTip`:
         *        tenerne il riferimento è il modo per seguire proprio quel
         *        polpastrello, che non è detto sia l'indice — un comando lo si
         *        può sfiorare col pollice.
         */
        _latch: function (s, cand, ref) {
            // Afferrare è un gesto di trasporto, non di pressione: bloccare la
            // mano mentre prende un oggetto la farebbe sembrare rotta.
            if (!cand || cand.kind === 'impugnabile' || LATCH_TOLERANCE <= 0) return;

            const THREE = window.THREE;
            const live = ref || s.tip;
            const point = new THREE.Vector3();
            cand.box.clampPoint(live, point);
            s.latch = { cand, live, at: live.clone(), point };
        },

        /** Scioglie l'aggancio. La mano non torna di scatto: ci pensa il decay. */
        _unlatch: function (s) {
            s.latch = null;
        },

        /** L'aggancio regge ancora? Sotto-stato del contatto, muore con lui. */
        _updateLatch: function (s) {
            if (!s.latch) return;
            if (!s.engaged) return this._unlatch(s);
            if (s.latch.live.distanceTo(s.latch.at) > LATCH_TOLERANCE) this._unlatch(s);
        },

        /**
         * Dove va MOSTRATO il polpastrello, e di conseguenza dove va disegnata
         * la mano.
         *
         * Sfera gialla e mano sono la stessa cosa: la sfera è la punta del dito,
         * non un puntatore a sé. Muoverla verso il bersaglio lasciando indietro
         * la mano — com'era all'inizio — spezza proprio l'illusione che il
         * magnete dovrebbe creare: si vede un pallino che va da una parte e una
         * mano che resta dall'altra. Quindi lo stesso scostamento vale per
         * entrambi, sempre: durante l'attrazione e durante l'aggancio.
         *
         * Il dito VERO non si sposta mai: la logica di contatto continua a
         * misurare quello. Qui si decide solo cosa si vede.
         */
        _guide: function (s, near, dist, nearTip) {
            const ref = s.latch ? s.latch.live : (nearTip || s.tip);
            let guiding = false;
            s.snapW = 0;

            if (s.latch) {
                // Agganciati il punto è fisso: il polpastrello mostrato resta
                // posato lì mentre quello vero vaga dentro la tolleranza.
                s._holdTarget.copy(s.latch.point).sub(ref);
                s.snapW = 1;
                guiding = true;
            } else if (near) {
                const w = this._assistFor(near, dist);
                if (w > 0) {
                    near.box.clampPoint(ref, this._tmpB);
                    s._holdTarget.copy(this._tmpB).sub(ref).multiplyScalar(w);
                    s.snapW = w;
                    guiding = true;
                }
            }

            if (guiding) {
                // Esatto, senza inerzia: la mano è dove è la sfera.
                s.holdOffset.copy(s._holdTarget);
            } else {
                // Fuori dalla guida si rientra, non si salta.
                s.holdOffset.multiplyScalar(1 - GUIDE_RELEASE);
                if (s.holdOffset.lengthSq() < 1e-10) s.holdOffset.set(0, 0, 0);
            }
            s.guided.copy(ref).add(s.holdOffset);
        },

        /**
         * Lo scostamento vive in coordinate mondo, ma va applicato a nodi che
         * stanno in altri spazi (il rig è scalato e può essere ruotato dagli
         * scatti del thumbstick). Si converte trasformando due punti e
         * sottraendo: vale per qualunque catena di trasformazioni.
         *
         * @param {THREE.Object3D} obj nodo nel cui spazio locale serve lo scostamento.
         * @param {THREE.Vector3} out destinazione.
         */
        _offsetIn: function (obj, worldOffset, out) {
            if (worldOffset.lengthSq() === 0) return out.set(0, 0, 0);
            this._tmpD.set(0, 0, 0);
            obj.worldToLocal(this._tmpD);        // dov'è l'origine del mondo, in locale
            out.copy(worldOffset);
            obj.worldToLocal(out);               // dov'è il punto spostato, in locale
            return out.sub(this._tmpD);          // la differenza è lo scostamento
        },

        // =====================================================================
        // Frame
        // =====================================================================

        update: function () {
            if (!this.enabled) return;
            const now = performance.now();

            if (now - this._lastRebuild > CANDIDATE_REFRESH_MS) {
                this._lastRebuild = now;
                this._rebuildCandidates();
            }

            const S = window.Scene3D;
            const blocked = S.tutorialTracker && S.tutorialTracker.interactionsBlocked;
            let hovered = null;

            for (const s of this.sources) {
                // La mano si disegna DOPO aver deciso l'aggancio: la posa
                // mostrata dipende da quello.
                if (!this._updateTip(s) || blocked) {
                    s.cursor.visible = false;
                    s.engaged = null;
                    this._unlatch(s);
                    this._guide(s, null, Infinity, null);   // la mano rientra
                    this._updateHandVisual(s);
                    continue;
                }

                const { hit, hitTip, near, dist, nearTip } = this._probe(s.tips);

                // Isteresi: si esce solo oltre la soglia allargata, così un dito
                // che trema sul bordo non ripete il comando. Si misura sulla
                // distanza VERA, come l'ingresso: entrata a 1 cm dal bersaglio,
                // uscita a 2,2. Per premere di nuovo bisogna staccarsi davvero.
                if (s.engaged) {
                    let d = Infinity;
                    for (const t of s.tips) d = Math.min(d, s.engaged.box.distanceToPoint(t));
                    const exit = s.engaged.kind === 'impugnabile' ? GRAB_ENTER * 1.8 : POKE_EXIT;
                    if (d > exit) { s.engaged = null; this._unlatch(s); }
                } else if (hit) {
                    s.engaged = hit;
                    this._press(hit.mesh, s);
                    this._latch(s, hit, hitTip);
                }

                s.near = near ? near.mesh : null;
                if (near) hovered = near.mesh;

                // Aggancio e attrazione decidono insieme dove si vede la punta
                // del dito; la mano ci va dietro, non resta indietro.
                this._updateLatch(s);
                this._guide(s, near, dist, nearTip);
                this._updateHandVisual(s);

                // Il cursore compare solo vicino a un bersaglio: lontano, la mano
                // deve restare la mano.
                s.cursor.visible = !!near;
                if (near) {
                    s.cursor.position.copy(s.guided);
                    this.xr.rig.worldToLocal(s.cursor.position);
                    s.cursor.material.color.setHex(
                        now < s.flashUntil ? CURSOR_HIT : (s.snapW > 0.5 ? CURSOR_SNAP : CURSOR_NEAR)
                    );

                    // Si ingrossa avvicinandosi — è più facile da vedere — e si
                    // richiude mentre il magnete aggancia: la punta torna
                    // sottile proprio quando serve mirare.
                    const t = Math.max(0, 1 - (dist - POKE_ENTER) / NEAR_RANGE);
                    s.cursor.scale.setScalar(1 + t * (1 - s.snapW) * 0.8);
                }
            }

            this._updateHighlights(now);

            if (window.InteractiveObject3D) window.InteractiveObject3D.handleHover(hovered);
            if (window.XRLocomotion) window.XRLocomotion.update(this.sources);
        },

        /**
         * @param {THREE.Vector3[]} tips punti della mano che contano come contatto.
         * @returns {{hit:?object, hitTip:?THREE.Vector3, near:?object,
         *            dist:number, nearTip:?THREE.Vector3}}
         *          bersaglio toccato e punto della mano che l'ha toccato,
         *          bersaglio vicino, distanza grezza e punto più vicino.
         */
        _probe: function (tips) {
            let hit = null;
            let hitTip = null;
            let near = null;
            let nearTip = null;
            let bestHit = Infinity;
            let bestNear = Infinity;

            for (const c of this.candidates) {
                const radius = this._radiusFor(c);
                // Basta che UNO dei punti tocchi: un oggetto lo si prende col
                // palmo o col pollice, non solo con la punta dell'indice.
                let d = Infinity;
                let tip = null;
                for (const t of tips) {
                    const dt = c.box.distanceToPoint(t);
                    if (dt < d) { d = dt; tip = t; }
                }

                // Il contatto si misura sul cursore, che il magnete ha già
                // portato avanti: `dEff` è la distanza fra la sfera gialla e il
                // bersaglio. Sui candidati senza assistenza coincide con `d`.
                const dEff = d * (1 - this._assistFor(c, d));

                if (dEff <= radius && dEff < bestHit) { bestHit = dEff; hit = c; hitTip = tip; }
                if (d <= Math.max(NEAR_RANGE, radius) && d < bestNear) {
                    bestNear = d; near = c; nearTip = tip;
                }
            }
            return { hit, hitTip, near, dist: bestNear, nearTip };
        },

        // =====================================================================
        // Segnalazione dei bersagli
        // =====================================================================

        /*
         * Sul desktop il bersaglio dello step è indicato da un cerchio giallo
         * disegnato da `HighlightCircleManager` — che è DOM, posizionato in pixel,
         * quindi in `immersive-vr` semplicemente non esiste. Senza sostituto non
         * si capisce cosa toccare.
         *
         * Qui l'equivalente è un anello 3D attorno al bersaglio, orientato verso
         * chi guarda e pulsante. Vale per i pulsanti richiesti dallo step e per
         * gli oggetti impugnabili.
         */

        /** Anelli attorno ai bersagli che lo step sta chiedendo. */
        _updateHighlights: function (now) {
            const THREE = window.THREE;
            const S = window.Scene3D;
            const wanted = this.candidates.filter((c) => c.kind === 'evidenziato' || c.kind === 'impugnabile');

            while (this._rings.length < wanted.length) {
                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.84, 1.0, 40),
                    new THREE.MeshBasicMaterial({
                        color: HL_COLOR, transparent: true, opacity: 0.85,
                        side: THREE.DoubleSide, depthTest: false,
                    })
                );
                ring.renderOrder = 997;
                S.scene.add(ring);
                this._rings.push(ring);
            }

            const camPos = S.camera.getWorldPosition(this._tmpA);
            // Pulsazione lenta: attira lo sguardo senza diventare fastidiosa.
            const pulse = 0.72 + 0.28 * Math.sin(now / 320);

            this._rings.forEach((ring, i) => {
                const c = wanted[i];
                if (!c) { ring.visible = false; return; }

                const box = c.box;

                /*
                 * L'anello va dove si tocca, non al baricentro. Su un pulsante
                 * coincidono; su una porta alta due metri no — il baricentro
                 * cade a mezz'aria in mezzo all'anta, mentre il punto utile sta
                 * sul bordo verso cui ci si avvicina.
                 *
                 * Si usa il punto del box più vicino alla mano, cioè esattamente
                 * quello che il test di contatto misura: l'anello indica così il
                 * punto che fa scattare l'azione. Senza mani tracciate, il più
                 * vicino a chi guarda.
                 */
                let ref = camPos;
                let best = Infinity;
                for (const s of this.sources) {
                    for (const t of s.tips) {
                        const d = box.distanceToPoint(t);
                        if (d < best) { best = d; ref = t; }
                    }
                }
                box.clampPoint(ref, ring.position);

                const size = box.getSize(this._tmpB);
                /*
                 * Raggio limitato in alto e in basso. Legarlo solo all'ingombro
                 * dava un anello gigantesco attorno alla porta: l'indicatore deve
                 * restare un segno di dimensione umana, come il cerchio giallo
                 * del desktop che ha misura fissa a schermo. Tenuto piccolo di
                 * proposito: il colore giallo dell'elemento (che ci mette
                 * `InteractiveObject3D.applyButtonHighlight`) dice GIÀ cosa
                 * toccare; l'anello serve a dire DOVE, e basta un segno.
                 */
                const r = Math.min(RING_MAX, Math.max(RING_MIN, Math.max(size.x, size.y, size.z) * 0.35));

                /*
                 * Quando una mano entra nel campo magnetico l'anello si accende:
                 * è il segnale che il bersaglio è ormai raggiungibile e che il
                 * cursore sta venendo accompagnato sul punto. Fuori dal campo
                 * resta discreto, una presenza che non copre la macchina.
                 */
                let glow = best < SNAP_RANGE ? Math.max(0, 1 - best / SNAP_RANGE) : 0;
                // Agganciato: acceso pieno, senza pulsare. Il bersaglio sta
                // trattenendo il dito, e si deve vedere che è successo qualcosa.
                if (this.sources.some((s) => s.latch && s.latch.cand === c)) glow = 1;

                // Scala quasi ferma, opacità pulsante: un anello che cambia
                // dimensione sembra allontanarsi e rende difficile mirare.
                ring.scale.setScalar(r * (1 + glow * 0.18));
                ring.lookAt(camPos);
                ring.material.opacity = (0.22 + 0.26 * pulse) + glow * 0.45;
                ring.visible = true;
            });
        },

        _clearHighlights: function () {
            const S = window.Scene3D;
            this._rings.forEach((r) => {
                if (r.parent) r.parent.remove(r);
                r.geometry.dispose();
                r.material.dispose();
            });
            this._rings = [];
        },

        /**
         * Lampo emissivo sull'oggetto premuto. È il feedback che sul desktop dà
         * il cursore e che qui manca del tutto: senza, non si distingue una
         * pressione riuscita da un tocco a vuoto.
         */
        _flashMesh: function (mesh) {
            const targets = [];
            mesh.traverse((o) => { if (o.isMesh && o.material) targets.push(o); });
            if (!targets.length && mesh.material) targets.push(mesh);

            targets.forEach((o) => {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => {
                    if (!m.emissive || m.userData._xrFlashing) return;
                    m.userData._xrFlashing = true;
                    const prevColor = m.emissive.getHex();
                    const prevInt = m.emissiveIntensity !== undefined ? m.emissiveIntensity : 1;
                    m.emissive.setHex(HL_COLOR);
                    m.emissiveIntensity = 1.6;
                    setTimeout(() => {
                        m.emissive.setHex(prevColor);
                        m.emissiveIntensity = prevInt;
                        m.userData._xrFlashing = false;
                    }, PRESS_FLASH_MS);
                });
            });
        },

        // =====================================================================
        // Pressione
        // =====================================================================

        /**
         * Stesso ordine di priorità del desktop (`handleModelClick`): figlio
         * interattivo, poi azione sul modello radice.
         */
        _press: function (mesh, s) {
            const S = window.Scene3D;
            const IO = window.InteractiveObject3D;

            if (IO && mesh.userData && mesh.userData.interactive) {
                if (IO.handleClick(mesh, { isXR: true, isPoke: true, point: s.tip.clone() })) {
                    this._flashMesh(mesh);
                    this._confirm(s);
                    this._note(mesh, 'pulsante premuto');
                    return;
                }
            }
            if (IO && IO.highlightedButtons) {
                for (const [, m] of IO.highlightedButtons) {
                    if (m !== mesh) continue;
                    if (IO.handleClick(mesh, { isXR: true, isPoke: true })) {
                        this._flashMesh(mesh);
                        this._confirm(s);
                        this._note(mesh, 'pulsante evidenziato premuto');
                        return;
                    }
                    break;
                }
            }

            const root = S.findRootModel(mesh);
            if (root && S.isModelSelectable(root)) {
                if (S.dragDropSystem && S.dragDropSystem.enabled) {
                    this._note(mesh, 'ignorato: drag&drop attivo', false);
                    return;
                }

                // Lo strumento va equipaggiato PRIMA: `handleModelAction` esce
                // subito se non combacia con quello chiesto dallo step.
                const tool = this._ensureToolForStep();

                const anim = S.animationSystem;
                const before = anim ? anim.activeAnimations.length + anim.multiStepAnimations.size : 0;
                S.handleModelAction(root);
                const after = anim ? anim.activeAnimations.length + anim.multiStepAnimations.size : 0;

                this._flashMesh(mesh);
                this._confirm(s);
                const suffix = tool ? ` (strumento ${tool})` : '';
                this._note(mesh,
                    after > before ? `azione avviata su ${root.name}${suffix}` : `nessun effetto su ${root.name}${suffix}`,
                    after > before);
            } else {
                this._note(mesh, 'nessun gestore per questa mesh', false);
            }
        },

        /**
         * Equipaggia lo strumento che lo step richiede.
         *
         * Sul desktop lo strumento si sceglie dalla legenda in basso a destra:
         * è DOM, quindi in `immersive-vr` non esiste e nessuno può cliccarla —
         * `ToolsManager.getActiveTool()` resta `null` per tutta la sessione.
         * `Scene3D.handleModelAction` però esce subito quando lo strumento
         * attivo non è quello richiesto, e questo è il motivo per cui la porta
         * non si apriva: il contatto veniva rilevato e l'azione scartata un
         * istante dopo, senza alcun segnale. Stessa sorte per ogni step con
         * `do :` — chiave, spray, naso dell'elettromandrino.
         *
         * In VR la mano è la mano: lo strumento dello step si equipaggia da sé.
         * Quando ci sarà la scelta degli strumenti in-world (Milestone 4) questo
         * resterà come ripiego per gli step che non la offrono.
         *
         * @returns {?string} strumento equipaggiato, o null se non serviva.
         */
        _ensureToolForStep: function () {
            const S = window.Scene3D;
            const TM = window.ToolsManager;
            if (!S || !TM || typeof TM.toggleTool !== 'function') return null;
            if (typeof S.getCurrentTutorialStep !== 'function') return null;

            const step = S.getCurrentTutorialStep();
            if (!step) return null;

            const required = S.getRequiredToolForStep(step);
            if (!required) return null;
            if (TM.getActiveTool() === required) return required;

            TM.toggleTool(required);
            console.log(`[XRInput] 🔧 Strumento equipaggiato dallo step: ${required}`);
            return required;
        },

        /** Registra l'esito dell'ultimo tocco, per il riepilogo di XRLog. */
        _note: function (mesh, esito, ok) {
            const name = (mesh && mesh.name) || '?';
            this.lastTouch = { name, esito, ok: ok !== false, at: Date.now() };
            console.log(`[XRInput] 👆 ${name} → ${esito}`);
        },

        /** Vibrazione dove c'è, lampo del cursore sempre: le mani non hanno aptica. */
        _confirm: function (s) {
            const gp = s.inputSource && s.inputSource.gamepad;
            const act = gp && gp.hapticActuators && gp.hapticActuators[0];
            if (act && act.pulse) { try { act.pulse(0.6, 35); } catch (e) { /* non supportato */ } }
            s.flashUntil = performance.now() + FLASH_MS;
            s.cursor.material.color.setHex(CURSOR_HIT);
        },

        // =====================================================================
        // Debug
        // =====================================================================

        debugInfo: function () {
            const info = {
                attivo: this.enabled,
                sorgenti: this.sources
                    .map((s) => s.inputSource
                        ? `${s.hand}=${s.isHand ? 'mano' : 'controller'}${s.hasTip ? '' : ' (punta assente)'}`
                        : `#${s.index} non connessa`)
                    .join('  |  ') || 'nessuna',
                bersagli: this.candidates.length,
                vicino: this.sources.map((s) => s.near ? s.near.name : '-').join(' | '),
                premuto: this.sources.map((s) => s.engaged ? s.engaged.mesh.name : '-').join(' | '),
                sogliaContatto: `${(POKE_ENTER * 100).toFixed(1)} cm (unità scena)`,
                magnete: `raggio ${(SNAP_RANGE * 100).toFixed(1)} cm, forza ${SNAP_STRENGTH.toFixed(2)}`,
                attrazione: this.sources.map((s) => s.snapW ? `${(s.snapW * 100).toFixed(0)}%` : '-').join(' | '),
                aggancio: this.sources.map((s) => s.latch ? s.latch.cand.mesh.name : '-').join(' | '),
                tolleranzaAggancio: `${(LATCH_TOLERANCE * 100).toFixed(1)} cm`,
                ultimoTocco: this.lastTouch ? `${this.lastTouch.name} → ${this.lastTouch.esito}` : 'nessuno',
            };
            console.table(info);
            return info;
        },

        /**
         * Regola a caldo la tolleranza di contatto, per tararla sul visore senza
         * uscire dalla sessione. L'uscita resta il doppio dell'ingresso: è
         * l'isteresi a impedire che un dito fermo sul bordo ripeta il comando.
         */
        setPokeRadius: function (meters) {
            POKE_ENTER = Math.max(0.005, Math.min(0.10, Number(meters) || POKE_ENTER));
            POKE_EXIT = POKE_ENTER * EXIT_RATIO;
            console.log(`[XRInput] Soglia contatto: ${(POKE_ENTER * 100).toFixed(1)} cm (uscita ${(POKE_EXIT * 100).toFixed(1)} cm)`);
            return POKE_ENTER;
        },

        /**
         * Taratura del magnete dal visore, senza uscire dalla sessione.
         *
         * @param {number} [range] raggio del campo in unità scena. Sotto la
         *        soglia di contatto il magnete non avrebbe spazio per agire.
         * @param {number} [strength] 0 = disattivato (comportamento precedente,
         *        contatto secco sul polpastrello), 1 = il cursore finisce
         *        esattamente sul punto di interazione.
         */
        setSnap: function (range, strength) {
            if (range !== undefined) SNAP_RANGE = Math.max(POKE_ENTER * 1.5, Math.min(0.30, Number(range) || SNAP_RANGE));
            if (strength !== undefined) SNAP_STRENGTH = Math.max(0, Math.min(1, Number(strength)));
            console.log(`[XRInput] Magnete: raggio ${(SNAP_RANGE * 100).toFixed(1)} cm, forza ${SNAP_STRENGTH.toFixed(2)}`);
            return { range: SNAP_RANGE, strength: SNAP_STRENGTH };
        },

        /**
         * Tolleranza dell'aggancio, in unità scena: quanto può vagare il dito
         * prima che la mano disegnata torni libera. 0 disattiva l'aggancio e
         * riporta la mano a seguire sempre la posizione vera.
         */
        setLatch: function (meters) {
            LATCH_TOLERANCE = Math.max(0, Math.min(0.10, Number(meters)));
            if (!LATCH_TOLERANCE) this.sources.forEach((s) => this._unlatch(s));
            console.log(`[XRInput] Tolleranza aggancio: ${(LATCH_TOLERANCE * 100).toFixed(1)} cm`);
            return LATCH_TOLERANCE;
        },

        /** Soglia per afferrare, separata perché il gesto è più grossolano. */
        setGrabRadius: function (meters) {
            GRAB_ENTER = Math.max(0.02, Math.min(0.25, Number(meters) || GRAB_ENTER));
            console.log(`[XRInput] Soglia presa: ${(GRAB_ENTER * 100).toFixed(1)} cm`);
            return GRAB_ENTER;
        },
    };

    window.XRInput = XRInput;
})();
