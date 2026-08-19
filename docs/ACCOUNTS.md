# Accounts — test vs main

This bridge rides the Google session in Chrome. Mixing accounts is how the main Flow quota and the main Google login get burned.

## Rule

| Chrome | Google account | Allowed |
|---|---|---|
| Isolated profile from `scripts/chrome-test-profile.sh` | **Test** Flow account | Yes — all gen, all extension load |
| Everyday Chrome (mail, Drive, main Flow) | Main account | **No** — do not load this extension here |

The profile directory is `$HOME/.flow-bridge/chrome-test-profile`. It is outside the repo. Do not copy it into git.

## First-time test profile

1. Run `./scripts/chrome-test-profile.sh`. A separate Chrome window opens. The dock icon looks like Chrome; the profile is not your daily one.
2. In **that** window: `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
3. Still in that window: open `https://labs.google/fx/tools/flow` and sign in with the **test** account only.
4. Confirm the account chip in the Flow UI is the test account before generating anything.
5. Start the agent (`python -m agent.main`) and `curl http://127.0.0.1:8100/health`.

If you ever see the main account avatar on that Flow tab, quit that Chrome, do not generate, and re-check the profile path.

## What not to do

- Do not “just quickly” load the unpacked extension in everyday Chrome.
- Do not sign the test profile into the main Google account “to check credits.”
- Do not reuse cookies, `ya29.*` tokens, or a copied `Local Storage` from the main profile.
- Do not run two Flow tabs (main + test) against the same agent. One profile, one account, one agent.

## Production later

When a real job must use the main (or a paid) Flow account:

1. Stop. Do not flip the test profile over to the main login.
2. Create a **second** isolated profile (`FLOW_BRIDGE_CHROME_PROFILE=$HOME/.flow-bridge/chrome-prod-profile ./scripts/chrome-test-profile.sh`) or wait for a dedicated prod runbook.
3. Confirm credits on `GET /api/flow/credits` before submitting a batch.

Until that runbook exists, treat this repo as **test-account only**.
