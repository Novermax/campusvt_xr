/**
 * XRCover.js — la copertina, che è anche la schermata di accesso.
 *
 * La versione WebXR si apre su un quadro a tutta pagina con dentro i campi di
 * sempre — utente, password — e il pulsante **ENTRA**. Premutolo, si è dentro:
 * autenticazione, lingua dell'utente, e da lì direttamente nella Home in VR.
 *
 * ## Una schermata sola, e perché
 *
 * Il visore non è un desktop: la pagina si apre in un browser che galleggia in
 * aria, spesso mentre ci si sta ancora sistemando le cinghie. Ogni passaggio in
 * più è un bersaglio in più da centrare con il raggio. Copertina *e poi* login
 * erano due schermate per fare una cosa sola.
 *
 * Ma il motivo vero è tecnico. Entrare in una sessione immersiva richiede una
 * **user activation**: un tocco vero, recente, altrimenti `requestSession` viene
 * rifiutata — è regola dei browser, non scelta nostra. Se il login sta altrove,
 * il gesto che lo conclude è l'ultimo della pagina, e da lì bisognerebbe
 * chiederne un altro per entrare in VR. Mettendo il login *nella* copertina,
 * quel gesto è la pressione di ENTRA: uno solo, e porta fino dentro il mondo.
 *
 * ## Il form è quello di `core/`, spostato — non uno nuovo
 *
 * Qui non si autentica nessuno. `#loginPage` viene **spostato dentro** la
 * copertina, con i suoi campi, il suo submit e la sua logica: `core/` legge
 * `users.txt`, verifica le credenziali, ricava la lingua e ricarica la
 * configurazione tradotta. Riscrivere quel pezzo significherebbe avere due
 * autenticazioni che divergono al primo cambiamento a monte — e una delle due
 * sarebbe la nostra, senza le scadenze account e senza i ruoli.
 *
 * Non tocca `core/`: si sposta un nodo nel DOM e si cambia l'etichetta di un
 * pulsante, tutto da JavaScript.
 */

