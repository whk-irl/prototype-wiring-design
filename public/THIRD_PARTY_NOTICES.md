# Third-party notices

Wiring Design is licensed under the Apache License 2.0. The built app also contains the software below, each under its own licence, and 3D models of parts under theirs (see [parts/NOTICE.md](parts/NOTICE.md)).

## Software in the built app

| Package | Version | Licence | Source |
|---|---|---|---|
| meshoptimizer | 1.3.0 | MIT | https://github.com/zeux/meshoptimizer |
| occt-import-js | 0.0.23 | LGPL-2.1 | https://github.com/kovacsv/occt-import-js |
| react | 19.3.1 | MIT | https://github.com/react/react |
| react-dom | 19.3.1 | MIT | https://github.com/react/react |
| scheduler | 0.28.0 | MIT | https://github.com/react/react |
| three | 0.187.0 | MIT | https://github.com/mrdoob/three.js |
| three-mesh-bvh | 0.9.18 | MIT | https://github.com/gkjohnson/three-mesh-bvh |
| urdf-loader | 0.13.1 | Apache-2.0 | https://github.com/gkjohnson/urdf-loaders |
| yaml | 2.9.1 | ISC | https://github.com/eemeli/yaml |
| zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| zustand | 5.1.0 | MIT | https://github.com/pmndrs/zustand |

Versions are those in `package-lock.json` when this file was written.

## occt-import-js and Open CASCADE Technology (LGPL-2.1)

STEP and IGES files are read by `occt-import-js`, a WebAssembly build of Open CASCADE Technology. Both are licensed under the GNU Lesser General Public License, version 2.1, Open CASCADE Technology with its additional exception.

- They are used unmodified, as a separate module: the build keeps them in their own files (`assets/occt-import-js-*.js` and `assets/occt-import-js-*.wasm`), which can be replaced with a rebuilt version of the library.
- Their source code: https://github.com/kovacsv/occt-import-js (which names the Open CASCADE Technology version it builds).
- Their licence texts, as distributed with the package: [licenses/occt-import-js.txt](licenses/occt-import-js.txt) and [licenses/open-cascade.txt](licenses/open-cascade.txt).

## The other packages

The MIT, ISC and Apache-2.0 packages above are used unmodified. Their licence texts are in each package (`node_modules/<package>/LICENSE` after `npm install`) and at the source addresses in the table.
