# Prompter

A teleprompter and 9:16 video recorder that runs in Safari on iPhone. You record one section at a time with your script scrolling near the lens. The app then trims the silences, stitches the sections into one video and sends it to Google Drive or your camera roll.

## Open it on your iPhone

1. Open the app's address in **Safari**.
2. Tap the Share button, then **Add to Home Screen**. From then on, open it from the home screen icon.
3. Choose a passcode. The app shows a **setup code**. Send that code to Claude in the project chat, and Claude will lock your scripts to it.
4. When it asks, allow the camera and microphone.

## How recording works

- **Scripts:** Claude adds scripts to `scripts.enc.json`. It's locked with your setup code, so only your phone can read it. You can also type a script on the phone with **New**. A blank line starts a new section.
- **Mic:** a small mic button on the recording screen shows a live level. Tap it (or ⚙︎) to see which mic is in use, switch mics, test voice-following, and set the script height.
- **Scrolling:** *Follow voice* moves the script to the words you're saying. *Talk scroll* scrolls only while you're talking. *Steady* scrolls at a fixed speed. Drag the text to move it by hand.
- **Scripts page:** filter by status at the top; the trash button deletes a script (with a confirm). Claude's scripts stay hidden unless Claude changes them.
- **Recording:** Record starts right away; tap it again to stop. The take is kept and the next section comes up with the camera still on; a Redo button shows for a few seconds. ⟲ while recording restarts the take. The strip at the top shows each section: tap one to re-record it. Tap "X of Y" → Re-record all to start over. After the last section the finish screen plays the whole video; tap a section there to redo it, then Save video.
- **Finish:** trim silences (Gentle to Tight), preview, then **Keep for later**, **OK, send to Google Drive** or **Save to camera roll now**.
- **Finished videos:** kept videos wait on the Scripts page. **Save all to camera roll** saves them in one go (choose Save Videos), then **Clear saved** frees up space.

## Google Drive setup (one time, about 10 minutes)

Until this is done, the app makes the video and you save it to your camera roll.

1. Go to <https://console.cloud.google.com> and sign in with the Google account whose Drive you want to use.
2. Create a project (any name, e.g. "Prompter").
3. Open **APIs & Services → Library**, search for **Google Drive API** and tap **Enable**.
4. Open **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**). Choose **External**, name the app "Prompter", and add your email where it asks. Under **Audience**, tap **Publish app** so your sign-in doesn't expire every 7 days. The app only asks for access to files it creates, so Google doesn't need to review it.
5. Open **Clients → Create client** and choose **Web application**. Under **Authorized JavaScript origins**, add `https://salvatorecommisso.github.io`.
6. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) and send it to Claude. Claude puts it in `config.js`.

Videos go into a **Teleprompter Recordings** folder in your Drive.

## For Claude: adding scripts

Keep the plain script list outside this repository (it's private). It's a JSON array of `{ "id", "title", "body" }`. Then run:

```
node tools/encrypt-scripts.mjs /path/to/scripts.json
```

That reads the phone's public setup code from `setup-code.txt` and writes `scripts.enc.json`. Commit only those two files. The setup code can lock scripts but not unlock them.
