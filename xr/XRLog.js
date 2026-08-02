/**
 * XRLog.js — registro degli eventi XR, leggibile dal visore.
 *
 * Dentro una sessione immersiva la console non è raggiungibile, e collegare il
 * Quest via `chrome://inspect` richiede developer mode, cavo e un PC. Senza,
 * ogni diagnosi diventa un tentativo alla cieca.
 *
 * Qui si intercettano i messaggi che iniziano per `[XR`, e li si ripropone in un
 * pannello sulla **pagina 2D**: si esce dalla sessione e lo si legge nel browser
 * del visore, senza cavi.
 *
 * Caricato per primo, così cattura anche i messaggi di avvio.
 */

(function () {
    'use strict';

    const MAX = 200;

    const XRLog = {
        entries: [],
        panel: null,
        list: null,

        init: function () {
            ['log', 'warn', 'error'].forEach((level) => {
                const orig = console[level].bind(console);
                console[level] = (...args) => {
                    orig(...args);
                    const first = args[0];
                    if (typeof first === 'string' && first.indexOf('[XR') === 0) this._push(level, args);
                };
            });
        },

        _push: function (level, args) {
            const text = args.map((a) => {
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch (e) { return String(a); }
            }).join(' ');

            const t = new Date();
            const stamp = `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
            this.entries.push({ level, text, stamp });
            if (this.entries.length > MAX) this.entries.shift();
            if (this.panel && !this.panel.hidden) this._render();
        },

        /** @param {HTMLElement} host contenitore in cui inserire il pulsante di apertura. */
        mount: function (host) {
            if (this.panel) return;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'xr-log-btn';
            btn.textContent = '📋 Log XR';
            btn.title = 'Eventi del layer XR. Leggibile dal visore dopo essere usciti dalla sessione.';
            btn.addEventListener('click', () => this.toggle());
            host.appendChild(btn);

            const panel = document.createElement('div');
            panel.className = 'xr-log-panel';
            panel.hidden = true;

            const head = document.createElement('div');
            head.className = 'xr-log-head';
            head.innerHTML = '<strong>Log XR</strong>';

            const copy = document.createElement('button');
            copy.type = 'button';
            copy.textContent = 'Copia';
            copy.addEventListener('click', () => {
                const txt = this.entries.map((e) => `${e.stamp} ${e.text}`).join('\n');
                if (navigator.clipboard) navigator.clipboard.writeText(txt);
            });

            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '✕';
            close.addEventListener('click', () => this.toggle(false));

            head.appendChild(copy);
            head.appendChild(close);
            panel.appendChild(head);

            // Il riepilogo sta in cima e in grande: leggere righe di log dentro
            // un visore è scomodo, quindi le domande a cui serve rispondere sono
            // già risolte qui, in chiaro.
            this.summary = document.createElement('div');
            this.summary.className = 'xr-log-summary';
            panel.appendChild(this.summary);

            this.list = document.createElement('div');
            this.list.className = 'xr-log-list';
            panel.appendChild(this.list);

            document.body.appendChild(panel);
            this.panel = panel;
        },

        /**
         * Congela lo stato mentre la sessione è ancora viva.
         *
         * Senza questo il pannello è inutile: si apre all'uscita dalla VR, cioè
         * dopo che `XRInput.dispose` ha azzerato le sorgenti, `XRHold.detach` ha
         * staccato l'aggancio e lo sfondo è stato ripristinato. Leggerebbe le
         * macerie e riporterebbe "NESSUNO" e "NON installato" anche dopo una
         * sessione andata perfettamente.
         *
         * Va chiamato da XRSession all'inizio di `_onSessionEnd`, prima di
         * qualunque smontaggio.
         */
        captureSession: function (extra) {
            this.snapshot = { rows: this._buildSummary(), ...extra };
        },

        /**
         * Stato dei moduli XR in forma di frasi, non di numeri: va letto dentro
         * un visore, spesso di sfuggita e senza poter scorrere comodamente.
         */
        _buildSummary: function () {
            const X = window.XRSession, XI = window.XRInput, XH = window.XRHold;
            const rows = [];
            const add = (label, value, ok) => rows.push({ label, value, ok });

            if (!X) { add('Layer XR', 'non caricato', false); return rows; }

            add('WebXR', X.supported ? 'disponibile' : 'NON disponibile', !!X.supported);
            add('Scala mondo', X.getWorldScale().toFixed(2) + '×', true);

            // Fluidità: la domanda "perché perde la sincronia" si risolve qui.
            // Se i frame sforano ma il layer XR costa poco, il collo di
            // bottiglia non è nell'interazione.
            const f = X.frameReport && X.frameReport();
            if (f) {
                add('Frame', `${f.medio} medi, peggiore ${f.peggiore}`, parseFloat(f.medio) <= X._frameBudgetMs);
                add('Frame lunghi', `${f.lunghi} oltre ${X._frameBudgetMs} ms`, parseFloat(f.lunghi) < 5);
                add('Costo layer XR', f.layerXR, parseFloat(f.layerXR) < 2);
            }
            add('Sfondo', X._prevBackground !== undefined ? 'azzurro applicato' : 'non applicato (mai entrato in VR?)',
                X._prevBackground !== undefined);

            if (XI) {
                const conn = XI.sources.filter((s) => s.inputSource);
                add('Mani/controller visti', conn.length
                    ? conn.map((s) => `${s.hand} ${s.isHand ? 'mano' : 'controller'}`).join(', ')
                    : 'NESSUNO', conn.length > 0);
                const withMesh = XI.sources.filter((s) => s.handModel).length;
                add('Mesh mano caricata', withMesh ? `sì (${withMesh})` : 'no — restano le sferette', withMesh > 0);
                add('Bersagli premibili', String(XI.candidates.length), XI.candidates.length > 0);
                // La domanda vera quando un elemento non reagisce: è stato
                // toccato? E il tocco è servito a qualcosa?
                const lt = XI.lastTouch;
                add('Ultimo tocco', lt ? `${lt.name} → ${lt.esito}` : 'NESSUNO — mai toccato nulla', !!lt && lt.ok);
                const tool = window.ToolsManager && window.ToolsManager.getActiveTool
                    ? window.ToolsManager.getActiveTool() : null;
                add('Strumento in mano', tool || 'nessuno', !!tool);
            } else {
                add('Input XR', 'non inizializzato', false);
            }

            if (XH) {
                add('Aggancio oggetti', XH.active ? 'installato' : 'NON installato', !!XH.active);
                add('Ultimo oggetto in', XH.anchorParentName || 'mai agganciato', !!XH.anchorParentName);
            }
            return rows;
        },

        _renderSummary: function () {
            if (!this.summary) return;
            this.summary.textContent = '';

            // Lo scatto della sessione ha la precedenza: e' l'unico stato che
            // descrive davvero cos'e' successo in VR.
            const snap = this.snapshot;
            const rows = snap ? snap.rows : this._buildSummary();

            const head = document.createElement('div');
            head.className = 'xr-sum-title';
            head.textContent = snap
                ? `Ultima sessione VR — durata ${snap.durata}`
                : 'Stato attuale (nessuna sessione VR ancora conclusa)';
            this.summary.appendChild(head);

            rows.forEach((r) => {
                const row = document.createElement('div');
                row.className = 'xr-sum-row ' + (r.ok ? 'xr-sum-ok' : 'xr-sum-ko');
                const l = document.createElement('span');
                l.className = 'xr-sum-label';
                l.textContent = r.label;
                const v = document.createElement('span');
                v.className = 'xr-sum-value';
                v.textContent = r.value;
                row.appendChild(l);
                row.appendChild(v);
                this.summary.appendChild(row);
            });
        },

        toggle: function (force) {
            if (!this.panel) return;
            this.panel.hidden = force === undefined ? !this.panel.hidden : !force;
            if (!this.panel.hidden) {
                this._render();
                // Un pannello alla volta: sovrapposti sono illeggibili nel visore.
                if (window.XRButton && window.XRButton._gripPanel) window.XRButton._gripPanel.hidden = true;
            }
        },

        _render: function () {
            this._renderSummary();
            if (!this.list) return;
            this.list.textContent = '';
            this.entries.slice(-40).forEach((e) => {
                const row = document.createElement('div');
                row.className = 'xr-log-row xr-log-' + e.level;
                row.textContent = `${e.stamp}  ${e.text}`;
                this.list.appendChild(row);
            });
            this.list.scrollTop = this.list.scrollHeight;
        },
    };

    XRLog.init();
    window.XRLog = XRLog;
})();
