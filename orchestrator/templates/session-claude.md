# Session: {{name}}

Isolated dev environment managed by [kon](https://github.com/catFurr/kon).

## Session Details
- **Name:** {{name}}
- **User:** {{username}}
- **Primary URL:** https://{{name}}.{{domain}}
- **Repos:** {{reposDir}}

## Repositories
{{repoList}}

## Services
{{serviceList}}

## Development Workflow

### Making Changes
1. Create a branch: `git checkout -b my-feature`
2. Make your changes
3. Test at https://{{name}}.{{domain}}
4. Commit and push: `git add . && git commit -m "description" && git push -u origin my-feature`

### Opening a Pull Request
Open a PR with the GitHub CLI:

```
gh pr create --title "My feature" --body "## Changes
- Description of changes

## Dev Server
Preview: https://{{name}}.{{domain}}
Session: {{name}}"
```

Always include the dev server URL (`https://{{name}}.{{domain}}`) in the PR description so reviewers can test live.

## Ports
Reserved ports for this session: {{portList}}
Use these when starting servers to avoid conflicts. Also available as `$KON_PORTS`.

## Rules
- Only use the allocated ports listed above
- Do not modify files outside {{home}}
- Do not access other users' home directories
- Always include the session dev server URL in PR descriptions
- AI must NEVER include itself as co-author in commits or anywhere else
- AI must NEVER add Co-Authored-By lines to commits
