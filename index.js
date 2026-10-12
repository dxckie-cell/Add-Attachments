(function () {
    /* Ported from Vencord/Equicord "AddAttachments" by Lumap. SPDX-License-Identifier: GPL-3.0-or-later */
    const RN = vendetta.metro.common.ReactNative;
    try {
    const DEBUG = false;
    // Set true to get a popup on every photo pick while editing (debugging only).
    const DEBUG_SETFILE = false;

    const { findByProps, findByStoreName } = vendetta.metro;
    const { React } = vendetta.metro.common;
    const { after, before } = vendetta.patcher;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { showToast } = vendetta.ui.toasts;

    const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
    const ActionSheetRow = (findByProps("ActionSheetRow") || {}).ActionSheetRow;
    const RestAPI = findByProps("getAPIBaseURL", "get", "post", "patch");
    const UserStore = findByStoreName("UserStore");
    const MessageStore = findByStoreName("MessageStore");
    const EditMessageStore = findByStoreName("EditMessageStore");
    // upload actions module (popFirstFile, addFile(s), setFile, clearAll, ...)
    const UP = findByProps("uploadLocalFiles") || findByProps("addFiles") || findByProps("addFile");

    const MAX_ATTACHMENTS = 10;
    const VOICE_MESSAGE_FLAG = 1 << 13;

    const dbg = text => { if (DEBUG) showToast("AddAttachments: " + text); };
    const notify = text => RN.Alert.alert("AddAttachments", text);

    // ---------------------------------------------------------------- picking (long-press row)

    async function pickFiles() {
        // react-native-document-picker style
        const rndp = findByProps("pick", "types");
        if (rndp && rndp.pick) {
            const res = await rndp.pick({ allowMultiSelection: true, copyTo: "cachesDirectory" });
            return res.map(r => ({ uri: r.fileCopyUri || r.uri, name: r.name }));
        }

        // expo-document-picker style
        const expo = findByProps("getDocumentAsync");
        if (expo && expo.getDocumentAsync) {
            const res = await expo.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
            if (res.canceled) return [];
            return res.assets.map(a => ({ uri: a.uri, name: a.name }));
        }

        throw new Error("No file picker found");
    }

    function canAddAttachments(msg) {
        const authorId = (msg.author && msg.author.id) || msg.authorId;
        const me = UserStore.getCurrentUser();
        return (
            [0, 19].includes(msg.type) && // DEFAULT, REPLY
            !((msg.flags || 0) & VOICE_MESSAGE_FLAG) &&
            me && authorId === me.id &&
            ((msg.attachments && msg.attachments.length) || 0) < MAX_ATTACHMENTS
        );
    }

    // ---------------------------------------------------------------- upload to an existing message

    // uploads/patches run one at a time so several photos picked in a row don't overwrite each other
    let queue = Promise.resolve();
    function enqueue(task) {
        queue = queue.then(task).catch(e => {
            console.error("[AddAttachments]", e);
            notify("Failed: " + (e && e.message ? e.message : e));
        });
    }

    async function uploadPicked(channelId, messageId, picked) {
        const current = MessageStore.getMessage(channelId, messageId);
        const existing = (current && current.attachments) || [];
        const remaining = MAX_ATTACHMENTS - existing.length;
        if (remaining <= 0) return notify("You cannot add more attachments to this message.");
        if (picked.length > remaining)
            return notify("You can only add " + remaining + " more attachment" + (remaining === 1 ? "" : "s") + " to this message.");

        try {
            showToast("Uploading, this can take a while...", getAssetIDByName("ic_clock"));

            const blobs = await Promise.all(picked.map(async p => (await fetch(p.uri)).blob()));

            const created = await RestAPI.post({
                url: "/channels/" + channelId + "/attachments",
                body: {
                    files: picked.map((p, i) => ({
                        filename: p.name,
                        file_size: blobs[i].size,
                        id: String(i),
                        is_clip: false
                    }))
                }
            });
            const attachments = created.body.attachments;

            const uploaded = await Promise.all(
                attachments.map((a, i) =>
                    fetch(a.upload_url, { method: "PUT", body: blobs[i] }).then(res => {
                        if (!res.ok) throw new Error("Upload failed (" + res.status + ")");
                        return { id: a.id, uploaded_filename: a.upload_filename, filename: picked[i].name };
                    })
                )
            );

            // re-read in case the message changed while uploading
            const msg = MessageStore.getMessage(channelId, messageId);
            await RestAPI.patch({
                url: "/channels/" + channelId + "/messages/" + messageId,
                body: {
                    attachments: [
                        ...((msg && msg.attachments) || []).map(a => ({ id: a.id, filename: a.filename })),
                        ...uploaded
                    ]
                }
            });

            showToast((picked.length === 1 ? "Attachment" : "Attachments") + " added successfully!", getAssetIDByName("Check"));
        } catch (e) {
            console.error("[AddAttachments]", e);
            notify("Failed: " + (e && e.message ? e.message : e));
        }
    }

    async function addAttachments(channelId, messageId) {
        const current = MessageStore.getMessage(channelId, messageId);
        const existing = (current && current.attachments) || [];
        if (MAX_ATTACHMENTS - existing.length <= 0) return notify("You cannot add more attachments to this message.");

        let picked;
        try {
            picked = await pickFiles();
        } catch (e) {
            if (e && e.code === "DOCUMENT_PICKER_CANCELED") return;
            return notify("File picker failed: " + (e && e.message ? e.message : e));
        }
        if (!picked.length) return;

        enqueue(() => uploadPicked(channelId, messageId, picked));
    }

    // ---------------------------------------------------------------- photo tray while editing

    // Discord's file objects aren't documented: walk the object for a local uri + a filename.
    function digFile(file) {
        let uri = null, name = null;
        const seen = new Set();
        (function walk(o, d) {
            if (!o || typeof o !== "object" || d > 4 || seen.has(o)) return;
            seen.add(o);
            for (const k of Object.keys(o)) {
                const v = o[k];
                if (typeof v === "string") {
                    if (!uri && /^(file|content|ph|assets-library):/i.test(v)) uri = v;
                    else if (!name && /^(filename|fileName|name)$/.test(k)) name = v;
                } else if (v && typeof v === "object") {
                    walk(v, d + 1);
                }
            }
        })(file, 0);
        if (!uri) return null;
        if (!name) {
            try { name = decodeURIComponent(uri.split("?")[0].split("/").pop()); } catch (e) { name = null; }
        }
        return { uri, name: name || "attachment" };
    }

    function describe(o) {
        try {
            if (!o || typeof o !== "object") return String(o);
            return Object.keys(o).slice(0, 12).map(k => {
                const v = o[k];
                if (v && typeof v === "object")
                    return k + ":{" + Object.keys(v).slice(0, 8).join(",") + "}";
                return k + ":" + (typeof v === "string" ? JSON.stringify(v.slice(0, 40)) : String(v));
            }).join("\n");
        } catch (e) {
            return "?";
        }
    }

    function editingMessageFor(channelId) {
        try {
            const m = EditMessageStore.getEditingMessage(channelId);
            if (m) return m;
        } catch (e) {}
        try {
            const id = EditMessageStore.getEditingMessageId(channelId);
            if (id) return MessageStore.getMessage(channelId, id) || null;
        } catch (e) {}
        return null;
    }

    let lastDebug = 0;
    function debugUploadCall(key, payload, editing) {
        const now = Date.now();
        if (now - lastDebug < 3000) return;
        lastDebug = now;
        const safe = f => { try { return f(); } catch (e) { return "err:" + (e && e.message); } };
        RN.Alert.alert("AddAttachments debug (send me this)", [
            "v14: upload call '" + key + "'",
            "channelId: " + payload.channelId,
            "draftType: " + payload.draftType,
            "editing: " + (editing ? "message id=" + editing.id + " type=" + editing.type : "none"),
            "canAdd: " + (editing ? safe(() => String(canAddAttachments(editing))) : "n/a"),
            "payload keys: " + safe(() => Object.keys(payload).join(",")),
            "file: " + describe(payload.file)
        ].join("\n"));
    }

    const handledFiles = new WeakSet();

    // Called for EVERY function of the upload module. Only acts on "add a file to the channel draft"
    // calls (object with channelId + file) made while one of your own messages is being edited.
    function onUploadCall(key, args, orig) {
        try {
            const payload = args[0];
            if (!payload || typeof payload !== "object" || !payload.channelId ||
                !payload.file || typeof payload.file !== "object")
                return orig(...args);
            if (payload.draftType !== undefined && payload.draftType !== 0) return orig(...args);

            const channelId = payload.channelId;
            const editing = editingMessageFor(channelId);
            if (DEBUG_SETFILE) debugUploadCall(key, payload, editing);
            if (!editing || !canAddAttachments(editing)) return orig(...args);

            // the same file object may pass through several upload functions: handle it once
            if (handledFiles.has(payload.file)) return;
            handledFiles.add(payload.file);

            const info = digFile(payload.file);
            if (!info) {
                handledFiles.delete(payload.file);
                RN.Alert.alert("AddAttachments: unknown file shape (send me this)", key + "\n" + describe(payload.file));
                return orig(...args);
            }

            enqueue(() => uploadPicked(channelId, editing.id, [info]));
        } catch (e) {
            console.error("[AddAttachments] upload hook error", e);
            return orig(...args);
        }
    }

    // ---------------------------------------------------------------- long-press row injection

    function labelOf(el) {
        const p = (el && el.props) || {};
        const v = [p.label, p.title, p.text, p.accessibilityLabel].find(x => typeof x === "string");
        return v ? v.trim().toLowerCase() : null;
    }

    function isRowsArray(x) {
        return Array.isArray(x) && x.some(el => el && el.props && labelOf(el) && typeof el.props.onPress === "function");
    }

    function findRowsArray(node, seen, depth) {
        if (!node || typeof node !== "object" || depth > 80 || seen.has(node)) return null;
        seen.add(node);

        if (isRowsArray(node)) return node;

        if (Array.isArray(node)) {
            for (const el of node) {
                const r = findRowsArray(el, seen, depth + 1);
                if (r) return r;
            }
            return null;
        }

        if (node.props) {
            for (const k of Object.keys(node.props)) {
                const v = node.props[k];
                if (v && typeof v === "object") {
                    const r = findRowsArray(v, seen, depth + 1);
                    if (r) return r;
                }
            }
        }
        return null;
    }

    function makeRow(rows, message) {
        const preferred = ["reply", "copy text", "edit message", "copy message link", "forward"];
        const candidates = rows.filter(el => el && el.props && labelOf(el) && typeof el.props.onPress === "function");
        const sample =
            candidates.find(el => preferred.includes(labelOf(el)) && !el.props.variant && !el.props.destructive) ||
            candidates.find(el => !el.props.variant && !el.props.destructive) ||
            candidates[0];

        const sp = sample.props;
        const props = Object.assign({}, sp, {
            key: "add-attachments",
            onPress: () => {
                LazyActionSheet.hideActionSheet();
                addAttachments(message.channel_id, message.id);
            }
        });

        for (const k of ["label", "title", "text", "accessibilityLabel"]) {
            if (typeof sp[k] === "string") props[k] = "Add Attachments";
        }
        delete props.subLabel;
        delete props.trailing;

        if (React.isValidElement(sp.icon)) {
            props.icon = React.cloneElement(sp.icon, { source: getAssetIDByName("ic_upload") });
        }

        return React.createElement(sample.type, props);
    }

    let unpatches = [];
    const patched = new WeakSet();
    let currentMessage = null;

    function patchInstance(instance) {
        if (!instance || patched.has(instance) || typeof instance.default !== "function") return;
        patched.add(instance);
        unpatches.push(
            after("default", instance, (_, tree) => {
                try {
                    const message = currentMessage;
                    if (!message || !canAddAttachments(message)) return;

                    const rows = findRowsArray(tree, new WeakSet(), 0);
                    if (!rows) return dbg("no rows array found");
                    if (rows.some(el => el && el.key === "add-attachments")) return;

                    rows.push(makeRow(rows, message));
                } catch (e) {
                    console.log("[AddAttachments] inject error", e);
                }
                return tree;
            })
        );
    }

    return {
        onLoad() {
            if (LazyActionSheet) {
                unpatches.push(
                    before("openLazy", LazyActionSheet, ([component, key, props]) => {
                        const message = props && props.message;
                        if (key !== "MessageLongPressActionSheet" || !message) return;
                        currentMessage = message;
                        component.then(patchInstance);
                    })
                );
            }

            // wrap every function of the upload module by hand; onUploadCall decides what to intercept
            let hookState;
            try {
                if (!UP) {
                    hookState = "upload module NOT found";
                } else {
                    const wrapped = [];
                    Object.keys(UP).forEach(key => {
                        const origFn = UP[key];
                        if (typeof origFn !== "function") return;
                        const wrapper = function () {
                            const args = Array.prototype.slice.call(arguments);
                            return onUploadCall(key, args, function () { return origFn.apply(UP, arguments); });
                        };
                        try {
                            UP[key] = wrapper;
                            if (UP[key] === wrapper) wrapped.push([key, origFn, wrapper]);
                        } catch (e) {}
                    });
                    unpatches.push(() => wrapped.forEach(([k, o, w]) => { if (UP[k] === w) UP[k] = o; }));
                    hookState = "wrapped " + wrapped.length + " upload functions: " + wrapped.map(w => w[0]).join(", ");
                }
            } catch (e) {
                hookState = "hook error: " + (e && e.message ? e.message : e);
            }
            if (DEBUG) RN.Alert.alert("AddAttachments", "v14 loaded\n" + hookState);
        },
        onUnload() {
            unpatches.forEach(u => u());
            unpatches = [];
        }
    };

    } catch (e) {
        return {
            onLoad() {
                RN.Alert.alert("AddAttachments failed to init", String((e && (e.stack || e.message)) || e));
            }
        };
    }
})();
