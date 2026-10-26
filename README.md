# Prompter

A teleprompter and 9:16 video recorder that runs in Safari on iPhone. You record one section at a time with your script scrolling near the lens. The app then trims the silences, stitches the sections into one video and sends it to Google Drive or your camera roll.

## Open it on your iPhone

1. Open the app's address in **Safari**.
2. Tap the Share button, then **Add to Home Screen**. From then on, open it from the home screen icon.
3. Choose a passcode. The app shows a **setup code**. Send that code to Claude in the project chat, and Claude will lock your scripts to it.
4. When it asks, allow the camera and microphone.

## How recording works

- **Scripts:** Claude adds scripts to `scripts.enc.json`. It's locked with your setup code, so only your phone can read it. You can also type a script on the phone with **New**. A blank line starts a new section.
- **Mic check:** this screen opens with each script. It shows which mic is in use and a live level bar, and lets you test voice-following.
- **Scrolling:** *Follow voice* moves the script to the words you're saying. *Talk scroll* scrolls only while you're talking. *Steady* scrolls at a fixed speed. Drag the text to move it by hand.
- **Recording:** Record starts right away, then Pause/Resume and Done. After each section you choose Keep or Retake. Recording a section again replaces the old take.
- **Finish:** trim silences (Gentle to Tight), preview, then **OK, send to Google Drive** or **Save to camera roll**.

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
