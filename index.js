(function () {
    /* Ported from Vencord/Equicord "AddAttachments" by Lumap. SPDX-License-Identifier: GPL-3.0-or-later */
    const RN = vendetta.metro.common.ReactNative;
    try {
    const { findByProps, findByStoreName } = vendetta.metro;

    const RestAPI = findByProps("getAPIBaseURL", "get", "post", "patch");
    const UserStore = findByStoreName("UserStore");
    const MessageStore = findByStoreName("MessageStore");
    const EditMessageStore = findByStoreName("EditMessageStore");
    // upload actions module (addFile, clearAll, ...)
    const UP = findByProps("uploadLocalFiles") || findByProps("addFiles") || findByProps("addFile");

    const MAX_ATTACHMENTS = 10;
    const VOICE_MESSAGE_FLAG = 1 << 13;
    // Discord prepares the photo before it calls sendMessage, so the gap after the edit ends can be several seconds.
    const SEND_WINDOW_MS = 20000;   // a send this soon after the edit ended counts as "the send arrow"
    const FORGET_AFTER_MS = 25000;  // forget the edit target (edit was cancelled) after this long

    let unpatches = [];
    let startTimer = null;
    // channelId -> { messageId, endedAt }: the message being edited when a photo was picked in the tray
    const editTargets = new Map();

    const notify = text => RN.Alert.alert("AddAttachments", text);

    // replace obj[key] with make(args, original); undone on unload
    function wrap(obj, key, make) {
        const orig = obj[key];
        if (typeof orig !== "function") return;
        const wrapper = function () {
            return make(Array.prototype.slice.call(arguments), function () { return orig.apply(obj, arguments); });
        };
        try {
            obj[key] = wrapper;
            if (obj[key] === wrapper) unpatches.push(() => { if (obj[key] === wrapper) obj[key] = orig; });
        } catch (e) {}
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

    function editingMessageFor(channelId) {
        try { return EditMessageStore.getEditingMessage(channelId); } catch (e) { return null; }
    }

    // ---------------------------------------------------------------- upload to an existing message

    // one at a time, so several uploads never overwrite each other's PATCH
    let queue = Promise.resolve();
    function enqueue(task) {
        queue = queue.then(task).catch(e => {
            console.error("[AddAttachments]", e);
            notify("Failed: " + (e && e.message ? e.message : e));
        });
    }

    async function uploadPicked(channelId, messageId, picked) {
        const current = MessageStore.getMessage(channelId, messageId);
        const remaining = MAX_ATTACHMENTS - ((current && current.attachments) || []).length;
        if (remaining <= 0) return notify("You cannot add more attachments to this message.");
        if (picked.length > remaining)
            return notify("You can only add " + remaining + " more attachment" + (remaining === 1 ? "" : "s") + " to this message.");

        const blobs = await Promise.all(picked.map(async p => (await fetch(p.uri)).blob()));

        const created = await RestAPI.post({
            url: "/channels/" + channelId + "/attachments",
            body: {
                files: picked.map((p, i) => ({ filename: p.name, file_size: blobs[i].size, id: String(i), is_clip: false }))
            }
        });

        const uploaded = await Promise.all(
            created.body.attachments.map((a, i) =>
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
    }

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

    // ---------------------------------------------------------------- photo tray while editing

    // Wraps every upload function. When a photo is added to the channel draft while one of your own messages is
    // being edited, remember that message; Discord still adds the photo to the draft as usual (the chip shows).
    function onUploadCall(args, orig) {
        try {
            const payload = args[0];
            if (payload && typeof payload === "object" && payload.channelId &&
                payload.file && typeof payload.file === "object" &&
                (payload.draftType === undefined || payload.draftType === 0)) {
                const editing = editingMessageFor(payload.channelId);
                if (editing && canAddAttachments(editing))
                    editTargets.set(payload.channelId, { messageId: editing.id, endedAt: null });
            }
        } catch (e) {}
        return orig(...args);
    }

    // sendMessage(channelId, message, waitForChannelReady, extra). Pressing send in edit mode with a photo in the
    // draft ends the edit, then calls this with extra.attachmentsToUpload set: upload those onto the edited message.
    function onSendMessage(args, orig) {
        try {
            const channelId = args[0];
            const msg = args[1];
            const extra = args[3];
            if (typeof channelId === "string" && extra && Array.isArray(extra.attachmentsToUpload) &&
                extra.attachmentsToUpload.length && editTargets.has(channelId)) {
                const entry = editTargets.get(channelId);
                const recentlyEnded = !!entry.endedAt && Date.now() - entry.endedAt < SEND_WINDOW_MS;
                const content = msg && typeof msg.content === "string" ? msg.content.trim() : "";

                if ((editingMessageFor(channelId) || recentlyEnded) && content === "") {
                    const infos = extra.attachmentsToUpload.map(digFile);
                    if (!infos.some(i => !i)) {
                        editTargets.delete(channelId);
                        enqueue(() => uploadPicked(channelId, entry.messageId, infos));
                        return Promise.resolve();
                    }
                }
            }
        } catch (e) {
            console.error("[AddAttachments] send hook error", e);
        }
        return orig(...args);
    }

    // forget the target if the edit ends and no redirected send follows (i.e. you cancelled the edit)
    function onEditStoreChange() {
        editTargets.forEach((entry, channelId) => {
            const ed = editingMessageFor(channelId);
            if (ed && ed.id === entry.messageId) {
                entry.endedAt = null;
            } else if (!entry.endedAt) {
                entry.endedAt = Date.now();
                setTimeout(() => {
                    if (editTargets.get(channelId) === entry) editTargets.delete(channelId);
                }, FORGET_AFTER_MS);
            }
        });
    }

    return {
        onLoad() {
            if (UP) Object.keys(UP).forEach(key => wrap(UP, key, onUploadCall));

            // installed shortly after load and guarded, so a problem here can never stop the plugin switching on
            startTimer = setTimeout(function () {
                startTimer = null;
                try {
                    const MA = findByProps("sendMessage", "editMessage");
                    if (MA) wrap(MA, "sendMessage", onSendMessage);
                    if (EditMessageStore && typeof EditMessageStore.addChangeListener === "function") {
                        EditMessageStore.addChangeListener(onEditStoreChange);
                        unpatches.push(() => EditMessageStore.removeChangeListener(onEditStoreChange));
                    }
                } catch (e) {
                    notify("Hook error: " + (e && e.message ? e.message : e));
                }
            }, 1500);
        },
        onUnload() {
            if (startTimer) { clearTimeout(startTimer); startTimer = null; }
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
