# Browser demo

The live demo at https://logdig.soleone.xyz: the real CLI in a WebContainers sandbox, with ten synthetic Pi sessions (`seed.js`, `home/.demo/sessions.json`) and a stand-in for Pi that returns canned summaries (`home/.demo/pi.mjs`), so nothing is sent to a model.

Build it with [showcase](https://github.com/Soleone/showcase)'s browser terminal, checked out next to this repo (or `npx @soleone/showcase terminal --serve` once it is on npm):

```sh
node ../showcase/bin/showcase.js terminal --serve
```

That builds `demo/browser` into `dist/browser` and serves it at http://127.0.0.1:4321. Then deploy `dist/browser` as a static site (it includes the `vercel.json` with the COOP/COEP headers the sandbox needs).
