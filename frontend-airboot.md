# App UI — Design Brief (Figma)

> For Figma designer (junior-friendly). This is the small local app that opens at http://localhost:8080. It runs only on the person's own computer (not on the internet). Keep it super simple, like a 3-step setup.

## What is this app?

A tiny window that helps people who are scared of the black terminal. It does 3 things:
1. Pick which USB stick is the Ventoy one
2. Copy AirBoot onto it
3. Add Wi-Fi so it connects by itself next time

No internet app — everything happens on their computer. Wi-Fi passwords never leave the computer.

**Who uses it:** Windows and Mac people who don't like typing commands. They just want to click.

**Look:** Like Balena Etcher (if you know it) — big, clear, 3 steps, one step at a time. Next button at bottom.

---

## Screens to design

Make 3 screens (Frames in Figma). Show them as a flow: Screen 1 → Screen 2 → Screen 3. Also design a small empty/error version for Screen 1.

### Screen 1 — Pick USB
- Title: **Pick your Ventoy USB**
- List of USB drives (like a simple list). Each row shows:
  - Name (e.g., "Ventoy — 32GB")
  - Size
  - Where it is mounted (e.g., E: on Windows, /Volumes/Ventoy on Mac)
  - A green badge if Ventoy is found, or dim if not
- If nothing found: big empty state with text "No Ventoy found" and a button "Get Ventoy" that links to ventoy.net. No file picker window — the app already sees the USBs.
- Bottom: blue **Next** button (disabled until they pick one)

### Screen 2 — Put AirBoot on USB
- Title: **Put AirBoot on USB**
- Big button: **Copy AirBoot**
- When they click, show a progress bar (0% → 100%) and text like "Copying…". This is just copying a file, not wiping the drive (unless they click advanced).
- Small check before copying: if the file is wrong, show red error "Not a good file" and stop.
- Advanced tiny link below: "Wipe and make new Ventoy USB" — this is dangerous, show a warning popup: "This will delete everything on this USB. Continue?" with Cancel / Yes buttons.

### Screen 3 — Add Wi-Fi
- Title: **Add Wi-Fi (optional)**
- Text: "Add your Wi-Fi so AirBoot connects by itself. You can add more than one, like on a phone. First one is tried first."
- Country picker: simple dropdown, default = SE (Sweden)
- List of Wi-Fi you already added (empty at first). Each row: Wi-Fi name, lock icon if it has password, or open icon if not. Drag handle on the side to change order (first = most important).
- Form to add one: 
  - Field: Wi-Fi name (keep spaces, e.g., "Hotel Lobby")
  - Checkbox: Open network (no password) — when checked, hide password field
  - Field: Password (dots) — show eye icon to see it
  - Button: **Add**
- Bottom: big **Save to USB** button. After saving, show green "Saved!" and note where it saved.

---

## Small details for all screens

- Keep the same header on all screens: small AirBoot logo + title, and the 3 dots showing which step they are on (step 1 highlighted, etc.).
- If the app is not running, show a screen with the two commands to start it:
  - Mac/Linux command box
  - Windows command box
  Both with Copy buttons.
- Bottom bar always shows: Back / Next. Keep it simple.
- Password field: never show the real password in the list, just dots. File on USB will be locked so only the owner can read it — you can add a small note "Stored on USB, like Pi Imager".
- Empty states: design what it looks like when no Wi-Fi added yet (show form directly).

## What is NOT in this app (for later)

- No need to design a big catalog browser now — keep Wi-Fi only.
- No auto-start tricks, no wiping unless they click advanced.

---

## How to design it

- Make one Figma file with these Frames: Screen 1, Screen 1 Empty, Screen 2, Screen 2 Loading, Screen 3, Screen 3 Empty, Warning Popup. Use 960px wide frame (small desktop window), plus a 375px phone check just in case.
- Use Components for: USB row, Wi-Fi row, Button, Input field, Dropdown, Progress bar, Popup. This keeps it tidy (you can make one Component and reuse it).
- Use simple layers and name them (e.g., Button / Primary, Input / WiFi name). Keep text real, not outlines.
- Pick a clean font (like Inter) and keep sizes big for clicking. Make sure colors pass contrast (dark text on light background).
- Hand over the Figma file only — no code. Builders will make it with a small Python tool (you don't need to know this).

## What to hand over

- Figma file with all screens as Frames
- Clickable prototype linking Next → next screen (in Figma, use Prototype mode)
- Components listed above
- Notes on the side saying which button does what
