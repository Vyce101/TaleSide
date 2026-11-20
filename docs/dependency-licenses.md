# Dependency licenses

Run `npm ci` followed by `npm run licenses` to verify the installed package versions and licenses against the lockfile and allowlist.

| Package | Locked version | License |
| --- | --- | --- |
| TypeScript | 5.9.3 | Apache-2.0 |
| @types/node | 24.10.1 | MIT |
| undici-types | 7.16.0 | MIT |

The Node type definitions depend on `undici-types`. TypeScript and `undici-types` have no package dependencies in the lockfile.

The launcher uses the user's installed Node.js 24 and Python 3.12. Their upstream notices cover their bundled components. [Node.js license and notices](https://github.com/nodejs/node/blob/v24.22.3/LICENSE), [Python 3.12 license](https://docs.python.org/3.12/license.html)

The browser ships the existing [markdown-it bundle and transitive licenses](../public/assets/vendor/markdown-it-LICENSES.txt) and the approved [Inter](../public/assets/Inter-LICENSE.txt) and [Noto Sans](../public/assets/NotoSans-LICENSE.txt) fonts under the SIL Open Font License 1.1.
