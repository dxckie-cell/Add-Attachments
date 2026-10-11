/*
 * Ported from Vencord/Equicord "AddAttachments" by Lumap
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByProps, findByStoreName } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { findInReactTree } from "@vendetta/utils";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
const { ActionSheetRow } = findByProps("ActionSheetRow");
const RestAPI = findByProps("getAPIBaseURL", "get", "post", "patch");
const UserStore = findByStoreName("UserStore");
const MessageStore = findByStoreName("MessageStore");

const MAX_ATTACHMENTS = 10;
const VOICE_MESSAGE_FLAG = 1 << 13;

type Picked = { uri: string; name: string };

async function pickFiles(): Promise<Picked[]> {
    // react-native-document-picker style
    const rndp = findByProps("pick", "types");
    if (rndp?.pick) {
        const res = await rndp.pick({ allowMultiSelection: true, copyTo: "cachesDirectory" });
        return res.map((r: any) => ({ uri: r.fileCopyUri ?? r.uri, name: r.name }));
    }

    // expo-document-picker style
    const expo = findByProps("getDocumentAsync");
    if (expo?.getDocumentAsync) {
        const res = await expo.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (res.canceled) return [];
        return res.assets.map((a: any) => ({ uri: a.uri, name: a.name }));
    }

    throw new Error("No file picker found");
}

function canAddAttachments(msg: any) {
    return (
        [0, 19].includes(msg.type) && // DEFAULT, REPLY
        !((msg.flags ?? 0) & VOICE_MESSAGE_FLAG) &&
        msg.author?.id === UserStore.getCurrentUser().id &&
        (msg.attachments?.length ?? 0) < MAX_ATTACHMENTS
    );
}

async function addAttachments(channelId: string, messageId: string) {
    const existing = MessageStore.getMessage(channelId, messageId)?.attachments ?? [];
    const remaining = MAX_ATTACHMENTS - existing.length;
    if (remaining <= 0) return showToast("You cannot add more attachments to this message.");

    let picked: Picked[];
    try {
        picked = await pickFiles();
    } catch (e: any) {
        if (e?.code === "DOCUMENT_PICKER_CANCELED") return;
        return showToast(`File picker failed: ${e?.message ?? e}`);
    }
    if (!picked.length) return;

    if (picked.length > remaining)
        return showToast(`You can only add ${remaining} more attachment${remaining === 1 ? "" : "s"} to this message.`);

    try {
        showToast("Uploading, this can take a while...", getAssetIDByName("ic_clock"));

        const blobs = await Promise.all(picked.map(async p => (await fetch(p.uri)).blob()));

        const { body: { attachments } } = await RestAPI.post({
            url: `/channels/${channelId}/attachments`,
            body: {
                files: picked.map((p, i) => ({
                    filename: p.name,
                    file_size: blobs[i].size,
                    id: String(i),
                    is_clip: false
                }))
            }
        });

        const uploaded = await Promise.all(
            attachments.map((a: any, i: number) =>
                fetch(a.upload_url, { method: "PUT", body: blobs[i] }).then(res => {
                    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
                    return { id: a.id, uploaded_filename: a.upload_filename, filename: picked[i].name };
                })
            )
        );

        // re-read in case the message changed while uploading
        const msg = MessageStore.getMessage(channelId, messageId);
        await RestAPI.patch({
            url: `/channels/${channelId}/messages/${messageId}`,
            body: {
                attachments: [
                    ...(msg?.attachments ?? []).map((a: any) => ({ id: a.id, filename: a.filename })),
                    ...uploaded
                ]
            }
        });

        showToast(`${picked.length === 1 ? "Attachment" : "Attachments"} added successfully!`, getAssetIDByName("Check"));
    } catch (e: any) {
        console.error("[AddAttachments]", e);
        showToast(`Failed: ${e?.message ?? e}`);
    }
}

let unpatchSheet: () => void;

export default {
    onLoad() {
        unpatchSheet = before("openLazy", LazyActionSheet, ([component, key, props]) => {
            const message = props?.message;
            if (key !== "MessageLongPressActionSheet" || !message) return;
            if (!canAddAttachments(message)) return;

            component.then((instance: any) => {
                const unpatch = after("default", instance, (_, res) => {
                    React.useEffect(() => () => void unpatch(), []);

                    const rows = findInReactTree(res, (x: any) => Array.isArray(x) && x[0]?.type === ActionSheetRow);
                    if (!rows) return;

                    rows.push(
                        <ActionSheetRow
                            label="Add Attachments"
                            icon={<ActionSheetRow.Icon source={getAssetIDByName("ic_upload")} />}
                            onPress={() => {
                                LazyActionSheet.hideActionSheet();
                                addAttachments(message.channel_id, message.id);
                            }}
                        />
                    );
                });
            });
        });
    },
    onUnload() {
        unpatchSheet?.();
    }
};
