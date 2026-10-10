# Browser demo

The live demo at https://logdig.soleone.xyz: the real CLI in a WebContainers sandbox, with ten synthetic Pi sessions (`seed.js`, `home/.demo/sessions.json`) and a stand-in for Pi that returns canned summaries (`home/.demo/pi.mjs`), so nothing is sent to a model.

Build it with the browser terminal recipe from [showcase](https://github.com/Soleone/showcase), checked out next to this repo:

```sh
node ../showcase/recipes/browser-terminal/build.js demo/browser --out dist/browser --serve
```

Then deploy `dist/browser` as a static site (it includes the `vercel.json` with the COOP/COEP headers the sandbox needs).
