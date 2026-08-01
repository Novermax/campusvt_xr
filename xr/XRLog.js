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

            this.list = document.createElement('div');
            this.list.className = 'xr-log-list';
            panel.appendChild(this.list);

            document.body.appendChild(panel);
            this.panel = panel;
        },

        toggle: function (force) {
            if (!this.panel) return;
            this.panel.hidden = force === undefined ? !this.panel.hidden : !force;
            if (!this.panel.hidden) this._render();
        },

        _render: function () {
            if (!this.list) return;
            this.list.textContent = '';
            this.entries.slice(-80).forEach((e) => {
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
