# Internal — what this repo is

Private video-generation bridge. Owner: `DylanNgo1808/flow-bridge`. Visibility: **private**.

## This is

A local Python agent + unpacked Chrome extension that talks to Google Flow for the operator’s own test account. Used when we need generated clips (refs → scene stills → 8s Veo clips → concat).

## This is not

A public product. Do not publish the extension or file a Chrome Web Store listing.

Upstream source: [crisng95/flowkit](https://github.com/crisng95/flowkit) (MIT). This tree is a private copy.

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
