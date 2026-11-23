# Dependency licenses

Run `npm ci` followed by `npm run licenses` to verify the installed package versions and licenses against the lockfile and allowlist.

| Package | Locked version | License |
| --- | --- | --- |
| TypeScript | 5.9.3 | Apache-2.0 |
| @types/node | 24.10.1 | MIT |
| undici-types | 7.16.0 | MIT |
| USearch | 2.26.5 | Apache-2.0 |
| bindings | 1.5.0 | MIT |
| file-uri-to-path | 1.0.0 | MIT |
| node-addon-api | 8.9.2 | MIT |
| node-gyp-build | 4.8.4 | MIT |

The Node type definitions depend on `undici-types`. TypeScript and `undici-types` have no package dependencies in the lockfile.

USearch uses `bindings`, `node-addon-api`, and `node-gyp-build`. The `bindings` package uses `file-uri-to-path`, which has no further dependencies. The Windows x64 install uses the package's prebuilt Node addon and bundled Apache-2.0 NumKong code. The native addon imports the Windows system library `KERNEL32.dll`. The package includes the USearch and NumKong license files. [USearch 2.26.5 native build](https://github.com/unum-cloud/USearch/blob/v2.26.5/binding.gyp) · [USearch license](https://github.com/unum-cloud/USearch/blob/v2.26.5/LICENSE)

The launcher uses the user's installed Node.js 24 and Python 3.12. Their upstream notices cover their bundled components. [Node.js license and notices](https://github.com/nodejs/node/blob/v24.22.3/LICENSE), [Python 3.12 license](https://docs.python.org/3.12/license.html)

The browser ships the existing [markdown-it bundle and transitive licenses](../public/assets/vendor/markdown-it-LICENSES.txt) and the approved [Inter](../public/assets/Inter-LICENSE.txt) and [Noto Sans](../public/assets/NotoSans-LICENSE.txt) fonts under the SIL Open Font License 1.1.
