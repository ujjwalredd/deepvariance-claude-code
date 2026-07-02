# Releasing

deepvariance ships two ways: the `curl | bash` installer (pulls files from a
git ref) and the npm package. Both are cut from the same tag.

## 1. Pre-flight

```
npm test            # unit + integration + streaming + launcher suites
node --check lib/proxy.js
bash -n bin/deepvariance install.sh test/launcher.test.sh
```

Bump the version in three places (keep them identical):

- `package.json` → `version`
- `bin/deepvariance` → `VERSION`
- `install.sh` → `VERSION`

Update the README pin example if present.

## 2. Tag and push

```
git commit -am "release vX.Y.Z: <summary>"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main vX.Y.Z
```

The `curl | bash` installer resolves the ref to a commit SHA, so the installer
path is live as soon as the tag is pushed.

## 3. Publish to npm

`prepublishOnly` runs the full test suite as the gate, so a broken build cannot
be published.

```
npm publish --access public      # first publish of a public package
# subsequent: npm publish
```

Verify the tarball contents before publishing if unsure:

```
npm pack --dry-run               # lists exactly what ships (files whitelist)
```

Only `bin/`, `lib/`, `config.default.json`, `README.md`, and `LICENSE` are
included (see the `files` field). Tests and CI config are not shipped.

## 4. Smoke the published package

```
npx deepvariance-claude-code@X.Y.Z version
```
