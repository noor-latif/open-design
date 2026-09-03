# Landing Page — Design Brief (Figma)

> For Figma designer (junior-friendly). No code needed. This is what to design in Figma. The builders will make it work later.

## What is this page?

One simple website that explains AirBoot in 5 seconds.

AirBoot = a small tool that adds Wi-Fi to Ventoy USB sticks. Ventoy is the popular tool that lets you put many system images on one USB. AirBoot lets you download those images over Wi-Fi, with no cable.

**Goal of the page:** Make a visitor understand this in 5 seconds and click the copy button for setup.

**Who visits:** People who already know Ventoy, but hate needing an Ethernet cable. They are technical but want clear steps.

**Tone:** Short, direct, friendly. Like Ventoy's site but cleaner. No emojis.

---

## Page idea

Design one long page you scroll down. Use simple sections (think Frames in Figma, stacked top to bottom).

### 1. Top section (Hero)
- Big headline: **Like netboot.xyz, but works over Wi-Fi and boots via Ventoy.**
- Smaller text under it: **A tiny tool that fetches system images over Wi-Fi straight to your Ventoy USB — no cable, no second computer.**
- Picture: Simple diagram of a USB stick split in two parts: Part 1 = files (where images go), Part 2 = boot part. Add a small Wi-Fi icon. Keep it very simple, not technical.
- Two big buttons: **Copy for Mac / Linux** and **Copy for Windows** — when clicked they copy a setup command. Show the command text nearby in a box so people can see what they will copy.

### 2. How it works (3 steps)
Show 3 steps as 3 cards or a row:

**Step 1 — Make Ventoy USB (once):** Small icon + text "Download Ventoy and make your USB." Link to ventoy.net.

**Step 2 — Add AirBoot:** Show the two copy buttons again with the commands:
- Mac/Linux: `curl -fsSL https://airboot.sh/install.sh | bash`
- Windows: `irm https://airboot.sh/install.ps1 | iex`
Add note: this opens a small local app at `http://localhost:8080`. Or they can do it by hand: copy `airboot.iso` to the USB.

**Step 3 — Boot and download:** Text: "Restart, pick AirBoot in Ventoy, pick Wi-Fi, pick an image (like Debian 12, 700MB), reboot, pick your new image."

### 3. Why Wi-Fi now?
Two small columns comparing:
- Left: netboot.xyz (needs cable)
- Middle: Ventoy (needs image already on USB)
- Right: AirBoot (Wi-Fi, downloads on the spot)
Keep text very short. One sentence each.

### 4. Images you can download
A small table with a few examples:
- Debian 12 (700MB)
- Omarchy 4.0.2 (5.8GB)
- Ubuntu 24.04, etc.
Just 7 rows. Link to see full list.

### 5. Trust / Details
Small section with 4 short points (use icons):
- Fixes dirty USB if you pulled it out badly
- Checks download is real (not a hotel login page)
- Handles Wi-Fi names with spaces
- Notes about Secure Boot

### 6. Questions (FAQ)
4 short questions:
- Does this replace Ventoy? No, it sits on top.
- Do you change how booting works? No, Ventoy still boots.
- Does it start by itself? No, you pick it by hand (avoids loops).
- Where is airboot.iso? Built on your computer or from Releases.

### 7. Bottom (Footer)
Small footer with links: GitHub, plan, and note that Ventoy and netboot.xyz are separate projects.

---

## How to design it

- Make one Figma file with one big Frame for desktop (1440px wide), and one for phone (375px). Design desktop first, then phone.
- Use simple Components for buttons, the command box, and the 3 step cards so you can reuse them.
- Keep colors simple. Try to use OKLCH colors if you know them, or just pick a clean light/dark palette that passes contrast. Builders will polish it.
- Aim for fast and clean: little JavaScript, big readable text, lots of white space. Try for under 50KB of code later (not your job, but keep design light).
- Make the copy buttons big and easy to tap. Show a tiny "Copied!" message after click.
- Add one real photo or GIF at the top later: a laptop showing AirBoot picking Wi-Fi. For now use a placeholder box.

## What to hand over

- Figma file with Desktop and Mobile Frames, all text as real text (not images)
- Components: Button, Command Box, Step Card, Table Row, FAQ item
- Export the USB diagram as SVG and a hero image as PNG
- No code needed — just the Figma file. Builders will build it with a light tool called Lume (you don't need to know this).
