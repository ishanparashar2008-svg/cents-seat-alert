# CEnT-S seat monitor

Checks the [CISIA CEnT-S calendar](https://testcisia.it/calendario.php?tolc=cents&l=gb&lingua=inglese) every ~5 minutes on GitHub Actions and pushes alerts to your phone through [ntfy](https://ntfy.sh). Your PC can be off.

| Alert | Priority | When |
|---|---|---|
| 🚨 CEnT@HOME SEATS OPEN — BOOK NOW | urgent | an @HOME session shows available seats (repeats every 30 min while open) |
| New CEnT@HOME session listed | high | a new @HOME date appears, even if it is already full |
| New CEnT@UNI session listed | low | a new in-person date appears |
| Daily check-in | low | once a day around 9 AM IST, so you know it's alive |
| Cannot read the calendar | normal | 3 checks in a row failed |

## Setup
1. Install the **ntfy** app (Android / iOS) and subscribe to your topic name.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**: name `NTFY_TOPIC`, value = the same topic name.
3. **Actions** tab → enable workflows → *CEnT-S seat monitor* → **Run workflow** once. You should get "monitor is set up ✅".

To pause it: Actions → CEnT-S seat monitor → ⋯ → Disable workflow.

Note: GitHub can delay scheduled runs, and it switches off scheduled workflows in repos with no activity for 60 days. The daily state update keeps this one active.
