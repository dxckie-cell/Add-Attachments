// Ported from Vencord/Equicord "AddAttachments" by Lumap
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
    const RN = vendetta.metro.common.ReactNative;
    try {
    // Set to false once the "Add Attachments" row shows up reliably.
    const DEBUG = true;

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

    const MAX_ATTACHMENTS = 10;
    const VOICE_MESSAGE_FLAG = 1 << 13;

    const dbg = text => { if (DEBUG) showToast("AddAttachments: " + text); };

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

    async function addAttachments(channelId, messageId) {
        const current = MessageStore.getMessage(channelId, messageId);
        const existing = (current && current.attachments) || [];
        const remaining = MAX_ATTACHMENTS - existing.length;
        if (remaining <= 0) return showToast("You cannot add more attachments to this message.");

        let picked;
        try {
            picked = await pickFiles();
        } catch (e) {
            if (e && e.code === "DOCUMENT_PICKER_CANCELED") return;
            return showToast("File picker failed: " + (e && e.message ? e.message : e));
        }
        if (!picked.length) return;

        if (picked.length > remaining)
            return showToast("You can only add " + remaining + " more attachment" + (remaining === 1 ? "" : "s") + " to this message.");

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
            showToast("Failed: " + (e && e.message ? e.message : e));
        }
    }

    // ---- action sheet injection (modeled on the HideActionSheetButtons plugin) ----

    function labelOf(el) {
        const p = (el && el.props) || {};
        const v = [p.label, p.title, p.text, p.accessibilityLabel].find(x => typeof x === "string");
        return v ? v.trim().toLowerCase() : null;
    }

    // an array of row-like elements: at least one child that has a text label and an onPress
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
        // clone a neutral row so props/styling match this Discord build
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

        // set whichever text prop the sample uses
        for (const k of ["label", "title", "text", "accessibilityLabel"]) {
            if (typeof sp[k] === "string") props[k] = "Add Attachments";
        }
        delete props.subLabel;
        delete props.trailing;

        // swap the icon, keeping its element type
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
                    dbg("row added");
                } catch (e) {
                    console.log("[AddAttachments] inject error", e);
                    dbg("inject error: " + (e && e.message ? e.message : e));
                }
                return tree;
            })
        );
    }

    return {
        onLoad() {
            RN.Alert.alert("AddAttachments", "loaded (v5)");
            if (!LazyActionSheet) return showToast("AddAttachments: action sheet module not found");

            unpatches.push(
                before("openLazy", LazyActionSheet, ([component, key, props]) => {
                    const message = props && props.message;
                    if (DEBUG) dbg("openLazy '" + key + "', hasMessage=" + !!message + (message ? ", eligible=" + canAddAttachments(message) : ""));
                    if (key !== "MessageLongPressActionSheet" || !message) return;
                    currentMessage = message;
                    component.then(patchInstance);
                })
            );
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
