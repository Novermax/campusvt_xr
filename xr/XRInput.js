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
     */
    let POKE_ENTER = 0.022;
    let POKE_EXIT = 0.040;

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
     */
    let SNAP_RANGE = 0.09;
    let SNAP_STRENGTH = 0.85;

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
                    s.handModel = { root: gltf.scene, bones };
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

        /** Copia la posa di ogni giunto sull'osso omonimo. */
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
            this._rigInv.copy(this.xr.rig.matrixWorld).invert();

            let n = 0;
            for (const name in joints) {
                if (n >= HAND_JOINT_COUNT) break;
                const j = joints[name];
                if (!j || !j.visible) continue;

                const r = j.jointRadius || 0.008;
                this._mat.copy(j.matrixWorld);
                this._mat.premultiply(this._rigInv);          // in coordinate del rig
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

        /** Soglia di contatto: afferrare è più grossolano che premere. */
        _radiusFor: function (c) {
            return c.kind === 'impugnabile' ? GRAB_ENTER : POKE_ENTER;
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
                this._updateHandVisual(s);
                if (!this._updateTip(s) || blocked) { s.cursor.visible = false; s.engaged = null; continue; }

                const { hit, near, dist, nearTip } = this._probe(s.tips);

                // Isteresi: si esce solo oltre la soglia allargata, così un dito
                // che trema sul bordo non ripete il comando. Si misura nello
                // stesso spazio dell'ingresso — quello assistito — altrimenti
                // con il magnete attivo entrata e uscita si sovrappongono e il
                // comando parte a raffica.
                if (s.engaged) {
                    let d = Infinity;
                    for (const t of s.tips) d = Math.min(d, s.engaged.box.distanceToPoint(t));
                    d *= 1 - this._assistFor(s.engaged, d);
                    const exit = s.engaged.kind === 'impugnabile' ? GRAB_ENTER * 1.8 : POKE_EXIT;
                    if (d > exit) s.engaged = null;
                } else if (hit) {
                    s.engaged = hit;
                    // L'oggetto va nella mano che l'ha toccato, non sempre nella
                    // stessa: e' quella che l'utente ha usato.
                    if (hit.kind === 'impugnabile' && window.XRHold) window.XRHold.preferSource(s);
                    this._press(hit.mesh, s);
                }

                s.near = near ? near.mesh : null;
                if (near) hovered = near.mesh;

                // Il cursore compare solo vicino a un bersaglio: lontano, la mano
                // deve restare la mano.
                s.cursor.visible = !!near;
                s.snapW = 0;
                if (near) {
                    const tipRef = nearTip || s.tip;
                    const w = this._assistFor(near, dist);

                    // Il cursore viene accompagnato verso il punto di
                    // interazione — il punto del bersaglio più vicino al dito,
                    // lo stesso che il test di contatto misura e che l'anello
                    // indica. Con w = 0 resta esattamente sul polpastrello:
                    // fuori dal campo magnetico nulla cambia.
                    this._tmpA.copy(tipRef);
                    if (w > 0) {
                        near.box.clampPoint(tipRef, this._tmpB);
                        this._tmpA.lerp(this._tmpB, w);
                        s.snapW = w;
                    }

                    s.cursor.position.copy(this._tmpA);
                    this.xr.rig.worldToLocal(s.cursor.position);
                    s.cursor.material.color.setHex(
                        now < s.flashUntil ? CURSOR_HIT : (w > 0.5 ? CURSOR_SNAP : CURSOR_NEAR)
                    );

                    // Si ingrossa avvicinandosi — è più facile da vedere — e si
                    // richiude mentre il magnete aggancia: la punta torna
                    // sottile proprio quando serve mirare.
                    const t = Math.max(0, 1 - (dist - POKE_ENTER) / NEAR_RANGE);
                    s.cursor.scale.setScalar(1 + t * (1 - w) * 0.8);
                }
            }

            this._updateHighlights(now);

            if (window.InteractiveObject3D) window.InteractiveObject3D.handleHover(hovered);
            if (window.XRLocomotion) window.XRLocomotion.update(this.sources);
        },

        /**
         * @param {THREE.Vector3[]} tips punti della mano che contano come contatto.
         * @returns {{hit:?object, near:?object, dist:number, nearTip:?THREE.Vector3}}
         *          bersaglio toccato, bersaglio vicino, distanza grezza e punto
         *          della mano che se ne sta più vicino.
         */
        _probe: function (tips) {
            let hit = null;
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

                if (dEff <= radius && dEff < bestHit) { bestHit = dEff; hit = c; }
                if (d <= Math.max(NEAR_RANGE, radius) && d < bestNear) {
                    bestNear = d; near = c; nearTip = tip;
                }
            }
            return { hit, near, dist: bestNear, nearTip };
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
                const glow = best < SNAP_RANGE ? Math.max(0, 1 - best / SNAP_RANGE) : 0;

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
            POKE_EXIT = POKE_ENTER * 1.8;
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

        /** Soglia per afferrare, separata perché il gesto è più grossolano. */
        setGrabRadius: function (meters) {
            GRAB_ENTER = Math.max(0.02, Math.min(0.25, Number(meters) || GRAB_ENTER));
            console.log(`[XRInput] Soglia presa: ${(GRAB_ENTER * 100).toFixed(1)} cm`);
            return GRAB_ENTER;
        },
    };

    window.XRInput = XRInput;
})();
