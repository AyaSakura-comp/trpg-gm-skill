# Pi Agent installation and update behavior

This project is a Pi package containing both the `trpg-gm` Skill and the TRPG GM Guard Extension. How an update becomes active depends on the package source shown by `pi list`.

## Local-path package

Install a checkout once:

```bash
git clone git@github.com:AyaSakura-comp/trpg-gm-skill.git
cd trpg-gm-skill
npm test
pi install "$PWD"
pi list
```

Pi stores a reference to the checkout instead of copying it. Later updates only require updating and testing that same checkout:

```bash
git -C /path/to/trpg-gm-skill pull --ff-only
cd /path/to/trpg-gm-skill
npm test
git diff --check
```

There is no separate build, package upload, or deployment step. Do not repeatedly run `pi install`, recreate symlinks, or copy the Skill into another directory.

Activation depends on the host:

- **Pi TUI or another long-lived Pi process:** start a new process or run `/reload` so it reloads the Skill and Extension.
- **Piweb/Piscord gateway that spawns a fresh Pi process per message:** the next message reads the updated checkout automatically. The gateway services do not need to restart.
- **A host that keeps one Pi process alive:** reload or restart only that process; do not restart unrelated services.

Verify the resolved package and, where applicable, gateway health:

```bash
pi list
systemctl --user is-active pi-discord-gateway.service piweb-worker.service
```

A new TRPG turn should include the current `TRPG GM Guard` checklist. For v0.10.0 or later, item 15 requires novel-like world narration and finalization requires `narrativeDetailChecked=true`.

## Git-URL package

A package installed from a Git URL is maintained in Pi's package storage rather than in your working checkout. Update it explicitly:

```bash
pi update --extension https://github.com/AyaSakura-comp/trpg-gm-skill
# Or update all installed packages:
pi update --extensions
```

Then reload or start a new Pi process. A source pinned to a tag or commit will not move until a newer ref is installed explicitly.

## When remounting is necessary

Run `pi install /absolute/path/to/trpg-gm-skill` again only when:

- this machine has never installed the package;
- the checkout moved to another absolute path;
- `pi list` no longer resolves the expected checkout; or
- the package entry was removed or corrupted.

A source-code update at the same local path does **not** require remounting or service deployment.

## Troubleshooting checklist

1. Run `npm test` and `git diff --check` in the checkout.
2. Confirm `pi list` resolves the intended absolute path or Git source.
3. For a long-lived session, run `/reload` or start a new Pi process.
4. For Piweb/Piscord, send a new message and inspect the injected Guard checklist.
5. Restart a gateway only if the gateway itself is unhealthy; do not use restart as a package-update step.