(function () {
    'use strict';

    /** Etichetta del pulsante, nelle lingue di `users.txt`. La lingua vera si
     *  conosce solo DOPO il login: qui si può solo restare neutri e corti. */
    const ENTRA = 'ENTRA';

    const XRCover = {
        el: null,

        init: function () {
            const el = document.getElementById('xrCover');
            if (!el) return;
            this.el = el;

            // La copertina non deve poter diventare una trappola: se l'immagine
            // non arriva — cache vuota, rete lenta, file rinominato a monte —
            // resta comunque il modulo su fondo pieno. Meglio una copertina
            // spoglia che una pagina che non si supera.
            const art = document.getElementById('xrCoverArt');
            if (art) art.addEventListener('error', () => {
                art.style.display = 'none';
                console.warn('[XRCover] Copertina non caricata: resta il solo modulo di accesso.');
            });

            this._adoptLogin();
            console.log('[XRCover] Copertina con accesso mostrata.');
        },

        /**
         * Porta il login di `core/` dentro la copertina.
         *
         * Si aspetta che esista: `#loginPage` è nel markup statico, ma questo
         * script gira in coda al body e potrebbe arrivare prima che il resto
         * della pagina sia completo. Il polling è breve e si arrende, invece di
         * insistere: senza il form la copertina non deve restare a coprire una
         * pagina di login funzionante ma nascosta sotto.
         */
        _adoptLogin: function (tentativi) {
            const n = tentativi || 0;
            const login = document.getElementById('loginPage');

            if (!login) {
                if (n > 40) {
                    console.warn('[XRCover] #loginPage non trovato: copertina rimossa per non bloccare l\'accesso.');
                    this._remove();
                    return;
                }
                setTimeout(() => this._adoptLogin(n + 1), 50);
                return;
            }

            const slot = document.getElementById('xrCoverLogin');
            (slot || this.el).appendChild(login);
            login.classList.add('xr-cover-login');

            // «Accedi» diventa «ENTRA»: è la parola del documento, ed è anche
            // più giusta qui — non si accede a una pagina, si entra in un posto.
            const btn = login.querySelector('.btn-login, button[type="submit"]');
            if (btn) btn.textContent = ENTRA;

            // Distinguere il login digitato dalla sessione ripristinata: solo il
            // primo è un gesto dell'utente, e solo un gesto può aprire la VR.
            // `capture` perché core/ fa preventDefault sullo stesso evento.
            login.addEventListener('submit', () => { this._userGesture = true; }, true);

            const user = document.getElementById('username');
            if (user) user.focus();

            // Il velo si toglie quando `core/` scopre `#container`, cioè a
            // credenziali accettate. Osservare quello invece di agganciarsi al
            // submit evita di indovinare l'esito: il login può fallire, e in
            // quel caso si deve restare qui a vedere il messaggio d'errore.
            this._watchLogin();
        },

        /** Aspetta che `core/` dichiari il login riuscito scoprendo `#container`. */
        _watchLogin: function () {
            const container = document.getElementById('container');
            if (!container) return;

            const fatto = () => !container.classList.contains('hidden');
            if (fatto()) return this._loggedIn();

            const obs = new MutationObserver(() => {
                if (fatto()) { obs.disconnect(); this._loggedIn(); }
            });
            obs.observe(container, { attributes: true, attributeFilter: ['class'] });
        },

        _loggedIn: async function () {
            const lang = (window.currentUser && window.currentUser.language) || 'default';
            console.log(`[XRCover] Accesso riuscito (lingua: ${lang}).`);

            const XS = window.XRSession;

            // Sessione ripristinata da localStorage: `core/` ha scoperto
            // `#container` da solo, senza che nessuno abbia premuto niente. Non
            // esiste quindi la user activation che `requestSession` pretende, e
            // togliere il velo mostrerebbe la griglia 2D — proprio ciò che il
            // flusso esclude. La copertina resta, e al posto dei campi c'è il
            // solo ENTRA: un gesto, lo stesso del documento, e si è dentro.
            if (!this._userGesture) {
                console.log('[XRCover] Sessione ripristinata senza gesto: la copertina resta, si entra con ENTRA.');
                this._showEnterOnly();
                return;
            }

            // Il velo se ne va, ma il gesto che lo ha tolto è ancora "fresco":
            // è con quello che XRSession entra in VR, senza chiederne un altro.
            this._remove();

            if (!XS || !XS.enterAfterLogin) return;

            const entrato = await XS.enterAfterLogin();
            if (!entrato && await this._vrExists(XS)) this._offerVR();
        },

        /**
         * `XRSession.supported` nasce `null` e diventa vero/falso solo quando la
         * sonda async (`isSessionSupported`) risponde. Leggerlo al volo durante
         * il caricamento pagina è una race: sul Quest rispondeva `null` e il
         * fallback non compariva mai. Qui si aspetta la risposta, poco e con
         * scadenza — se la sonda non risponde, la VR non c'è.
         */
        _vrExists: function (XS, timeoutMs = 4000) {
            return new Promise((resolve) => {
                const deadline = Date.now() + timeoutMs;
                const check = () => {
                    if (!XS) return resolve(false);
                    if (XS.supported !== null && XS.supported !== undefined) return resolve(!!XS.supported);
                    if (Date.now() > deadline) return resolve(false);
                    setTimeout(check, 100);
                };
                check();
            });
        },

        /**
         * La copertina con il solo ENTRA: per chi è già autenticato ma deve
         * ancora fare il gesto che apre la VR.
         *
         * Anche senza visore il pulsante c'è e fa la cosa giusta — toglie il
         * velo e lascia la home 2D. Così il desktop vede lo stesso flusso:
         * copertina → ENTRA → dentro, qualunque cosa "dentro" sia lì.
         */
        _showEnterOnly: function () {
            const slot = document.getElementById('xrCoverLogin') || this.el;
            if (!slot) return;

            // Il form di core/ è già nascosto (classe `hidden`), ma sta ancora
            // qui dentro: si lascia dov'è, serve al prossimo logout.
            const btn = document.createElement('button');
            btn.id = 'xrCoverEnter';
            btn.type = 'button';
            btn.className = 'btn-login xr-cover-enter';
            btn.textContent = ENTRA;
            slot.appendChild(btn);
            btn.focus();

            btn.addEventListener('click', async () => {
                btn.disabled = true;
                this._remove();
                const XS = window.XRSession;
                if (!XS || !XS.enterAfterLogin) return;
                const entrato = await XS.enterAfterLogin();
                if (!entrato && await this._vrExists(XS)) this._offerVR();
            });
        },

        /**
         * Se l'ingresso automatico non è riuscito ma il visore c'è, si chiede il
         * gesto invece di lasciare la griglia 2D.
         *
         * La selezione degli scenari deve avvenire in VR: mostrarla in 2D
         * significa farla scegliere lì, ed è proprio ciò che il flusso esclude.
         * L'ingresso automatico può mancare per una ragione sola e legittima —
         * la user activation di ENTRA è scaduta mentre `core/` leggeva
         * `users.txt` — e la cura è un tocco, non una pagina.
         *
         * Solo dove la VR **esiste**: sul desktop la home 2D è l'unica interfaccia
         * possibile, e coprirla renderebbe il sito inutilizzabile.
         */
        _offerVR: function () {
            if (document.getElementById('xrGate')) return;
            console.log('[XRCover] Ingresso automatico non riuscito: chiedo il tocco invece di mostrare la scelta in 2D.');

            const gate = document.createElement('div');
            gate.id = 'xrGate';
            const btn = document.createElement('button');
            btn.id = 'xrGateEnter';
            btn.type = 'button';
            btn.textContent = '🥽  ENTRA IN VR';
            gate.appendChild(btn);
            document.body.appendChild(gate);
            btn.focus();

            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const ok = await window.XRSession.enterAfterLogin();
                btn.disabled = false;
                if (ok && gate.parentNode) gate.parentNode.removeChild(gate);
            });

            // Uscendo dalla sessione si torna a questa schermata, non alla
            // griglia 2D: la scelta resta una cosa che si fa dentro il mondo.
            if (typeof window.XRSession.on === 'function') {
                window.XRSession.on('exit', () => {
                    if (!document.getElementById('xrGate')) document.body.appendChild(gate);
                });
            }
        },

        /** Toglie il velo. Una volta sola: dietro c'è la pagina vera. */
        _remove: function () {
            if (!this.el || this.el.classList.contains('xr-cover--gone')) return;
            this.el.classList.add('xr-cover--gone');
            // Rimosso dopo la dissolvenza: lasciarlo, anche invisibile,
            // significherebbe un elemento a tutto schermo sopra la pagina che
            // continua a intercettare i tocchi.
            setTimeout(() => {
                if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
                this.el = null;
            }, 450);
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => XRCover.init());
    } else {
        XRCover.init();
    }

    window.XRCover = XRCover;
})();
