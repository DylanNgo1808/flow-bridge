# Internal — what this repo is

Private video-generation bridge. Owner: `DylanNgo1808/flow-bridge`. Visibility: **private**.

## This is

A local Python agent + unpacked Chrome extension that talks to Google Flow for the operator’s own test account. Used when we need generated clips (refs → scene stills → 8s Veo clips → concat).

## This is not

| Repo | Job |
|---|---|
| `gavana-content-pipeline` | Top-funnel shorts from **official** campaign files. No generated remakes. |
| `joy-video-content` | D2C brand-story factory. Not this. |
| Upstream [crisng95/flowkit](https://github.com/crisng95/flowkit) | Public MIT source this tree was copied from. |

Do not merge this into Gavana. Do not publish the extension. Do not file a Chrome Web Store listing.

## License

MIT, copyright retained from upstream (`tuannguyenhoangit-droid` / Flow Kit). Keep `LICENSE` when copying files out.

## Secrets

Never commit:

- `.env`
- `youtube/channels/*/token.json` and `client_secrets.json`
- Chrome profile dir (`~/.flow-bridge/`)
- Captured `ya29.*` tokens
- Any account password

`git push` is allowed for code. It is not allowed for sessions.
