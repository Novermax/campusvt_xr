/**
 * XRLocomotion.js — teleport per spostarsi nella scena.
 *
 * MILESTONE 7, anticipata. Serve perché l'interazione è passata al contatto col
 * dito (vedi XRInput.js): se non si punta più da lontano, bisogna potersi
 * avvicinare. Misurato sul tutorial Elettromandrino, 6 elementi su 21 stanno a
 * ~1,20 m dalla spalla, fuori dalla portata del braccio.
 *
 * Il raggio esiste ancora, ma **solo** per mirare il pavimento: non preme nulla.
 *
 * Comandi: mira a terra, poi pinch (mani) o trigger (controller). Con i
 * controller, il thumbstick destro orizzontale ruota a scatti — utile da seduti,
 * dove girarsi fisicamente non è comodo.
 */

(function () {
    'use strict';

    /** Il pavimento è il piano y=0, non la geometria. `pavimento.glb` è una cupola
     *  da 519 x 220 x 220 m: intersecarla darebbe punti ovunque tranne che a terra. */
    const FLOOR_Y = 0;

    /** Limite di distanza dall'origine scena, per non finire a chilometri. */
    const MAX_RANGE = 20;

    /** Mira valida solo se il raggio punta abbastanza in basso: evita di
     *  teleportarsi all'orizzonte con una minima inclinazione della mano. */
    const MIN_DOWN_TILT = 0.15;

    const SNAP_TURN_DEG = 30;
    const SNAP_DEADZONE = 0.6;

    const COLOR_AIM = 0x3ddc84;      // verde: destinazione valida
    const COLOR_IDLE = 0x9fb4c7;     // grigio: non stai mirando a terra
    const COLOR_UI = 0xffd21e;       // giallo: stai puntando un comando del pannello

    /** Quanto va tenuto fermo il raggio su un comando prima che sia premibile. */
    const UI_DWELL_MS = 330;

    const XRLocomotion = {
        enabled: false,
        xr: null,
        input: null,
        marker: null,
        rays: [],
        _plane: null,
        _raycaster: null,
        _tmpMatrix: null,
        _hit: null,
        _snapArmed: true,

        init: function (xrSession, xrInput) {
            if (this.enabled) return;
            const THREE = window.THREE;
            const S = window.Scene3D;

            this.xr = xrSession;
            this.input = xrInput;
            this._raycaster = new THREE.Raycaster();
            this._tmpMatrix = new THREE.Matrix4();
            this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);

            // Un raggio per sorgente, appeso al target ray del controller/mano.
            xrInput.sources.forEach((s) => {
                const geom = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1),
                ]);
                const ray = new THREE.Line(geom, new THREE.LineBasicMaterial({
                    color: COLOR_IDLE, transparent: true, opacity: 0.5, depthTest: false,
                }));
                ray.renderOrder = 998;
                ray.visible = false;
                s.controller.add(ray);
                this.rays.push({ s, ray });

                s.onSelectStart = () => this._onSelect(s);
                s.controller.addEventListener('selectstart', s.onSelectStart);
            });

            // Il marcatore va nella SCENA, non nel rig: indica un punto del mondo,
            // e dentro il rig si sposterebbe insieme all'osservatore.
            const ring = new THREE.Mesh(
                new THREE.RingGeometry(0.18, 0.26, 32).rotateX(-Math.PI / 2),
                new THREE.MeshBasicMaterial({ color: COLOR_AIM, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false })
            );
            ring.renderOrder = 998;
            ring.visible = false;
            S.scene.add(ring);
            this.marker = ring;

            this.enabled = true;
            console.log('[XRLocomotion] Teleport attivo: mira a terra e pinch/trigger.');
        },

        dispose: function () {
            const S = window.Scene3D;
            this.rays.forEach(({ s, ray }) => {
                s.controller.removeEventListener('selectstart', s.onSelectStart);
                if (ray.parent) ray.parent.remove(ray);
                ray.geometry.dispose();
                ray.material.dispose();
            });
            this.rays = [];
            if (this.marker) {
                if (this.marker.parent) S.scene.remove(this.marker);
                this.marker.geometry.dispose();
                this.marker.material.dispose();
                this.marker = null;
            }
            this._hit = null;
            this.enabled = false;
        },

        // =====================================================================
        // Frame
        // =====================================================================

        update: function (sources) {
            if (!this.enabled) return;

            let best = null;
            let bestSource = null;

            this._uiHit = null;
            this._uiSource = null;

            for (const { s, ray } of this.rays) {
                // Una mano impegnata a premere non deve anche mirare: il raggio
                // sparisce, così non si teleporta mentre si preme un pulsante.
                if (!s.inputSource || s.near) { ray.visible = false; continue; }

                // Il pannello ha la precedenza sul pavimento: se lo si sta
                // puntando, quel raggio non è più una mira di teleport.
                const ui = this._aimUI(s);
                if (ui) {
                    ray.visible = true;
                    this._stretch(ray, ui.distance);
                    ray.material.color.setHex(COLOR_UI);

                    // Armato solo dopo un attimo fermo sullo stesso comando.
                    const armed = this._dwell(s, ui.mesh);
                    ray.material.opacity = armed ? 0.95 : 0.35;
                    if (armed && !this._uiHit) { this._uiHit = ui.mesh; this._uiSource = s; }
                    continue;
                }
                this._dwell(s, null);
                ray.material.opacity = 0.5;

                const point = this._aimFloor(s);
                ray.visible = true;

                if (point) {
                    const dist = point.distanceTo(this._origin);
                    this._stretch(ray, dist);
                    ray.material.color.setHex(COLOR_AIM);
                    if (!best) { best = point.clone(); bestSource = s; }
                } else {
                    this._stretch(ray, 3);
                    ray.material.color.setHex(COLOR_IDLE);
                }
            }

            this._hit = best;
            this._hitSource = bestSource;
            if (this.marker) {
                this.marker.visible = !!best;
                if (best) this.marker.position.copy(best);
            }

            this._pollSnapTurn(sources);
        },

        /**
         * Il comando puntato è fermo da abbastanza per poterlo premere?
         *
         * Senza questa attesa il puntamento è pericoloso. Il raggio spazza la
         * scena a ogni movimento del braccio, e un pinch fatto per teleportarsi
         * preme qualunque comando gli capiti sotto in quell'istante: basta che
         * lo strumento sbagliato passi davanti al raggio e ci si ritrova la
         * brugola in mano davanti a un passo da spray. Un comando che si attiva
         * di passaggio è peggio di un comando irraggiungibile.
         *
         * Restare fermi un terzo di secondo sullo stesso bersaglio è invece un
         * gesto che non si fa per caso. Finché non è armato il raggio resta
         * pallido: si vede che si sta puntando qualcosa, ma non ancora che lo
         * si può premere.
         *
         * @returns {boolean} true se il comando è armato.
         */
        _dwell: function (s, mesh) {
            const now = performance.now();
            if (!mesh) { s._uiDwellOn = null; return false; }
            if (s._uiDwellOn !== mesh) {
                s._uiDwellOn = mesh;
                s._uiDwellSince = now;
                return false;
            }
            return now - s._uiDwellSince >= UI_DWELL_MS;
        },

        /**
         * Il raggio sta puntando un comando del pannello?
         *
         * ## Perché non serve una modalità da scegliere
         *
         * Il pannello sta a portata di braccio, ma la colonna degli strumenti e
         * il pulsante OK possono restare al limite, e col dito impegnato a
         * mirare il teleport sembra di dover scegliere fra le due cose. La
         * tentazione è un interruttore "adesso punto l'interfaccia" — cioè uno
         * stato in più da ricordare e da sbagliare.
         *
         * Non serve: **è la direzione a dirlo**. Verso il pannello si stanno
         * scegliendo comandi, verso il pavimento una destinazione. Sono due
         * bersagli che non si sovrappongono mai, quindi la disambiguazione è
         * gratis e non c'è nulla da imparare. Lo stesso principio per cui una
         * mano vicina a un pulsante smette di mirare.
         *
         * Il raggio diventa giallo e si ferma sul pulsante, così si vede cosa si
         * sta per premere; il pinch preme, invece di teleportare.
         *
         * @returns {?{mesh:THREE.Object3D, distance:number}}
         */
        _aimUI: function (s) {
            const UIX = window.XRUI;
            const targets = UIX && UIX.targets ? UIX.targets() : null;
            if (!targets || !targets.length) return null;

            this._tmpMatrix.identity().extractRotation(s.controller.matrixWorld);
            this._raycaster.ray.origin.setFromMatrixPosition(s.controller.matrixWorld);
            this._raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tmpMatrix).normalize();

            const hits = this._raycaster.intersectObjects(targets, false);
            if (!hits.length) return null;
            return { mesh: hits[0].object, distance: hits[0].distance };
        },

        /** @returns {?THREE.Vector3} punto a terra mirato, in coordinate mondo. */
        _aimFloor: function (s) {
            const THREE = window.THREE;
            this._origin = this._origin || new THREE.Vector3();
            this._dir = this._dir || new THREE.Vector3();
            this._out = this._out || new THREE.Vector3();

            this._tmpMatrix.identity().extractRotation(s.controller.matrixWorld);
            this._origin.setFromMatrixPosition(s.controller.matrixWorld);
            this._dir.set(0, 0, -1).applyMatrix4(this._tmpMatrix).normalize();

            if (this._dir.y > -MIN_DOWN_TILT) return null;   // non punta in basso

            this._raycaster.ray.origin.copy(this._origin);
            this._raycaster.ray.direction.copy(this._dir);
            const p = this._raycaster.ray.intersectPlane(this._plane, this._out);
            if (!p) return null;

            return p.length() > MAX_RANGE ? null : p;
        },

        /** Il raggio è figlio del controller: la sua scala è in unità locali,
         *  quindi la distanza mondo va divisa per la scala del rig. */
        _stretch: function (ray, worldDistance) {
            const k = (this.xr.rig && this.xr.rig.scale.x) || 1;
            ray.scale.z = Math.max(0.01, worldDistance / k);
        },

        // =====================================================================
        // Teleport
        // =====================================================================

        _onSelect: function (s) {
            if (!this.enabled) return;
            if (s.near) return;                      // sta premendo: non teleportare

            // Puntando un comando, il pinch preme quello. È la stessa mano e lo
            // stesso gesto: cambia solo dove stava guardando il raggio.
            if (this._uiHit && this._uiSource === s && window.XRUI) {
                window.XRUI.activate(this._uiHit);
                return;
            }

            if (!this._hit || this._hitSource !== s) return;
            this.teleportTo(this._hit);
        },

        /**
         * Sposta il rig sul punto indicato. Si cambia solo X e Z: la Y porta la
         * calibrazione dell'altezza occhi e non va toccata.
         * @param {THREE.Vector3} point
         */
        teleportTo: function (point) {
            const rig = this.xr.rig;
            if (!rig) return;
            rig.position.x = point.x;
            rig.position.z = point.z;
            rig.updateMatrixWorld(true);
            this._pulseAll();
            console.log(`[XRLocomotion] Teleport a (${point.x.toFixed(2)}, ${point.z.toFixed(2)})`);
        },

        // =====================================================================
        // Rotazione a scatti
        // =====================================================================

        /**
         * Solo con i controller: le mani non hanno thumbstick. Serve da seduti,
         * dove girarsi fisicamente non è praticabile.
         * Asse X del thumbstick destro; quello verticale è già la scala del mondo.
         */
        _pollSnapTurn: function () {
            const session = this.xr.session;
            if (!session || !session.inputSources) return;

            let axis = 0;
            for (const src of session.inputSources) {
                if (src.handedness !== 'right' || !src.gamepad) continue;
                const a = src.gamepad.axes;
                axis = a.length >= 4 ? a[2] : (a.length >= 1 ? a[0] : 0);
                break;
            }

            if (Math.abs(axis) < SNAP_DEADZONE) { this._snapArmed = true; return; }
            if (!this._snapArmed) return;            // uno scatto per spinta
            this._snapArmed = false;

            const rig = this.xr.rig;
            rig.rotation.y -= Math.sign(axis) * SNAP_TURN_DEG * Math.PI / 180;
            rig.updateMatrixWorld(true);
        },

        // =====================================================================

        _pulseAll: function () {
            (this.input ? this.input.sources : []).forEach((s) => {
                const gp = s.inputSource && s.inputSource.gamepad;
                const act = gp && gp.hapticActuators && gp.hapticActuators[0];
                if (act && act.pulse) { try { act.pulse(0.4, 25); } catch (e) { /* non supportato */ } }
            });
        },

        debugInfo: function () {
            const info = {
                attivo: this.enabled,
                mirando: this._hit ? `(${this._hit.x.toFixed(2)}, ${this._hit.z.toFixed(2)})` : 'non a terra',
                rigA: this.xr && this.xr.rig ? this.xr.rig.position.toArray().map((n) => +n.toFixed(2)) : null,
                rotazione: this.xr && this.xr.rig ? Math.round(this.xr.rig.rotation.y * 180 / Math.PI) + '°' : null,
            };
            console.table(info);
            return info;
        },
    };

    window.XRLocomotion = XRLocomotion;
})();
