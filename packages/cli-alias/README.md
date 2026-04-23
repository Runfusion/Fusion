# runfusion.ai

Launch [Fusion](https://runfusion.ai) with a single npx:

```bash
npx runfusion.ai
```

That command boots the Fusion dashboard and AI engine on port 4040. Prints an `Open:` URL with a bearer token you can click to open in your browser.

## Subcommands

With no arguments, `runfusion.ai` defaults to `dashboard`. Any other subcommand is forwarded to the underlying [`fn` CLI](https://www.npmjs.com/package/@runfusion/fusion):

```bash
npx runfusion.ai                     # → fn dashboard
npx runfusion.ai task create "fix X" # → fn task create "fix X"
npx runfusion.ai --help              # → fn --help
```

## How it relates to `@runfusion/fusion`

This package is a ~1 KB alias. It declares `@runfusion/fusion` as a dependency and its `bin` delegates to the same entrypoint. Use whichever name reads better:

```bash
npx runfusion.ai
npx @runfusion/fusion dashboard
```

For persistent installs, prefer Homebrew or `npm install -g @runfusion/fusion`.

## Links

- **Website:** [runfusion.ai](https://runfusion.ai)
- **Source:** [github.com/Runfusion/Fusion](https://github.com/Runfusion/Fusion)
- **Main package:** [@runfusion/fusion](https://www.npmjs.com/package/@runfusion/fusion)

## License

MIT
