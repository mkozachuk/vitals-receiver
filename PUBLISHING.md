# Publishing vitals as a new public repository

This repository is private, and **stays private**. Its history carries commits
authored with a personal address, so flipping its visibility would publish that
address. Publishing means creating a **new** public repository from **one
squashed commit** of the `oss/prepare` tree, authored with the GitHub noreply
address. Do not run `gh repo edit --visibility` on this one.

Everything below runs from a clone of this private repository, under node 22,
with `gh` logged in as the account that will own the new repository.

## 1. Pre-flight

```bash
git fetch origin
git switch oss/prepare && git status -sb      # clean, and level with origin/oss/prepare

# Identity sweep. Expect exactly ONE line: LICENSE:3, the copyright holder.
# (The [x] brackets keep this line from matching itself; the regex is unchanged.)
git grep -niIE "192\.16[8]|\.loca[l]\b|maksy[m]|kozachu[k]|/User[s]/[a-z]|@gmai[l]|herme[s]" \
  -- . ':!package-lock.json'

npm ci
npm run typecheck
npm test                                      # expect: fail 0, skipped 0
```

Stop here if the sweep shows anything else, or if a test fails or skips.

## 2. Build the single commit (nothing leaves the machine)

`git commit-tree` makes a parentless commit whose tree is, by construction,
exactly the tree of `oss/prepare` -- no re-adding of files, so nothing can be
dropped or picked up on the way. The author and committer are the account's
noreply address, derived from `gh` rather than typed.

```bash
REF=origin/oss/prepare
TREE=$(git rev-parse "$REF^{tree}")
GH_LOGIN=$(gh api user --jq .login)
NOREPLY=$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')

COMMIT=$(GIT_AUTHOR_NAME="$GH_LOGIN" GIT_AUTHOR_EMAIL="$NOREPLY" \
         GIT_COMMITTER_NAME="$GH_LOGIN" GIT_COMMITTER_EMAIL="$NOREPLY" \
         git commit-tree "$TREE" -m "vitals: first public release")
```

## 3. Check it before anything is pushed

```bash
git rev-parse "$REF"                                     # the reviewed head, for the record
test "$(git rev-parse "$COMMIT^{tree}")" = "$TREE" && echo "tree identical: $TREE"
test "$(git cat-file -p "$COMMIT" | grep -c '^parent ')" = 0 && echo "no parent"
git log -1 --format='author:    %an <%ae>%ncommitter: %cn <%ce>' "$COMMIT"
case "$(git log -1 --format='%ae %ce' "$COMMIT")" in
  *users.noreply.github.com*users.noreply.github.com) echo "noreply: ok" ;;
  *) echo "STOP: author or committer is not a noreply address" ;;
esac
```

All three checks must print their line: `tree identical`, `no parent`,
`noreply: ok`.

## 4. Create the new repository and push that one commit

Pick a name: `vitals` is taken by this private repository.

```bash
NEW_REPO=vitals-receiver
DEST="https://github.com/$GH_LOGIN/$NEW_REPO.git"

gh repo create "$GH_LOGIN/$NEW_REPO" --public \
  --description "Self-hosted receiver and dashboard for Apple Health exports"
git push "$DEST" "$COMMIT:refs/heads/main"
```

Only `$COMMIT` is pushed: no branch of this repository, no tag, no history.
CI (`.github/workflows/ci.yml`) runs on that first push; check it is green.

## Dry run

Steps 1-3 are side-effect free. To rehearse step 4 without GitHub, replace it
with a local bare repository and inspect what arrived:

```bash
DEST=$(mktemp -d)/vitals-public.git && git init -q --bare "$DEST"
git push "$DEST" "$COMMIT:refs/heads/main"
git -C "$DEST" rev-list --count main                     # 1
git -C "$DEST" rev-parse 'main^{tree}'                   # = $TREE
git -C "$DEST" log -1 --format='%an <%ae> | %cn <%ce>' main
```
