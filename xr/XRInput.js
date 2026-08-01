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
     * Distanza entro cui un bersaglio è "vicino" e il cursore compare.
     * Tenuta stretta: a 35 cm il cursore restava acceso di continuo, perché il
     * pulpito ha molti figli interattivi ravvicinati.
     */
    const NEAR_RANGE = 0.12;

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
    const CURSOR_HIT = 0xffffff;    // bianco: contatto avvenuto
    const FLASH_MS = 160;

    const XRInput = {
        enabled: false,
        xr: null,
        sources: [],
        candidates: [],

        _raycaster: null,
        _lastRebuild: 0,
        _tmpA: null,
        _tmpB: null,

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

            this.enabled = true;
            console.log('[XRInput] Interazione a contatto attiva. Tocca i comandi col dito.');
        },

        dispose: function () {
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
                hasTip: false,
                engaged: null,      // mesh attualmente "premuta", per l'isteresi
                near: null,
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
            const joints = s.handObj && s.handObj.joints;
            const tipJoint = joints && joints['index-finger-tip'];

            if (tipJoint && tipJoint.visible) {
                s.tip.setFromMatrixPosition(tipJoint.matrixWorld);
                s.hasTip = true;
                s.tipIsFinger = true;
                return true;
            }
            if (s.inputSource && s.controller.visible) {
                s.tip.setFromMatrixPosition(s.controller.matrixWorld);
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

            // Poi tutti i figli interattivi dei modelli caricati.
            (S.loadedModels || []).forEach((m) => {
                m.traverse((o) => { if (o.isMesh && o.userData && o.userData.interactive) add(o, 'interattivo'); });
            });

            this.candidates = list;
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

                const { hit, near, dist } = this._probe(s.tip);

                // Isteresi: si esce solo oltre POKE_EXIT, così un dito che trema
                // sul bordo non ripete il comando.
                if (s.engaged) {
                    const d = s.engaged.box.distanceToPoint(s.tip);
                    if (d > POKE_EXIT) s.engaged = null;
                } else if (hit) {
                    s.engaged = hit;
                    this._press(hit.mesh, s);
                }

                s.near = near ? near.mesh : null;
                if (near) hovered = near.mesh;

                // Il cursore compare solo vicino a un bersaglio: lontano, la mano
                // deve restare la mano.
                s.cursor.visible = !!near;
                if (near) {
                    s.cursor.position.copy(s.tip);
                    this.xr.rig.worldToLocal(s.cursor.position);
                    s.cursor.material.color.setHex(now < s.flashUntil ? CURSOR_HIT : CURSOR_NEAR);
                    const t = Math.max(0, 1 - (dist - POKE_ENTER) / NEAR_RANGE);
                    s.cursor.scale.setScalar(1 + t * 0.8);
                }
            }

            if (window.InteractiveObject3D) window.InteractiveObject3D.handleHover(hovered);
            if (window.XRLocomotion) window.XRLocomotion.update(this.sources);
        },

        /** @returns {{hit:?object, near:?object, dist:number}} bersaglio toccato e bersaglio vicino. */
        _probe: function (tip) {
            let hit = null;
            let near = null;
            let bestHit = Infinity;
            let bestNear = Infinity;

            for (const c of this.candidates) {
                const d = c.box.distanceToPoint(tip);
                if (d <= POKE_ENTER && d < bestHit) { bestHit = d; hit = c; }
                if (d <= NEAR_RANGE && d < bestNear) { bestNear = d; near = c; }
            }
            return { hit, near, dist: bestNear };
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
                    this._confirm(s);
                    console.log(`[XRInput] 👆 ${mesh.name} premuto`);
                    return;
                }
            }
            if (IO && IO.highlightedButtons) {
                for (const [, m] of IO.highlightedButtons) {
                    if (m !== mesh) continue;
                    if (IO.handleClick(mesh, { isXR: true, isPoke: true })) { this._confirm(s); return; }
                    break;
                }
            }

            const root = S.findRootModel(mesh);
            if (root && S.isModelSelectable(root)) {
                if (S.dragDropSystem && S.dragDropSystem.enabled) return;
                S.handleModelAction(root);
                this._confirm(s);
                console.log(`[XRInput] 👆 azione su modello: ${root.name}`);
            }
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
    };

    window.XRInput = XRInput;
})();
