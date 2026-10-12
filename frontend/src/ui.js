// ==========================================================================
// UI KUSTOM — Notifikasi (toast), Peringatan & Konfirmasi (dialog)
// -------------------------------------------------------------------------
// Menggantikan window.alert / window.confirm / window.prompt NATIVE.
// Alasan: dialog native di Electron renderer bisa memicu bug (blocking
// event loop, tidak konsisten antar-platform, tidak bisa di-style, dan
// pada beberapa versi Chromium bisa memaksa focus kehilangan handler).
//
// Prinsip anti-bug yang diterapkan:
//  - Semua DOM dibuat dengan createElement + textContent (BUKAN innerHTML
//    dengan template string) => pesan user/data DB tidak bisa menyuntik HTML.
//  - Event listener selalu dilepas saat dialog/toast ditutup (no leak).
//  - Dialog memakai antrian tunggal per overlay; Esc/Enter ditangani sekali.
//  - Promise selalu resolve (tidak ada jalur yang menggantung).
//  - Tidak bergantung pada elemen tertentu di halaman (container dibuat
//    otomatis bila belum ada) sehingga aman dipanggil kapan pun.
// ==========================================================================

const UI = (() => {
    const ICON_PATHS = {
        success: '<polyline points="20 6 9 17 4 12"/>',
        error: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
        warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
        info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
        question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
        edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.481.97l-.77 3.454a1 1 0 0 0 1.23 1.23l3.454-.77a2 2 0 0 0 .97-.48z"/><path d="m15 5 4 4"/>',
        close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    };
    function iconSvg(name, size = 16) {
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.info}</svg>`;
    }

    function esc(str) {
        // Hanya untuk keamanan ganda bila suatu saat perlu innerHTML.
        return String(str ?? "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    function ensureContainer() {
        let c = document.getElementById("toast-container");
        if (!c) {
            c = document.createElement("div");
            c.id = "toast-container";
            document.body.appendChild(c);
        }
        return c;
    }

    // ----------------------------- TOAST -----------------------------------
    // notify({ title, message, type, duration, actionText, onAction })
    // signature lama showToast(title, message, actionText, actionCallback)
    // tetap didukung (lihat pembungkus di bawah).
    function notify(opts = {}) {
        const {
            title = "Notifikasi",
            message = "",
            type = "info", // success | error | warning | info
            duration = 5000,
            actionText = null,
            onAction = null,
        } = opts;

        const container = ensureContainer();
        const toast = document.createElement("div");
        toast.className = `toast toast-${type}`;
        toast.setAttribute("role", "status");

        const icon = document.createElement("div");
        icon.className = "toast-icon";
        icon.innerHTML = iconSvg(type === "success" ? "success" : type === "error" ? "error" : type === "warning" ? "warning" : "info", 16);

        const body = document.createElement("div");
        body.className = "toast-body";

        const t = document.createElement("span");
        t.className = "toast-title";
        t.textContent = title;
        body.appendChild(t);

        if (message !== "" && message != null) {
            const m = document.createElement("span");
            m.className = "toast-msg";
            m.textContent = message;
            body.appendChild(m);
        }

        if (actionText && typeof onAction === "function") {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "toast-action-btn";
            btn.textContent = actionText;
            btn.addEventListener("click", () => {
                try { onAction(); } catch (e) { /* aksi tidak boleh memecah toast */ }
                dismiss(toast);
            });
            body.appendChild(btn);
        }

        const close = document.createElement("button");
        close.type = "button";
        close.className = "toast-close";
        close.setAttribute("aria-label", "Tutup notifikasi");
        close.innerHTML = iconSvg("close", 14);
        close.addEventListener("click", () => dismiss(toast));

        const bar = document.createElement("div");
        bar.className = "toast-progress";
        if (duration > 0) bar.style.animationDuration = `${duration}ms`;

        toast.append(icon, body, close, bar);
        container.appendChild(toast);

        if (duration > 0) {
            setTimeout(() => {
                if (toast.parentElement) dismiss(toast);
            }, duration);
        }
        return toast;
    }

    function dismiss(toast) {
        toast.classList.add("toast-out");
        const done = () => toast.remove();
        toast.addEventListener("animationend", done, { once: true });
        setTimeout(done, 400); // jaring pengaman bila animasi tidak terpicu
    }

    // ----------------------------- DIALOG ----------------------------------
    // makeDialog({ kind, tone, title, message, inputType, defaultValue,
    //             okText, cancelText, danger }) => Promise<string|boolean|null>
    function makeDialog(opts = {}) {
        const {
            kind = "alert",          // alert | confirm | prompt
            tone = "info",           // info | success | warning | error
            title = "",
            message = "",
            inputType = "text",      // text | textarea (untuk prompt)
            defaultValue = "",
            placeholder = "",
            okText = "OK",
            cancelText = "Batal",
            danger = false,
        } = opts;

        return new Promise((resolve) => {
            // Tutup dialog aktif sebelumnya agar tidak menumpuk (anti-bug).
            document.querySelectorAll(".ui-dialog-overlay").forEach((o) => o.remove());

            const overlay = document.createElement("div");
            overlay.className = `ui-dialog-overlay ui-dialog-kind-${kind}`;

            const box = document.createElement("div");
            box.className = "ui-dialog";
            box.setAttribute("role", kind === "alert" ? "alertdialog" : "dialog");
            box.setAttribute("aria-modal", "true");
            if (kind === "alert") box.dataset.tone = tone;

            // Header + ikon
            const head = document.createElement("div");
            head.className = "ui-dialog-head";
            const icon = document.createElement("div");
            icon.className = "ui-dialog-icon";
            icon.innerHTML = iconSvg(
                kind === "confirm" ? (danger ? "warning" : "question")
                : kind === "prompt" ? "edit"
                : (tone in ICON_PATHS ? tone : "info"), 20);
            head.appendChild(icon);
            const h = document.createElement("h2");
            h.className = "ui-dialog-title";
            h.textContent =
                title || (kind === "confirm" ? "Konfirmasi" : kind === "prompt" ? "Masukkan" : "Pemberitahuan");
            head.appendChild(h);

            // Body + pesan (textContent => aman dari injeksi HTML)
            const bodyEl = document.createElement("div");
            bodyEl.className = "ui-dialog-body";
            if (message !== "" && message != null) {
                const p = document.createElement("p");
                p.className = "ui-dialog-message";
                p.textContent = message;
                bodyEl.appendChild(p);
            }

            let inputEl = null;
            if (kind === "prompt") {
                const wrap = document.createElement("div");
                wrap.className = "ui-dialog-input";
                inputEl = inputType === "textarea"
                    ? document.createElement("textarea")
                    : document.createElement("input");
                inputEl.type = "text";
                inputEl.value = defaultValue ?? "";
                if (placeholder) inputEl.placeholder = placeholder;
                wrap.appendChild(inputEl);
                bodyEl.appendChild(wrap);
            }

            // Footer tombol
            const foot = document.createElement("div");
            foot.className = "ui-dialog-foot";

            let closed = false; // pastikan resolve hanya sekali (anti race)
            function finish(value) {
                if (closed) return;
                closed = true;
                document.removeEventListener("keydown", onKey, true);
                overlay.classList.add("closing");
                const rm = () => overlay.remove();
                overlay.addEventListener("animationend", rm, { once: true });
                setTimeout(rm, 350);
                resolve(value);
            }

            if (kind !== "alert") {
                const cancel = document.createElement("button");
                cancel.type = "button";
                cancel.className = "btn btn-secondary";
                cancel.textContent = cancelText;
                cancel.addEventListener("click", () => finish(kind === "confirm" ? false : null));
                foot.appendChild(cancel);
            }

            const ok = document.createElement("button");
            ok.type = "button";
            const useDanger = danger || kind === "confirm";
            ok.className = `btn ${useDanger ? "btn-danger" : "btn-primary"}`;
            ok.textContent = okText;
            ok.addEventListener("click", () => {
                if (kind === "confirm") finish(true);
                else if (kind === "prompt") finish(inputEl ? inputEl.value : "");
                else finish(undefined);
            });
            foot.appendChild(ok);

            box.append(head, bodyEl, foot);
            overlay.appendChild(box);
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) finish(kind === "confirm" ? false : kind === "prompt" ? null : undefined);
            });

            function onKey(e) {
                if (e.key === "Escape") { e.preventDefault(); finish(kind === "confirm" ? false : kind === "prompt" ? null : undefined); }
                if (e.key === "Enter" && (!inputEl || e.target !== inputEl || inputEl.tagName !== "TEXTAREA")) {
                    e.preventDefault();
                    ok.click();
                }
            }
            document.addEventListener("keydown", onKey, true);

            document.body.appendChild(overlay);
            (inputEl || ok).focus();
        });
    }

    // API publik
    const api = {
        esc,
        notify,
        alert(message, opts = {}) {
            return makeDialog({ kind: "alert", message, ...opts });
        },
        confirm(message, opts = {}) {
            return makeDialog({
                kind: "confirm", message,
                ...opts,
                danger: opts.danger !== false, // konfirmasi default dianggap berisiko
                okText: opts.okText || "Ya, Lanjutkan",
                cancelText: opts.cancelText || "Batal",
            });
        },
        prompt(message, opts = {}) {
            return makeDialog({ kind: "prompt", message, okText: opts.okText || "Simpan", ...opts });
        },
        success(message, title = "Berhasil!") { return notify({ type: "success", title, message }); },
        error(message, title = "Gagal!") { return notify({ type: "error", title, message, duration: 8000 }); },
        warning(message, title = "Perhatian!") { return notify({ type: "warning", title, message }); },
        info(message, title = "Info") { return notify({ type: "info", title, message }); },
    };

    return api;
})();

// ---------- Pemblokiran total dialog NATIVE (anti bug di kemudian hari) ----
// Jika masih ada kode lama (atau pihak ketiga) memanggil alert/confirm/prompt
// bawaan browser, ia dialihkan ke implementasi kustom secara asinkron.
// Catatan: pengganti mengembalikan nilai sinkron tidak mungkin, jadi pemanggil
// lama TETAP harus dimigrasikan ke `await UI.confirm(...)`; namun fallback ini
// mencegah dialog OS muncul & mencatat penyalahgunaan ke app.log.
window.__nativeDialogBlocked = true;
const _nativeWarned = new Set();
["alert", "confirm", "prompt"].forEach((fn) => {
    try {
        window[fn] = function (...args) {
            const msg = String(args[0] ?? "");
            if (!_nativeWarned.has(fn)) {
                _nativeWarned.add(fn);
                try {
                    if (window.electronAPI?.logApp) {
                        window.electronAPI.logApp("warn", `Dialog native "${fn}" dipanggil — gunakan UI.${fn}. Pesan: ${msg.slice(0, 120)}`);
                    }
                } catch (e) {}
                console.warn(`[UI] Dialog native "${fn}" diblokir. Migrasikan ke UI.${fn}(…).`);
            }
            if (fn === "alert") UI.alert(msg);
            // confirm/prompt native bersifat sinkron; agar alur lama tidak crash,
            // kembalikan netral (false / null) sambil menampilkan versi kustom.
            if (fn === "confirm") { UI.confirm(msg); return false; }
            if (fn === "prompt") { UI.prompt(msg, { defaultValue: args[1] || "" }); return null; }
            return undefined;
        };
    } catch (e) { /* beberapa env melarang override — tidak fatal */ }
});

export default UI;
