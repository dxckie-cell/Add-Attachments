// Ported from Vencord/Equicord "AddAttachments" by Lumap
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
    // Set to false once the "Add Attachments" row shows up reliably.
    const DEBUG = true;

    const { findByProps, findByStoreName } = vendetta.metro;
    const { React } = vendetta.metro.common;
    const { after, before } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
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

    // Loose match: any element that looks like an action sheet row
    function isRow(x) {
        if (!x || !x.type) return false;
        if (ActionSheetRow && x.type === ActionSheetRow) return true;
        const name = x.type.name || x.type.displayName || "";
        return /ActionSheetRow|ButtonRow|TableRow/.test(name) || !!(x.props && x.props.label && x.props.onPress);
    }

    let unpatchSheet;

    return {
        onLoad() {
            showToast("AddAttachments: loaded (v3)");
            if (!LazyActionSheet) return showToast("AddAttachments: action sheet module not found");

            unpatchSheet = before("openLazy", LazyActionSheet, ([component, key, props]) => {
                const message = props && props.message;
                if (DEBUG) dbg("openLazy '" + key + "', hasMessage=" + !!message + (message ? ", eligible=" + canAddAttachments(message) : ""));
                if (!message) return;

                if (key !== "MessageLongPressActionSheet") return;
                if (!canAddAttachments(message)) return;

                component.then(instance => {
                    const unpatch = after("default", instance, (_, res) => {
                        React.useEffect(() => () => void unpatch(), []);

                        const rows = findInReactTree(res, x => Array.isArray(x) && x.length > 0 && isRow(x[0]));
                        if (!rows) return dbg("no rows array found in sheet");

                        const RowType = ActionSheetRow || rows[0].type;
                        const Icon = RowType.Icon;

                        rows.push(
                            React.createElement(RowType, {
                                key: "add-attachments",
                                label: "Add Attachments",
                                icon: Icon ? React.createElement(Icon, { source: getAssetIDByName("ic_upload") }) : undefined,
                                onPress: () => {
                                    LazyActionSheet.hideActionSheet();
                                    addAttachments(message.channel_id, message.id);
                                }
                            })
                        );
                        dbg("row added");
                    });
                });
            });
        },
        onUnload() {
            if (unpatchSheet) unpatchSheet();
        }
    };
})();
