# Third-party notices

`canlii-legislation.tsv` contains legislation identifiers, titles, database identifiers, and document types derived from a local CanLII metadata snapshot. It contains no legislative text. CanLII is the source: <https://www.canlii.org/>.

`legal-structure.wasm` contains the `legal-structure` parser from <https://github.com/eliziff/legal-structure-parser>, used under the MIT License.

```text
MIT License

Copyright (c) 2026 legal-structure contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`vendor/rerank/` (fetched and SHA-256 verified by `npm run fetch:rerank`, not committed) contains
`onnxruntime-web` 1.30.0 (<https://github.com/microsoft/onnxruntime>, MIT License, Copyright (c)
Microsoft Corporation) and the int8 ONNX export
(<https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2>) of `cross-encoder/ms-marco-MiniLM-L6-v2`
(<https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2>, Apache License 2.0).
