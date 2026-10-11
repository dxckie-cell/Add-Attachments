// Ported from Vencord/Equicord "AddAttachments" by Lumap
// SPDX-License-Identifier: GPL-3.0-or-later
(function () {
    const { findByProps, findByStoreName } = vendetta.metro;
    const { React } = vendetta.metro.common;
    const { after, before } = vendetta.patcher;
    const { findInReactTree } = vendetta.utils;
    const { getAssetIDByName } = vendetta.ui.assets;
    const { showToast } = vendetta.ui.toasts;

    const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
    const { ActionSheetRow } = findByProps("ActionSheetRow");
    const RestAPI = findByProps("getAPIBaseURL", "get", "post", "patch");
    const UserStore = findByStoreName("UserStore");
    const MessageStore = findByStoreName("MessageStore");

    const MAX_ATTACHMENTS = 10;
    const VOICE_MESSAGE_FLAG = 1 << 13;

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
        return (
            [0, 19].includes(msg.type) && // DEFAULT, REPLY
            !((msg.flags || 0) & VOICE_MESSAGE_FLAG) &&
            msg.author && msg.author.id === UserStore.getCurrentUser().id &&
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

    let unpatchSheet;

    return {
        onLoad() {
            unpatchSheet = before("openLazy", LazyActionSheet, ([component, key, props]) => {
                const message = props && props.message;
                if (key !== "MessageLongPressActionSheet" || !message) return;
                if (!canAddAttachments(message)) return;

                component.then(instance => {
                    const unpatch = after("default", instance, (_, res) => {
                        React.useEffect(() => () => void unpatch(), []);

                        const rows = findInReactTree(res, x => Array.isArray(x) && x[0] && x[0].type === ActionSheetRow);
                        if (!rows) return;

                        rows.push(
                            React.createElement(ActionSheetRow, {
                                label: "Add Attachments",
                                icon: React.createElement(ActionSheetRow.Icon, { source: getAssetIDByName("ic_upload") }),
                                onPress: () => {
                                    LazyActionSheet.hideActionSheet();
                                    addAttachments(message.channel_id, message.id);
                                }
                            })
                        );
                    });
                });
            });
        },
        onUnload() {
            if (unpatchSheet) unpatchSheet();
        }
    };
})();
