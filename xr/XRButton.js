/**
 * XRButton.js — pulsante di ingresso/uscita dalla sessione immersiva.
 *
 * Scritto a mano invece di usare l'addon `VRButton.js` di Three.js: sono ~40
 * righe utili, e così non aggiungiamo un file da tenere allineato alla r155 né
 * dipendenze da CDN esterne (che la pipeline offline di CVT non gradirebbe).
 *
 * Compare solo quando la scena 3D esiste, cioè dentro uno scenario: prima non
 * ci sarebbe niente da vedere in VR.
 */

(function () {
    'use strict';

    /** Altezze occhi selezionabili, in metri. null = statura reale dell'operatore. */
    const EYE_HEIGHTS = [
        { label: 'Altezza reale', value: null },
        { label: '150 cm', value: 1.50 },
        { label: '160 cm', value: 1.60 },
        { label: '165 cm', value: 1.65 },
        { label: '170 cm', value: 1.70 },
        { label: '175 cm', value: 1.75 },
        { label: '180 cm', value: 1.80 },
    ];

    const XRButton = {
        el: null,
        bar: null,
        xr: null,

        /**
         * @param {object} xrSession istanza di window.XRSession
         * @param {{supported:boolean, reason:string}} probe esito della sonda capability
         */
        mount: function (xrSession, probe) {
            if (this.el) return;
            this.xr = xrSession;

            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'xr-enter-btn';
            this.el = el;

            if (!probe.supported) {
                el.classList.add('xr-enter-btn--disabled');
                el.disabled = true;
                el.textContent = '🥽 VR non disponibile';
                el.title = probe.reason;
            } else {
                el.textContent = '🥽 Entra in VR';
                el.title = 'Avvia la sessione immersiva sul visore';
                el.addEventListener('click', () => this._toggle());
            }

            const bar = document.createElement('div');
            bar.className = 'xr-bar';
            bar.appendChild(el);
            // Sempre presenti, anche dove immersive-vr manca: le impostazioni sono
            // persistite, quindi si preparano da desktop e poi si indossa il visore.
            bar.appendChild(this._buildScaleSlider(xrSession));
            bar.appendChild(this._buildCursorToggle());
            bar.appendChild(this._buildPanelDepthToggle(xrSession));
            bar.appendChild(this._buildHeightPicker(xrSession));
            bar.appendChild(this._buildGripPanel());
            document.body.appendChild(bar);
            this.bar = bar;

            // Il log va letto uscendo dalla sessione, quindi vive qui sulla 2D.
            if (window.XRLog) window.XRLog.mount(bar);

            xrSession.on('enter', () => this._setState(true));
            xrSession.on('exit', () => {
                this._setState(false);
                // Si apre da solo appena si torna alla 2D: è l'unico momento in
                // cui il log si può leggere comodamente, e cercarlo a mano dentro
                // il visore è scomodo.
                if (window.XRLog) window.XRLog.toggle(true);
            });
            // La scala si può tarare col thumbstick dentro la sessione: al ritorno
            // lo slider deve mostrare il valore effettivamente raggiunto.
            xrSession.on('scale', () => this._syncScale());
        },

        /**
         * Scala del mondo. Slider e non menu a tendina: serve per fare prove, e il
         * valore giusto si trova per tentativi.
         */
        _buildScaleSlider: function (xrSession) {
            const wrap = document.createElement('label');
            wrap.className = 'xr-scale';
            wrap.title = 'Quanto appare grande la macchina.\n'
                + 'Regolabile anche dentro la sessione, col thumbstick destro su/giù.';

            const txt = document.createElement('span');
            txt.textContent = 'Scala mondo';
            wrap.appendChild(txt);

            const input = document.createElement('input');
            input.type = 'range';
            input.min = '0.5';
            input.max = '2.5';
            input.step = '0.05';
            input.value = String(xrSession.getWorldScale());
            wrap.appendChild(input);

            const out = document.createElement('output');
            out.textContent = (+input.value).toFixed(2) + '×';
            wrap.appendChild(out);

            input.addEventListener('input', () => {
                out.textContent = (+input.value).toFixed(2) + '×';
                xrSession.setWorldScale(parseFloat(input.value));
            });

            this._scaleInput = input;
            this._scaleOutput = out;
            return wrap;
        },

        /**
         * Sfera gialla sul polpastrello: accesa o spenta.
         *
         * Sta qui e non solo in `XRInput.setCursor()` per un motivo pratico:
         * **dentro il visore la console non esiste**. Ogni regolazione che non
         * abbia un comando sulla pagina 2D, di fatto, non è regolabile da chi
         * sta provando. La scelta viene ricordata, quindi si fa una volta prima
         * di entrare e vale da lì in poi.
         */
        _buildCursorToggle: function () {
            const wrap = document.createElement('label');
            wrap.className = 'xr-toggle';
            wrap.title = 'Come si vede dove stai per toccare.\n\n'
                + '• Pallina sul dito — il segno storico.\n'
                + '• Punto sul bersaglio — nessuna pallina sulla mano, ma un disco\n'
                + '  dove il tocco scattera\'.\n'
                + '• Niente — sconsigliato: la mano e\' una mesh normale e viene\n'
                + '  coperta dalla macchina proprio quando il dito ci arriva sopra,\n'
                + '  quindi mirare diventa impossibile.';

            const txt = document.createElement('span');
            txt.textContent = 'Segno di contatto';

            const sel = document.createElement('select');
            [['sfera', 'Pallina sul dito'],
             ['punto', 'Punto sul bersaglio'],
             ['niente', 'Niente (sconsigliato)']].forEach(([v, label]) => {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = label;
                sel.appendChild(o);
            });
            sel.value = window.XRInput ? window.XRInput.getCursorMode() : 'sfera';
            sel.addEventListener('change', () => {
                if (window.XRInput) window.XRInput.setCursorMode(sel.value);
            });

            wrap.appendChild(txt);
            wrap.appendChild(sel);
            return wrap;
        },

        /**
         * Dove sta l'interfaccia: dentro il mondo o davanti a tutto.
         *
         * Le due scelte hanno ciascuna un difetto, e quale pesi di più dipende
         * da dove si è: dentro il mondo la mano copre il fumetto — che è ciò
         * che ci si aspetta — ma infilando la testa nella macchina la
         * pulsantiera finisce dentro la lamiera e sparisce. Sempre davanti non
         * sparisce mai, ma copre anche le proprie dita.
         *
         * Il comando sta qui, sulla pagina 2D, per lo stesso motivo del segno di
         * contatto: dentro il visore non c'è console, e una regolazione senza
         * comando non è regolabile da chi sta provando.
         */
        _buildPanelDepthToggle: function (xrSession) {
            const wrap = document.createElement('label');
            wrap.className = 'xr-toggle';
            wrap.title = 'Fumetto, strumenti e card della hall.\n\n'
                + '• Dentro il mondo — la mano che ci passa davanti li copre,\n'
                + '  come per ogni altro oggetto. Ma dentro la macchina possono\n'
                + '  finire nascosti da un pezzo di lamiera.\n'
                + '• Sempre davanti — non spariscono mai, ma coprono anche le dita.';

            const txt = document.createElement('span');
            txt.textContent = 'Pannelli';

            const sel = document.createElement('select');
            [['1', 'Dentro il mondo'], ['0', 'Sempre davanti']].forEach(([v, label]) => {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = label;
                sel.appendChild(o);
            });
            sel.value = xrSession.getPanelDepth() ? '1' : '0';
            sel.addEventListener('change', () => xrSession.setPanelDepth(sel.value === '1'));

            wrap.appendChild(txt);
            wrap.appendChild(sel);
            return wrap;
        },

        /**
         * Pannello di taratura dell'impugnatura: tre rotazioni e tre offset,
         * tutti simultanei.
         *
         * Serve un pannello e non un paio di menu perché la posa giusta richiede
         * più rotazioni combinate, e quale combinazione funzioni dipende da come
         * il modello è orientato nel proprio GLB — non è deducibile, va provato.
         * Con incrementi di 90° sui tre assi si raggiungono tutti e 24 gli
         * orientamenti possibili, qualunque sia l'ordine di composizione.
         *
         * Pulsanti − e + invece di slider: si preme col dito dentro un visore, e
         * uno slider non permette di essere precisi.
         */
        _buildGripPanel: function () {
            const btn = document.createElement('button');
            btn.type = 'button';
            // Classe propria oltre a quella condivisa: due pulsanti con lo stesso
            // nome rendono ambiguo qualunque selettore.
            btn.className = 'xr-log-btn xr-grip-btn';
            btn.textContent = '🎛 Impugnatura';
            btn.title = 'Regola come sta in mano l\'oggetto impugnato.';
            btn.addEventListener('click', () => this._toggleGrip());

            const panel = document.createElement('div');
            panel.className = 'xr-grip-panel';
            panel.hidden = true;

            const head = document.createElement('div');
            head.className = 'xr-log-head';
            head.innerHTML = '<strong>Impugnatura</strong>';
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.textContent = 'Azzera';
            reset.addEventListener('click', () => {
                window.XRHold?.setGrip(0, 0, 0, 0, 0, 0);
                this._syncGrip();
            });
            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '✕';
            close.addEventListener('click', () => this._toggleGrip(false));
            head.appendChild(reset);
            head.appendChild(close);
            panel.appendChild(head);

            const body = document.createElement('div');
            body.className = 'xr-grip-body';
            this._gripRows = {};

            const addRow = (key, label, step, unit, fmt) => {
                const row = document.createElement('div');
                row.className = 'xr-grip-row';

                const l = document.createElement('span');
                l.className = 'xr-grip-label';
                l.textContent = label;

                const minus = document.createElement('button');
                minus.type = 'button';
                minus.textContent = '−';

                const val = document.createElement('span');
                val.className = 'xr-grip-value';

                const plus = document.createElement('button');
                plus.type = 'button';
                plus.textContent = '+';

                const bump = (d) => {
                    const g = window.XRHold.getGrip();
                    const next = {};
                    next[key] = Math.round((g[key] + d * step) * 1000) / 1000;
                    window.XRHold.setGrip(
                        key === 'x' ? next.x : undefined, key === 'y' ? next.y : undefined,
                        key === 'z' ? next.z : undefined, key === 'rx' ? next.rx : undefined,
                        key === 'ry' ? next.ry : undefined, key === 'rz' ? next.rz : undefined
                    );
                    this._syncGrip();
                };
                minus.addEventListener('click', () => bump(-1));
                plus.addEventListener('click', () => bump(1));

                row.append(l, minus, val, plus);
                body.appendChild(row);
                this._gripRows[key] = { val, unit, fmt };
            };

            addRow('rx', 'Rotazione X', 90, '°', (v) => Math.round(v));
            addRow('ry', 'Rotazione Y', 90, '°', (v) => Math.round(v));
            addRow('rz', 'Rotazione Z', 90, '°', (v) => Math.round(v));
            addRow('x', 'Offset X', 0.005, ' cm', (v) => (v * 100).toFixed(1));
            addRow('y', 'Offset Y', 0.005, ' cm', (v) => (v * 100).toFixed(1));
            addRow('z', 'Offset Z', 0.005, ' cm', (v) => (v * 100).toFixed(1));

            panel.appendChild(body);
            document.body.appendChild(panel);
            this._gripPanel = panel;
            this._syncGrip();
            return btn;
        },

        _toggleGrip: function (force) {
            if (!this._gripPanel) return;
            this._gripPanel.hidden = force === undefined ? !this._gripPanel.hidden : !force;
            if (!this._gripPanel.hidden) {
                this._syncGrip();
                // Un pannello alla volta: sovrapposti sono illeggibili nel visore.
                if (window.XRLog) window.XRLog.toggle(false);
            }
        },

        _syncGrip: function () {
            if (!this._gripRows || !window.XRHold) return;
            const g = window.XRHold.getGrip();
            Object.entries(this._gripRows).forEach(([k, r]) => {
                r.val.textContent = r.fmt(g[k]) + r.unit;
            });
        },

        /** Riallinea lo slider al valore corrente, dopo la taratura col thumbstick. */
        _syncScale: function () {
            if (!this._scaleInput) return;
            const s = this.xr.getWorldScale();
            this._scaleInput.value = String(s);
            this._scaleOutput.textContent = s.toFixed(2) + '×';
        },

        /**
         * Selettore dell'altezza occhi. Sta qui, sulla pagina 2D, perché in VR non
         * c'è ancora modo di interagire: i controller arrivano con la milestone 3.
         * La scelta è persistita, quindi si imposta una volta sola.
         */
        _buildHeightPicker: function (xrSession) {
            const wrap = document.createElement('label');
            wrap.className = 'xr-height';
            wrap.title = 'Altezza degli occhi dell\'operatore sopra il pavimento.\n'
                + 'Utile se la calibrazione del pavimento del visore è imprecisa, '
                + 'o per far vedere la macchina a tutti dalla stessa altezza.';

            const txt = document.createElement('span');
            txt.textContent = 'Altezza occhi';
            wrap.appendChild(txt);

            const sel = document.createElement('select');
            const current = xrSession.getEyeHeight();
            EYE_HEIGHTS.forEach((o) => {
                const opt = document.createElement('option');
                opt.textContent = o.label;
                opt.value = o.value === null ? 'auto' : String(o.value);
                if ((current === null && o.value === null) || current === o.value) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.addEventListener('change', () => {
                xrSession.setEyeHeight(sel.value === 'auto' ? null : parseFloat(sel.value));
            });
            wrap.appendChild(sel);
            return wrap;
        },

        _toggle: async function () {
            const el = this.el;
            el.disabled = true;
            try {
                if (this.xr.isPresenting) {
                    await this.xr.exitVR();
                } else {
                    el.textContent = '🥽 Avvio…';
                    const ok = await this.xr.enterVR();
                    if (!ok) {
                        el.textContent = '🥽 Avvio fallito — riprova';
                        setTimeout(() => this._setState(false), 2500);
                    }
                }
            } finally {
                el.disabled = false;
            }
        },

        _setState: function (presenting) {
            if (!this.el) return;
            this.el.textContent = presenting ? '🥽 Esci dalla VR' : '🥽 Entra in VR';
            this.el.classList.toggle('xr-enter-btn--active', presenting);
        },
    };

    window.XRButton = XRButton;
})();
