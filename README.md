# AddAttachments

A [Revenge](https://github.com/revenge-mod) (Classic) plugin for Discord mobile that lets you **add photos to a message you already sent**.

Pick photos in the attachment tray while editing one of your own messages, press the send arrow, and the photos are added to the original message instead of being sent as a new one.

## Usage

1. Long-press one of your own messages and tap **Edit**.
2. Open the attachment tray and pick one or more photos. They show up as chips in the draft, as usual.
3. Press the **send arrow**. The photos are uploaded and attached to the message you were editing. No new message is sent.

If you cancel the edit with the **X** instead, nothing is attached.

You can change the message text and add photos in the same edit.

## Install

In Revenge, go to **Plugins -> Install** and paste:

```
https://dxckie-cell.github.io/Add-Attachments/
```

(Keep the trailing slash.) When updating, remove the old entry and install again rather than updating over it.

## Limits

- Only your own messages can be extended. Voice messages and system messages are skipped.
- A message can hold at most 10 attachments in total. If the new photos would go over that, you get a popup and nothing is uploaded.
- Normal messages and normal photo sends are left alone.
- If you pick a photo while editing, cancel the edit, and then send that same draft as a normal message within about 20 seconds, the plugin treats it as the edit's send. Waiting longer, or removing the photo chip first, avoids this.

When everything works the plugin is silent. Errors (for example a failed upload) show up as a popup with the reason.

## How it works

Discord's attachment tray normally puts photos into the channel's message draft, so pressing send posts them as a new message. This plugin:

1. Notes which message you are editing when a photo is added to the draft.
2. Waits for Discord's send call that follows the edit, takes the photos from it, and cancels that new-message send.
3. Uploads the photos with Discord's attachment upload API and patches them onto the original message, keeping its existing attachments.

If the edit ends and no send follows within about 25 seconds, the plugin forgets the target.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | The plugin. Plain JavaScript, no build step. |
| `manifest.json` | Plugin metadata. `hash` is the SHA-256 of `index.js`. |

If you edit `index.js`, update the hash in `manifest.json` or Revenge will refuse to install it:

```
sha256sum index.js
```

Upload both files to the repo together, then wait for the GitHub Pages deploy to finish before reinstalling.

## Credits

This is a port of the **AddAttachments** plugin by **Lumap** from [Vencord](https://github.com/Vendicated/Vencord) / [Equicord](https://github.com/Equicord/Equicord) to Revenge mobile. The upload flow (create attachment slots, upload the files, patch the message) comes from the original. Everything that interacts with the mobile app (the tray, the edit flow, the send hook) is new.

Licensed under **GPL-3.0-or-later**, the same license as the original.
