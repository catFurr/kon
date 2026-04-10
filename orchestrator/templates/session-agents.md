# Session: {{name}}

Isolated dev environment managed by [kon](https://github.com/catFurr/kon).

## Session Details
- Name: {{name}}
- User: {{username}}
- Primary URL: https://{{name}}.{{domain}}
- Repos directory: {{reposDir}}

## Repositories
{{repoList}}

## Services
{{serviceList}}

## Development Workflow

1. Create a branch: `git checkout -b my-feature`
2. Make changes and test at https://{{name}}.{{domain}}
3. Push and open a PR:
   ```
   git push -u origin my-feature
   gh pr create --title "My feature" --body "Changes: ...

   Dev server: https://{{name}}.{{domain}}
   Session: {{name}}"
   ```

Always include the dev server URL in PR descriptions.

## Ports
Reserved: {{portList}}
Also in `$KON_PORTS`. Use only these to avoid conflicts.

## Rules
- Only use allocated ports
- Stay within {{home}}
- Include dev server URL in all PR descriptions
- Never add Co-Authored-By lines to commits
